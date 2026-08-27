import type { TaskCheckpointV1 } from "@paw/protocol";

import type { CheckpointQualityGateV1 } from "./checkpoint-distiller.js";
import type { CheckpointEvidenceBundleV1 } from "./checkpoint-evidence.js";
import {
  type ContextCompactionLifecyclePolicyV1,
  DEFAULT_CONTEXT_COMPACTION_LIFECYCLE_POLICY_V1,
  evaluateContextCompactionSavingsV1,
  freezeContextCompactionLifecyclePolicyV1,
} from "./lifecycle-policy.js";

export interface CheckpointCompressionQualityGateOptionsV1 {
  readonly countTokens: (text: string) => number;
  readonly policy?: ContextCompactionLifecyclePolicyV1;
}

/**
 * Rejects checkpoints that do not materially reduce their projected source.
 * Suspiciously high savings stay eligible because evidence coverage and the
 * independent semantic verifier are the stronger anti-fabrication gates.
 */
export function createCheckpointCompressionQualityGateV1(
  options: CheckpointCompressionQualityGateOptionsV1,
): CheckpointQualityGateV1 {
  if (typeof options.countTokens !== "function") {
    throw new Error("Checkpoint quality token counter is invalid");
  }
  const countTokens = options.countTokens.bind(undefined);
  const policy = freezeContextCompactionLifecyclePolicyV1(
    options.policy ?? DEFAULT_CONTEXT_COMPACTION_LIFECYCLE_POLICY_V1,
  );
  return Object.freeze({
    evaluate(
      input: Readonly<{
        checkpoint: TaskCheckpointV1;
        evidence: CheckpointEvidenceBundleV1;
      }>,
    ) {
      const beforeTokens = checkedCount(
        countTokens(JSON.stringify(input.evidence.items)),
      );
      const afterTokens = checkedCount(
        countTokens(JSON.stringify(input.checkpoint)),
      );
      const savings = evaluateContextCompactionSavingsV1(
        beforeTokens,
        afterTokens,
        policy,
      );
      return savings.classification === "low"
        ? Object.freeze({
            status: "low_savings" as const,
            errorCode: "CheckpointLowSavings",
          })
        : Object.freeze({ status: "accepted" as const });
    },
  });
}

function checkedCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Checkpoint quality token estimate is invalid");
  }
  return value;
}
