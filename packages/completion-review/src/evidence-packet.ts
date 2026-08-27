import type { JsonValue } from "@paw/protocol";

import type {
  CompletionReviewCandidateV1,
  CompletionReviewEvidenceOutcomeV1,
  CompletionReviewToolEvidenceV1,
  CompletionReviewVerificationKindV1,
} from "./candidate.js";
import { hasCompletionReviewSourceMutationV1 } from "./policy.js";

export const COMPLETION_REVIEW_EVIDENCE_PACKET_POLICY_VERSION_V1 =
  "paw.completion-review-evidence-packet.v1" as const;

export type CompletionReviewVerificationStateV1 =
  "not_required" | "missing" | "passed" | "failed" | "indeterminate";

export interface CompletionReviewVerificationEvidenceV1 {
  readonly callId: string;
  readonly tool: string;
  readonly target: string;
  readonly kind: Exclude<CompletionReviewVerificationKindV1, "none">;
  readonly executionStatus: CompletionReviewToolEvidenceV1["executionStatus"];
  readonly outcome: CompletionReviewEvidenceOutcomeV1;
  readonly args: JsonValue;
  readonly summary: string;
  readonly isError?: boolean;
  readonly exitCode?: number;
  readonly timedOut?: boolean;
}

export interface CompletionReviewEvidencePacketV1 {
  readonly policyVersion: typeof COMPLETION_REVIEW_EVIDENCE_PACKET_POLICY_VERSION_V1;
  readonly candidateHash: string;
  readonly goal: string;
  readonly proposedAnswer: string;
  readonly source: Readonly<{
    throughSeq: number;
    changedPaths: readonly string[];
    mutationCount: number;
    hasUnknownMutationPath: boolean;
  }>;
  readonly verification: Readonly<{
    state: CompletionReviewVerificationStateV1;
    latestByTarget: readonly CompletionReviewVerificationEvidenceV1[];
  }>;
}

/**
 * Project execution history into one bounded, objective packet. The projector
 * groups repeated commands by target but never decides what a failure means for
 * the requested behavior; that interpretation belongs to the reviewer.
 */
export function createCompletionReviewEvidencePacketV1(
  candidate: CompletionReviewCandidateV1,
): CompletionReviewEvidencePacketV1 {
  const latest = new Map<string, CompletionReviewToolEvidenceV1>();
  for (const evidence of candidate.toolEvidence) {
    if (!evidence.afterLatestMutation || evidence.verificationKind === "none") {
      continue;
    }
    latest.set(
      evidence.verificationTarget ??
        `${evidence.verificationKind}:${evidence.callId}`,
      evidence,
    );
  }

  const latestByTarget = Object.freeze(
    [...latest.entries()].map(([target, evidence]) =>
      Object.freeze({
        callId: evidence.callId,
        tool: evidence.tool,
        target,
        kind: evidence.verificationKind as Exclude<
          CompletionReviewVerificationKindV1,
          "none"
        >,
        executionStatus: evidence.executionStatus,
        outcome: evidence.outcome,
        args: evidence.args,
        summary: evidence.summary,
        ...(evidence.isError === undefined
          ? {}
          : { isError: evidence.isError }),
        ...(evidence.exitCode === undefined
          ? {}
          : { exitCode: evidence.exitCode }),
        ...(evidence.timedOut === undefined
          ? {}
          : { timedOut: evidence.timedOut }),
      }),
    ),
  );

  return Object.freeze({
    policyVersion: COMPLETION_REVIEW_EVIDENCE_PACKET_POLICY_VERSION_V1,
    candidateHash: candidate.candidateHash,
    goal: candidate.goal,
    proposedAnswer: candidate.assistantText,
    source: Object.freeze({
      throughSeq: candidate.sourceThroughSeq,
      changedPaths: candidate.changedPaths,
      mutationCount: candidate.mutationCount,
      hasUnknownMutationPath: candidate.hasUnknownMutationPath,
    }),
    verification: Object.freeze({
      state: verificationState(candidate, latestByTarget),
      latestByTarget,
    }),
  });
}

function verificationState(
  candidate: CompletionReviewCandidateV1,
  evidence: readonly CompletionReviewVerificationEvidenceV1[],
): CompletionReviewVerificationStateV1 {
  if (!hasCompletionReviewSourceMutationV1(candidate)) return "not_required";
  if (evidence.length === 0) return "missing";
  if (evidence.some((item) => item.outcome === "failed")) return "failed";
  if (evidence.some((item) => item.outcome === "indeterminate")) {
    return "indeterminate";
  }
  return "passed";
}
