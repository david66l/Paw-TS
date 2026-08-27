import type { CompletionReviewTriggerV1 } from "@paw/protocol";

import type { CompletionReviewCandidateV1 } from "./candidate.js";
import { createCompletionReviewEvidencePacketV1 } from "./evidence-packet.js";
import { evaluateCompletionReviewTriggersV1 } from "./policy.js";

export const COMPLETION_REVIEW_GATE_POLICY_VERSION_V1 =
  "paw.completion-review-gate.v3" as const;

export type CompletionReviewGateDecisionV1 =
  | Readonly<{ action: "allow" }>
  | Readonly<{
      action: "review";
      triggers: readonly CompletionReviewTriggerV1[];
    }>;

export function evaluateCompletionReviewGateV1(
  candidate: CompletionReviewCandidateV1,
): CompletionReviewGateDecisionV1 {
  const packet = createCompletionReviewEvidencePacketV1(candidate);
  const evidenceTriggers = packet.verification.latestByTarget.flatMap((item) =>
    item.outcome === "failed"
      ? (["fresh_verification_failed"] as const)
      : item.outcome === "indeterminate"
        ? (["fresh_verification_inconclusive"] as const)
        : [],
  );
  const policyTriggers = evaluateCompletionReviewTriggersV1(candidate).filter(
    (trigger) =>
      trigger !== "missing_fresh_verification" ||
      packet.verification.state === "missing",
  );
  const triggers = Object.freeze([
    ...new Set([...policyTriggers, ...evidenceTriggers]),
  ]);
  return triggers.length === 0
    ? Object.freeze({ action: "allow" as const })
    : Object.freeze({ action: "review" as const, triggers });
}
