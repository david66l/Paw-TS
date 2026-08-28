export interface AmbSourceLocalBackfillChannelsV1 {
  readonly lexicalFailed: boolean;
  readonly denseFailed: boolean;
}

/** A required source exposure fails closed only when every configured channel fails. */
export function hasAmbSourceLocalBackfillFailureV1(input: {
  readonly denseConfigured: boolean;
  readonly attempts: readonly AmbSourceLocalBackfillChannelsV1[];
}): boolean {
  return input.attempts.some(
    (attempt) =>
      attempt.lexicalFailed && (!input.denseConfigured || attempt.denseFailed),
  );
}

/** Backfill is an exposure fallback and cannot outrank global hybrid evidence. */
export function ambSourceLocalBackfillScoreV1(
  sourcePriority: number,
  candidateRank: number,
): number {
  if (
    !Number.isSafeInteger(sourcePriority) ||
    sourcePriority < 0 ||
    !Number.isSafeInteger(candidateRank) ||
    candidateRank < 1
  ) {
    throw new Error("AmbSourceLocalBackfillRankInvalid");
  }
  return -(sourcePriority + 1) - candidateRank / 100;
}
