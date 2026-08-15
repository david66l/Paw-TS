import type { LoopKernelVersion } from "./loop-v2/schema.js";

export const LOOP_AUTHORITY_SCHEMA_V1 = "paw.loop-authority-policy.v1" as const;

/**
 * One component may own one kind of decision. In particular, behavior advice
 * is not a safety policy and cannot deny tools or manufacture completion.
 */
export interface LoopAuthorityPolicyV1 {
  readonly schemaVersion: typeof LOOP_AUTHORITY_SCHEMA_V1;
  readonly kernel: LoopKernelVersion;
  readonly safety: "trusted_policy_can_deny";
  readonly effects: "executor_settles_observed_result";
  readonly evidence: "host_projects_append_only_facts";
  readonly behavior: "legacy_guarded" | "advisory_only";
  readonly planning: "legacy_completion_veto" | "projection_only";
  readonly review: "candidate_bound_semantic_veto";
  readonly completion: "completion_policy_only";
}

const V1_POLICY: LoopAuthorityPolicyV1 = Object.freeze({
  schemaVersion: LOOP_AUTHORITY_SCHEMA_V1,
  kernel: "v1",
  safety: "trusted_policy_can_deny",
  effects: "executor_settles_observed_result",
  evidence: "host_projects_append_only_facts",
  behavior: "legacy_guarded",
  planning: "legacy_completion_veto",
  review: "candidate_bound_semantic_veto",
  completion: "completion_policy_only",
});

const V2_SHADOW_POLICY: LoopAuthorityPolicyV1 = Object.freeze({
  ...V1_POLICY,
  kernel: "v2-shadow",
});

const V2_POLICY: LoopAuthorityPolicyV1 = Object.freeze({
  ...V1_POLICY,
  kernel: "v2",
  behavior: "advisory_only",
  planning: "projection_only",
});

/** Undefined is the established v1 default. Shadow must preserve v1 behavior. */
export function resolveLoopAuthorityPolicyV1(
  kernel?: LoopKernelVersion,
): LoopAuthorityPolicyV1 {
  if (kernel === "v2") return V2_POLICY;
  if (kernel === "v2-shadow") return V2_SHADOW_POLICY;
  return V1_POLICY;
}
