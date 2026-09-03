import { describe, expect, test } from "bun:test";
import { prioritizeEvidenceSearchResultForTemporalWindowV1 } from "../src/evidence-authority.js";
import type { MemoryEvidenceIndexSearchResultV1 } from "../src/evidence-resolution-contracts.js";

const WINDOW = {
  lower: "2023-05-20T00:00:00.000Z",
  upper: "2023-05-21T00:00:00.000Z",
  precision: "day" as const,
};

function resultFixture(): MemoryEvidenceIndexSearchResultV1 {
  return Object.freeze({
    lists: Object.freeze([
      Object.freeze({
        channel: "l0" as const,
        retrieverId: "fixture",
        weight: 1,
        candidates: Object.freeze([
          {
            candidateId: "outside",
            sourceId: "outside",
            evidenceRef: "outside:1",
            sourceKind: "source_span" as const,
            authority: "user_asserted" as const,
            observedAt: "2023-05-19T18:00:00.000Z",
          },
          {
            candidateId: "inside-first",
            sourceId: "inside-first",
            evidenceRef: "inside-first:1",
            sourceKind: "source_span" as const,
            authority: "user_asserted" as const,
            observedAt: "2023-05-20T18:00:00.000Z",
          },
          {
            candidateId: "inside-second",
            sourceId: "inside-second",
            evidenceRef: "inside-second:1",
            sourceKind: "source_span" as const,
            authority: "user_asserted" as const,
            observedAt: "2023-05-20T01:00:00.000Z",
          },
          {
            candidateId: "undated",
            sourceId: "undated",
            evidenceRef: "undated:1",
            sourceKind: "source_span" as const,
            authority: "user_asserted" as const,
          },
        ]),
      }),
    ]),
    hits: Object.freeze([
      {
        sourceId: "outside",
        evidenceRef: "outside:1",
        content: "outside",
        authority: "user_asserted" as const,
        observedAt: "2023-05-19T18:00:00.000Z",
      },
      {
        sourceId: "inside",
        evidenceRef: "inside:1",
        content: "inside",
        authority: "user_asserted" as const,
        observedAt: "2023-05-20T18:00:00.000Z",
      },
    ]),
  });
}

describe("temporal window evidence priority v1", () => {
  test("stably promotes in-window evidence without filtering alternatives", () => {
    const prioritized = prioritizeEvidenceSearchResultForTemporalWindowV1(
      resultFixture(),
      WINDOW,
    );
    expect(
      prioritized.lists[0]?.candidates.map(
        (candidate) => candidate.candidateId,
      ),
    ).toEqual(["inside-first", "inside-second", "outside", "undated"]);
    expect(prioritized.hits.map((hit) => hit.sourceId)).toEqual([
      "inside",
      "outside",
    ]);
  });

  test("preserves identity when the temporal window selects nothing", () => {
    const result = resultFixture();
    expect(
      prioritizeEvidenceSearchResultForTemporalWindowV1(result, {
        ...WINDOW,
        lower: "2024-01-01T00:00:00.000Z",
        upper: "2024-01-02T00:00:00.000Z",
      }),
    ).toBe(result);
  });
});
