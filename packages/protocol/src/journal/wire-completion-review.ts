/** Completion review wire values. */
export type CompletionReviewTriggerV1 =
  | "user_requested"
  | "project_required"
  | "non_trivial_change"
  | "delivery_without_observation"
  | "missing_fresh_verification"
  | "fresh_verification_failed"
  | "fresh_verification_inconclusive"
  | "model_requested";

export type CompletionReviewVerdictV1 = "allow" | "block" | "await_user" | "unknown";
