import { describe, expect, test } from "bun:test";

import {
  planAmbEmbeddingWavesV1,
  streamAmbEmbeddingBatchesV1,
} from "./embedding-stream.js";

describe("AMB embedding streaming batches", () => {
  test("plans ordered cache-bounded document waves", () => {
    expect(
      planAmbEmbeddingWavesV1({
        items: [2, 3, 5, 11, 1],
        weight: (item) => item,
        maxWeight: 10,
        maxItems: 3,
      }),
    ).toEqual([[2, 3, 5], [11], [1]]);
    expect(() =>
      planAmbEmbeddingWavesV1({
        items: [1],
        weight: () => -1,
        maxWeight: 10,
        maxItems: 3,
      }),
    ).toThrow("item weight is invalid");
  });

  test("prewarms and persists bounded batches in order", async () => {
    const events: string[] = [];
    const report = await streamAmbEmbeddingBatchesV1({
      items: ["a", "b", "c", "d", "e"],
      batchSize: 2,
      text: (item) => item,
      async prewarm(texts) {
        events.push(`embed:${texts.join("")}`);
      },
      async persistBatch(items) {
        events.push(`store:${items.join("")}`);
      },
    });
    expect(report).toEqual({ batchCount: 3, itemCount: 5 });
    expect(events).toEqual([
      "embed:ab",
      "store:ab",
      "embed:cd",
      "store:cd",
      "embed:e",
      "store:e",
    ]);
  });

  test("does not advance after a failed persistence batch", async () => {
    const embedded: string[] = [];
    await expect(
      streamAmbEmbeddingBatchesV1({
        items: ["a", "b", "c"],
        batchSize: 2,
        text: (item) => item,
        async prewarm(texts) {
          embedded.push(texts.join(""));
        },
        async persistBatch() {
          throw new Error("store failed");
        },
      }),
    ).rejects.toThrow("store failed");
    expect(embedded).toEqual(["ab"]);
  });

  test("rejects invalid bounds and empty text", async () => {
    await expect(
      streamAmbEmbeddingBatchesV1({
        items: ["a"],
        batchSize: 65,
        text: (item) => item,
        async prewarm() {},
        async persistBatch() {},
      }),
    ).rejects.toThrow("between 1 and 64");
    await expect(
      streamAmbEmbeddingBatchesV1({
        items: [" "],
        batchSize: 1,
        text: (item) => item,
        async prewarm() {},
        async persistBatch() {},
      }),
    ).rejects.toThrow("text is empty");
  });
});
