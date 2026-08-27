import type { JournalContextPlanV1 } from "@paw/runtime";

export const CONTEXT_COMPACTION_POLICY_VERSION_V1 =
  "paw.context-compaction.v1:r8000:n2:t4" as const;

export interface ContextCompactionPolicyV1 {
  /** Trigger at this proportion of the Context soft input target. */
  readonly triggerRatioBasisPoints: number;
  /** A model call is not worthwhile below this number of new timeline units. */
  readonly minimumNewTimelineUnits: number;
  /** Recent unprotected units kept verbatim in addition to Runtime anchors. */
  readonly retainNewestUnprotectedUnits: number;
}

export const DEFAULT_CONTEXT_COMPACTION_POLICY_V1: ContextCompactionPolicyV1 =
  Object.freeze({
    triggerRatioBasisPoints: 8_000,
    minimumNewTimelineUnits: 2,
    retainNewestUnprotectedUnits: 4,
  });

export type ContextCompactionTriggerV1 =
  | Readonly<{
      shouldDistill: false;
      reason: "below_trigger";
      usageRatioBasisPoints: number;
    }>
  | Readonly<{
      shouldDistill: true;
      reason: "near_soft_limit" | "fallback_omission_active";
      usageRatioBasisPoints: number;
    }>;

export function evaluateContextCompactionTriggerV1(
  plan: JournalContextPlanV1,
  policy: ContextCompactionPolicyV1 = DEFAULT_CONTEXT_COMPACTION_POLICY_V1,
): ContextCompactionTriggerV1 {
  const frozen = freezeContextCompactionPolicyV1(policy);
  const denominator = Math.max(1, plan.tokens.softTargetTokens);
  const usageRatioBasisPoints = Math.ceil(
    (plan.tokens.fullInputTokens * 10_000) / denominator,
  );
  if (plan.selection.omittedUnitSourceSeqs.length > 0) {
    return Object.freeze({
      shouldDistill: true,
      reason: "fallback_omission_active",
      usageRatioBasisPoints,
    });
  }
  if (usageRatioBasisPoints >= frozen.triggerRatioBasisPoints) {
    return Object.freeze({
      shouldDistill: true,
      reason: "near_soft_limit",
      usageRatioBasisPoints,
    });
  }
  return Object.freeze({
    shouldDistill: false,
    reason: "below_trigger",
    usageRatioBasisPoints,
  });
}

export function freezeContextCompactionPolicyV1(
  policy: ContextCompactionPolicyV1,
): ContextCompactionPolicyV1 {
  if (
    !Number.isSafeInteger(policy.triggerRatioBasisPoints) ||
    policy.triggerRatioBasisPoints <= 0 ||
    policy.triggerRatioBasisPoints > 10_000 ||
    !Number.isSafeInteger(policy.minimumNewTimelineUnits) ||
    policy.minimumNewTimelineUnits <= 0 ||
    !Number.isSafeInteger(policy.retainNewestUnprotectedUnits) ||
    policy.retainNewestUnprotectedUnits < 0
  ) {
    throw new Error("Context compaction policy is invalid");
  }
  return Object.freeze({ ...policy });
}
