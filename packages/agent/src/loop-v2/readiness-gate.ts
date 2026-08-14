import { sha256Canonical } from "./canonical.js";
import type { LoopV2LiveCandidateAssessmentV1 } from "./live-candidate.js";

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
    }
  | {
      readonly type: "incomplete";
      readonly key: string;
      readonly message: string;
      readonly reason: "no_turn_budget" | "feedback_exhausted";
    };

export function evaluateLoopV2ReadinessGateV1(input: {
  readonly assessment: LoopV2LiveCandidateAssessmentV1;
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
    policy: "loop-v2-readiness-feedback-v1",
    candidateInputHash: input.assessment.candidateInputHash,
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
  );
  const priorNudges = input.priorKey === key ? (input.priorNudges ?? 0) : 0;
  if (input.noRoomForAnotherTurn) {
    return { type: "incomplete", key, message, reason: "no_turn_budget" };
  }
  if (priorNudges >= LOOP_V2_READINESS_FEEDBACK_LIMIT) {
    return {
      type: "incomplete",
      key,
      message,
      reason: "feedback_exhausted",
    };
  }
  return { type: "feedback", key, message };
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
    readonly code: string;
    readonly message: string;
    readonly criterionId: string;
    readonly riskId: string;
  }[],
): string {
  const details = gaps.length
    ? gaps.slice(0, 20).map((gap) => {
        const subject = gap.criterionId
          ? ` criterion=${gap.criterionId}`
          : gap.riskId
            ? ` risk=${gap.riskId}`
            : "";
        const detail =
          gap.message.slice(0, 500) || "Required evidence is missing.";
        return `- ${gap.code}${subject}: ${detail}`;
      })
    : ["- readiness_unknown: The candidate is not ready for semantic review."];
  return [
    `[LoopV2Readiness:${disposition} key=${key}]`,
    "The candidate was not sent to semantic review. Complete the concrete missing work below, then propose a new final answer:",
    ...details,
  ].join("\n");
}
