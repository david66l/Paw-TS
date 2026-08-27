export type AmbEmbeddingPrewarmDecisionV1 = Readonly<{
  shouldPrewarm: boolean;
  reasonCode: "NoEmbeddingTexts" | "FitsBoundedCache" | "ExceedsCacheCapacity";
}>;

/** Never materialize a corpus-wide vector result that cannot remain cached. */
export function decideAmbEmbeddingPrewarmV1(input: Readonly<{
  textCount: number;
  cacheMaxEntries: number;
}>): AmbEmbeddingPrewarmDecisionV1 {
  if (
    !Number.isSafeInteger(input.textCount) ||
    input.textCount < 0 ||
    !Number.isSafeInteger(input.cacheMaxEntries) ||
    input.cacheMaxEntries < 1
  ) {
    throw new Error("AMB embedding prewarm policy input is invalid");
  }
  if (input.textCount === 0) {
    return Object.freeze({
      shouldPrewarm: false,
      reasonCode: "NoEmbeddingTexts",
    });
  }
  if (input.textCount > input.cacheMaxEntries) {
    return Object.freeze({
      shouldPrewarm: false,
      reasonCode: "ExceedsCacheCapacity",
    });
  }
  return Object.freeze({
    shouldPrewarm: true,
    reasonCode: "FitsBoundedCache",
  });
}
