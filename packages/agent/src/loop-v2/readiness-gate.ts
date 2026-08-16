import type { CandidateReadinessGapCodeV2 } from "./candidate-certification.js";
import { sha256Canonical } from "./canonical.js";
import type { RepairRequirementV1 } from "./control-reducer.js";
import type { LoopV2LiveCandidateAssessmentV1 } from "./live-candidate.js";
import type { VerificationRecordV2, WorkingDecisionStateV2 } from "./schema.js";

export const LOOP_V2_READINESS_FEEDBACK_LIMIT = 1 as const;

export interface LoopV2ReadinessFeedbackStateV1 {
  readonly key: string;
  readonly nudges: number;
}

export type LoopV2ReadinessGateDecisionV1 =
  | { readonly type: "ready" }
  | {
      readonly type: "feedback";
      readonly key: string;
      readonly message: string;
      readonly requirement?: RepairRequirementV1;
    }
  | {
      readonly type: "incomplete";
      readonly key: string;
      readonly message: string;
      readonly reason: "no_turn_budget" | "feedback_exhausted";
      readonly requirement?: RepairRequirementV1;
    };

export function evaluateLoopV2ReadinessGateV1(input: {
  readonly assessment: LoopV2LiveCandidateAssessmentV1;
  readonly progressKey: string;
  readonly verificationRecords?: readonly VerificationRecordV2[];
  readonly priorKey?: string;
  readonly priorNudges?: number;
  readonly noRoomForAnotherTurn: boolean;
}): LoopV2ReadinessGateDecisionV1 {
  const { readiness } = input.assessment;
  if (readiness.readyForSemanticReview) {
    if (readiness.disposition !== "ready_for_review" || readiness.gaps.length) {
      throw new Error(
        "Loop v2 readiness assessment is internally inconsistent",
      );
    }
    return { type: "ready" };
  }
  if (readiness.disposition === "ready_for_review") {
    throw new Error("Loop v2 readiness assessment is internally inconsistent");
  }

  const normalizedGaps = readiness.gaps
    .map((gap) => ({
      code: gap.code,
      message: gap.message.trim(),
      criterionId: gap.criterionId ?? "",
      riskId: gap.riskId ?? "",
    }))
    .sort(
      (left, right) =>
        left.code.localeCompare(right.code) ||
        left.criterionId.localeCompare(right.criterionId) ||
        left.riskId.localeCompare(right.riskId) ||
        left.message.localeCompare(right.message),
    );
  const key = sha256Canonical({
    policy: "loop-v2-readiness-feedback-v2",
    candidateInputHash: input.assessment.candidateInputHash,
    progressKey: input.progressKey,
    gaps: normalizedGaps.map(({ code, criterionId, riskId }) => ({
      code,
      criterionId,
      riskId,
    })),
  });
  const message = formatLoopV2ReadinessFeedback(
    readiness.disposition,
    key,
    normalizedGaps,
    input.verificationRecords ?? [],
  );
  const requirement = deriveRepairRequirement(
    input.assessment,
    input.verificationRecords ?? [],
  );
  const priorNudges = input.priorKey === key ? (input.priorNudges ?? 0) : 0;
  if (input.noRoomForAnotherTurn) {
    return {
      type: "incomplete",
      key,
      message,
      reason: "no_turn_budget",
      ...(requirement ? { requirement } : {}),
    };
  }
  if (priorNudges >= LOOP_V2_READINESS_FEEDBACK_LIMIT) {
    return {
      type: "incomplete",
      key,
      message,
      reason: "feedback_exhausted",
      ...(requirement ? { requirement } : {}),
    };
  }
  return {
    type: "feedback",
    key,
    message: [
      message,
      "Issue the necessary tool call(s) in your next response. Prose that only describes a future action does not execute it and does not count as repair progress.",
    ].join("\n"),
    ...(requirement ? { requirement } : {}),
  };
}

function deriveRepairRequirement(
  assessment: LoopV2LiveCandidateAssessmentV1,
  verificationRecords: readonly VerificationRecordV2[],
): RepairRequirementV1 | undefined {
  const gapCodes = new Set(assessment.readiness.gaps.map((gap) => gap.code));
  const current = verificationRecords.filter(
    (record) => record.mutationRevision === assessment.mutationRevision,
  );
  const codeFailure = [...current]
    .reverse()
    .find((record) => record.outcome === "code_failed");
  if (
    codeFailure ||
    [
      "product_mutation_missing",
      "journal_incomplete",
      "artifact_unreconstructible",
      "artifact_cross_check_mismatch",
    ].some((code) => gapCodes.has(code as CandidateReadinessGapCodeV2))
  ) {
    return {
      kind: "material_change",
      afterRevision: assessment.mutationRevision,
    };
  }

  if (
    ![
      "verification_missing",
      "verification_scope_missing",
      "verification_unavailable",
    ].some((code) => gapCodes.has(code as CandidateReadinessGapCodeV2))
  ) {
    return undefined;
  }
  const latest = current.at(-1);
  const requiredScopes = assessment.policy.requiredVerificationScopes ?? [];
  const scope = [
    ...new Set(latest?.scope.length ? latest.scope : requiredScopes),
  ]
    .filter(Boolean)
    .sort();
  return {
    kind: "direct_verification",
    revision: assessment.mutationRevision,
    runnerFamily: latest?.runner ?? "any",
    scope,
  };
}

/**
 * Identity of meaningful investigation progress made before certification.
 *
 * Persisted candidate artifacts intentionally deduplicate on mutation and
 * verification facts, so their assessment may be reused after later reads.
 * Readiness repair instead reads the live projection. Unique evidence keys are
 * monotonic: a new read/search changes this key, while report rewording and an
 * exact repeated observation do not.
 */
export function loopV2ReadinessProgressKeyV1(
  state: WorkingDecisionStateV2,
): string {
  return sha256Canonical({
    policy: "loop-v2-readiness-progress-v1",
    evidenceFingerprints: Object.keys(state.evidence).sort(),
  });
}

export function parseLoopV2ReadinessFeedbackMarker(
  content: unknown,
): LoopV2ReadinessFeedbackStateV1 | undefined {
  if (typeof content !== "string") return undefined;
  const match = content.match(
    /^\[LoopV2Readiness:(?:needs_work|blocked) key=([a-f0-9]{64})\]/,
  );
  return match?.[1] ? { key: match[1], nudges: 1 } : undefined;
}

function formatLoopV2ReadinessFeedback(
  disposition: "needs_work" | "blocked",
  key: string,
  gaps: readonly {
    readonly code: CandidateReadinessGapCodeV2;
    readonly message: string;
    readonly criterionId: string;
    readonly riskId: string;
  }[],
  verificationRecords: readonly VerificationRecordV2[],
): string {
  const details = gaps.length
    ? gaps.slice(0, 20).map((gap) => {
        const subject = gap.criterionId
          ? ` criterion=${gap.criterionId}`
          : gap.riskId
            ? ` risk=${gap.riskId}`
            : "";
        const detail = actionableGapDetail(gap, verificationRecords).slice(
          0,
          900,
        );
        return `- ${gap.code}${subject}: ${detail}`;
      })
    : ["- readiness_unknown: The candidate is not ready for semantic review."];
  return [
    `[LoopV2Readiness:${disposition} key=${key}]`,
    "The candidate was not sent to semantic review. Complete the concrete missing work below, then propose a new final answer:",
    ...details,
  ].join("\n");
}

function actionableGapDetail(
  gap: Readonly<{
    code: CandidateReadinessGapCodeV2;
    message: string;
  }>,
  verificationRecords: readonly VerificationRecordV2[],
): string {
  if (gap.code === "verification_code_failed") {
    const failures = verificationRecords.filter(
      (verification) => verification.outcome === "code_failed",
    );
    return [
      gap.message ||
        "Current authoritative verification reports a code failure.",
      failures.length
        ? `Host facts: ${describeVerificationRecords(failures)}.`
        : "",
      "Treat observed current-revision failures as blockers; do not assume external or hidden tests supersede tracked assertions.",
      "Fix the candidate, then run a direct authoritative verification again.",
    ]
      .filter(Boolean)
      .join(" ");
  }
  if (gap.code === "verification_unavailable") {
    const failures = verificationRecords.filter(
      (verification) => verification.outcome === "harness_failed",
    );
    if (
      failures.some(
        (verification) => verification.failureClass === "untrusted_exit_status",
      )
    ) {
      return [
        gap.message || "Current authoritative verification is unavailable.",
        failures.length
          ? `Host facts: ${describeVerificationRecords(failures)}.`
          : "",
        "The test runner status was masked by shell control flow. Re-run the same test runner directly without pipes, redirections, fallbacks, or trailing commands; do not claim a pass from the masked exit code.",
      ]
        .filter(Boolean)
        .join(" ");
    }
    return [
      gap.message || "Current authoritative verification is unavailable.",
      failures.length
        ? `Host facts: ${describeVerificationRecords(failures)}.`
        : "",
      "Repair or simplify the invocation and obtain a direct authoritative result.",
    ]
      .filter(Boolean)
      .join(" ");
  }
  return gap.message || "Required evidence is missing.";
}

function describeVerificationRecords(
  records: readonly VerificationRecordV2[],
): string {
  return records
    .slice(-3)
    .map((verification) => {
      const failure = verification.failureClass
        ? ` failure=${verification.failureClass}`
        : "";
      const scope = verification.scope.length
        ? ` scope=${verification.scope.slice(0, 4).join(",")}`
        : "";
      const command = verification.argv.join(" ").replace(/\s+/g, " ").trim();
      return `${verification.id}${failure}${scope} command=${command || "unknown"}`.slice(
        0,
        360,
      );
    })
    .join("; ");
}
