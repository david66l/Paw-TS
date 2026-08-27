import { describe, expect, test } from "bun:test";

import { decideAmbEmbeddingPrewarmV1 } from "./embedding-prewarm-policy.js";

describe("AMB embedding prewarm policy", () => {
  test("prewarms only when every result fits the bounded cache", () => {
    expect(
      decideAmbEmbeddingPrewarmV1({ textCount: 2_048, cacheMaxEntries: 2_048 }),
    ).toEqual({ shouldPrewarm: true, reasonCode: "FitsBoundedCache" });
    expect(
      decideAmbEmbeddingPrewarmV1({ textCount: 2_049, cacheMaxEntries: 2_048 }),
    ).toEqual({ shouldPrewarm: false, reasonCode: "ExceedsCacheCapacity" });
  });

  test("skips empty input and rejects invalid capacities", () => {
    expect(
      decideAmbEmbeddingPrewarmV1({ textCount: 0, cacheMaxEntries: 2_048 }),
    ).toEqual({ shouldPrewarm: false, reasonCode: "NoEmbeddingTexts" });
    expect(() =>
      decideAmbEmbeddingPrewarmV1({ textCount: 1, cacheMaxEntries: 0 }),
    ).toThrow("AMB embedding prewarm policy input is invalid");
  });
});
