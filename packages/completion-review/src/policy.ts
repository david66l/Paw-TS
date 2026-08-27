import type { CompletionReviewTriggerV1 } from "@paw/protocol";
import type { CompletionReviewCandidateV1 } from "./candidate.js";

export const COMPLETION_REVIEW_TRIGGER_POLICY_VERSION_V1 =
  "paw.completion-review-trigger.v2:verification-evidence-short-circuit" as const;

export interface CompletionReviewTriggerPolicyV1 {
  readonly nonTrivialMutationCount: number;
  readonly reviewUnverifiedSourceChanges: boolean;
  readonly requiredPathPrefixes: readonly string[];
}

export const DEFAULT_COMPLETION_REVIEW_TRIGGER_POLICY_V1: CompletionReviewTriggerPolicyV1 =
  Object.freeze({
    nonTrivialMutationCount: 3,
    reviewUnverifiedSourceChanges: true,
    requiredPathPrefixes: Object.freeze([]),
  });

export function evaluateCompletionReviewTriggersV1(
  candidate: CompletionReviewCandidateV1,
  policy: CompletionReviewTriggerPolicyV1 = DEFAULT_COMPLETION_REVIEW_TRIGGER_POLICY_V1,
): readonly CompletionReviewTriggerV1[] {
  const frozen = freezeCompletionReviewTriggerPolicyV1(policy);
  const triggers: CompletionReviewTriggerV1[] = [];
  if (explicitlyRequestsReview(candidate)) triggers.push("user_requested");
  if (
    frozen.requiredPathPrefixes.some((prefix) =>
      candidate.changedPaths.some((path) => path.startsWith(prefix)),
    )
  ) {
    triggers.push("project_required");
  }
  if (candidate.mutationCount >= frozen.nonTrivialMutationCount) {
    triggers.push("non_trivial_change");
  }
  if (
    frozen.reviewUnverifiedSourceChanges &&
    hasCompletionReviewSourceMutationV1(candidate) &&
    !hasFreshCommandEvidence(candidate)
  ) {
    triggers.push("missing_fresh_verification");
  }
  return Object.freeze(triggers);
}

export function freezeCompletionReviewTriggerPolicyV1(
  value: CompletionReviewTriggerPolicyV1,
): CompletionReviewTriggerPolicyV1 {
  if (
    !Number.isSafeInteger(value.nonTrivialMutationCount) ||
    value.nonTrivialMutationCount <= 0 ||
    typeof value.reviewUnverifiedSourceChanges !== "boolean"
  ) {
    throw new Error("Completion review trigger policy is invalid");
  }
  const requiredPathPrefixes = value.requiredPathPrefixes.map((item) =>
    item.replaceAll("\\", "/").replace(/^\.\//, "").trim(),
  );
  if (requiredPathPrefixes.some((item) => !item)) {
    throw new Error("Completion review required path prefix is invalid");
  }
  return Object.freeze({
    nonTrivialMutationCount: value.nonTrivialMutationCount,
    reviewUnverifiedSourceChanges: value.reviewUnverifiedSourceChanges,
    requiredPathPrefixes: Object.freeze([...new Set(requiredPathPrefixes)]),
  });
}

function explicitlyRequestsReview(
  candidate: CompletionReviewCandidateV1,
): boolean {
  if (/(?:\breview\b|审查|评审|检查)/iu.test(candidate.goal)) return true;
  const requestsVerification =
    /(?:\bverify\b|\bverification\b|\btest(?:s|ing)?\b|验证|测试)/iu.test(
      candidate.goal,
    );
  return requestsVerification && !hasFreshCommandEvidence(candidate);
}

export function hasCompletionReviewSourceMutationV1(
  candidate: CompletionReviewCandidateV1,
): boolean {
  if (candidate.hasUnknownMutationPath) return candidate.mutationCount > 0;
  return candidate.changedPaths.some((path) =>
    /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|kts|swift|c|cc|cpp|cxx|h|hpp|cs|php|rb|vue|svelte)$/iu.test(
      path,
    ),
  );
}

function hasFreshCommandEvidence(
  candidate: CompletionReviewCandidateV1,
): boolean {
  return candidate.toolEvidence.some(
    (item) =>
      item.afterLatestMutation &&
      item.executionStatus === "completed" &&
      item.outcome === "passed" &&
      item.verificationKind !== "none",
  );
}
