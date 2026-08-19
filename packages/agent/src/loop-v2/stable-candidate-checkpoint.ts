import type { VerificationRecordV2 } from "./schema.js";

/**
 * Narrow pre-final review eligibility. A host checkpoint is allowed only at a
 * settled turn boundary after the current product revision has both a
 * substantive authoritative verification attempt and an inspected terminal
 * diff. It never implies delivery readiness or completion intent.
 */
export function isStableCandidateCheckpointEligibleV1(input: {
  readonly mutationRevision: number;
  readonly diffInspectedRevision?: number;
  readonly managedJobsBlockCompletion: boolean;
  readonly reviewAlreadyAttempted: boolean;
  readonly verification: readonly VerificationRecordV2[];
}): boolean {
  if (
    !Number.isSafeInteger(input.mutationRevision) ||
    input.mutationRevision <= 0 ||
    input.diffInspectedRevision !== input.mutationRevision ||
    input.managedJobsBlockCompletion ||
    input.reviewAlreadyAttempted
  ) {
    return false;
  }
  return input.verification.some(
    (verification) =>
      verification.mutationRevision === input.mutationRevision &&
      verification.authoritative,
  );
}
