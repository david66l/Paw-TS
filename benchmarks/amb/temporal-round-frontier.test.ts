import { describe, expect, test } from "bun:test";

import type { AmbDialogueAnchorV1 } from "./source-local-dialogue-projection.js";
import {
  compileAmbImmutableTemporalRoundPostingsV1,
  rankAmbTemporalRoundFrontierV1,
} from "./temporal-round-frontier.js";

function anchor(
  documentId: string,
  sourceSeq: number,
  sourceKind: "user_input" | "assistant_output" = "user_input",
): AmbDialogueAnchorV1 {
  return Object.freeze({
    documentId,
    sourceSeq,
    evidenceRef: `${documentId}#source-${sourceSeq}`,
    sourceKind,
  });
}

describe("AMB temporal round frontier", () => {
  test("authors posting identity from immutable L0 rather than ranking projections", () => {
    const evidenceAnchor = anchor("session-a", 2, "assistant_output");
    const observedAt = "2025-04-10T00:00:00.000Z";
    const immutableDigest = "b".repeat(64);
    const projectionVariants = [
      "a".repeat(1_600),
      "u".repeat(12_000),
      "api_key=[REDACTED]",
    ];
    for (const content of projectionVariants) {
      const postings = compileAmbImmutableTemporalRoundPostingsV1({
        candidates: [{ anchor: evidenceAnchor, content, observedAt }],
        hydrated: [
          {
            evidenceRef: evidenceAnchor.evidenceRef,
            sourceKind: "assistant_output",
            turnOrder: 2,
            observedAt,
            content: "final persisted immutable archive content",
            contentHash: immutableDigest,
          },
        ],
        episodeOrders: [{ sourceId: "session-a", episodeOrder: 4 }],
      });
      expect(postings[0]?.contentDigest).toBe(immutableDigest);
      expect(postings[0]?.episodeOrder).toBe(4);
    }
  });

  test("fails closed when search anchors disagree with immutable metadata", () => {
    const evidenceAnchor = anchor("session-a", 2, "assistant_output");
    const observedAt = "2025-04-10T00:00:00.000Z";
    const candidate = {
      anchor: evidenceAnchor,
      content: "ranking",
      observedAt,
    };
    const base = {
      evidenceRef: evidenceAnchor.evidenceRef,
      sourceKind: "assistant_output" as const,
      turnOrder: 2,
      observedAt,
      content: "immutable",
      contentHash: "c".repeat(64),
    };
    for (const hydrated of [
      { ...base, sourceKind: "user_input" as const },
      { ...base, turnOrder: 3 },
      { ...base, observedAt: "2025-04-11T00:00:00.000Z" },
    ]) {
      expect(() =>
        compileAmbImmutableTemporalRoundPostingsV1({
          candidates: [candidate],
          hydrated: [hydrated],
          episodeOrders: [],
        }),
      ).toThrow("AmbTemporalRoundFrontierImmutableMetadataInvalid");
    }
  });

  test("requires an exact one-to-one immutable candidate partition", () => {
    const evidenceAnchor = anchor("session-a", 1);
    const candidate = { anchor: evidenceAnchor, content: "ranking" };
    expect(() =>
      compileAmbImmutableTemporalRoundPostingsV1({
        candidates: [candidate],
        hydrated: [],
        episodeOrders: [],
      }),
    ).toThrow("AmbTemporalRoundFrontierImmutablePartitionInvalid");
    const row = {
      evidenceRef: evidenceAnchor.evidenceRef,
      sourceKind: "user_input" as const,
      turnOrder: 1,
      content: "immutable",
      contentHash: "d".repeat(64),
    };
    expect(() =>
      compileAmbImmutableTemporalRoundPostingsV1({
        candidates: [candidate],
        hydrated: [row, row],
        episodeOrders: [],
      }),
    ).toThrow("AmbTemporalRoundFrontierImmutablePartitionInvalid");
  });

  test("preserves baseline roles while admitting original-only and requirement-only rounds", () => {
    const baselineUser = anchor("session-a", 1);
    const baselineAssistant = anchor("session-a", 2, "assistant_output");
    const originalOnly = anchor("session-b", 3);
    const requirementOnly = anchor("session-c", 5);
    const result = rankAmbTemporalRoundFrontierV1({
      originalQuery: "When did I renew the climbing membership?",
      requirementText: "membership renewal date",
      temporalMode: "range",
      queryScopeInterval: {
        lower: "2025-04-01T00:00:00.000Z",
        upper: "2025-05-01T00:00:00.000Z",
        precision: "day",
      },
      baselineAnchors: [baselineUser, baselineAssistant],
      candidates: [
        {
          anchor: originalOnly,
          content: "I renewed the climbing membership.",
          observedAt: "2025-04-10T00:00:00.000Z",
        },
        {
          anchor: requirementOnly,
          content: "The renewal date was recorded.",
          observedAt: "2025-04-11T00:00:00.000Z",
        },
      ],
      lanes: [
        {
          kind: "original_query",
          evidenceRefs: [originalOnly.evidenceRef],
        },
        {
          kind: "requirement",
          evidenceRefs: [requirementOnly.evidenceRef],
        },
      ],
      sourcePriorityIds: ["session-a", "session-b", "session-c"],
      maxAnchors: 4,
    });
    expect(result.baselineReservedEvidenceRefs).toEqual([
      baselineUser.evidenceRef,
      baselineAssistant.evidenceRef,
    ]);
    expect([...result.frontierEvidenceRefs].sort()).toEqual(
      [originalOnly.evidenceRef, requirementOnly.evidenceRef].sort(),
    );
  });

  test("uses the host-bound window only as a ranking preference", () => {
    const outside = anchor("session-a", 1);
    const inside = anchor("session-b", 1);
    const result = rankAmbTemporalRoundFrontierV1({
      originalQuery: "What happened last month?",
      requirementText: "the relevant event",
      temporalMode: "range",
      queryScopeInterval: {
        lower: "2025-04-01T00:00:00.000Z",
        upper: "2025-05-01T00:00:00.000Z",
        precision: "day",
      },
      baselineAnchors: [],
      candidates: [
        {
          anchor: outside,
          content: "the relevant event",
          observedAt: "2025-03-10T00:00:00.000Z",
        },
        {
          anchor: inside,
          content: "the relevant event",
          observedAt: "2025-04-10T00:00:00.000Z",
        },
      ],
      lanes: [
        {
          kind: "original_query",
          evidenceRefs: [outside.evidenceRef, inside.evidenceRef],
        },
        {
          kind: "requirement",
          evidenceRefs: [outside.evidenceRef, inside.evidenceRef],
        },
      ],
      sourcePriorityIds: ["session-a", "session-b"],
      maxAnchors: 2,
    });
    expect(result.anchors.map((item) => item.evidenceRef)).toEqual([
      inside.evidenceRef,
      outside.evidenceRef,
    ]);
  });

  test("is deterministic when lane declaration order changes", () => {
    const first = anchor("session-a", 1);
    const second = anchor("session-b", 1);
    const base = {
      originalQuery: "Which event was first?",
      requirementText: "event chronology",
      temporalMode: "history" as const,
      queryScopeInterval: null,
      baselineAnchors: [],
      candidates: [
        { anchor: first, content: "event chronology" },
        { anchor: second, content: "event chronology" },
      ],
      sourcePriorityIds: ["session-a", "session-b"],
      maxAnchors: 2,
    };
    const lanes = [
      { kind: "original_query" as const, evidenceRefs: [first.evidenceRef] },
      { kind: "requirement" as const, evidenceRefs: [second.evidenceRef] },
    ];
    const left = rankAmbTemporalRoundFrontierV1({ ...base, lanes });
    const right = rankAmbTemporalRoundFrontierV1({
      ...base,
      lanes: [...lanes].reverse(),
    });
    expect(right.anchors).toEqual(left.anchors);
  });

  test("reserves every baseline anchor before source-fair frontier fill", () => {
    const baseline = [
      anchor("session-a", 1),
      anchor("session-a", 3),
      anchor("session-a", 5),
    ];
    const firstSource = anchor("session-a", 7);
    const secondSource = anchor("session-b", 1);
    const result = rankAmbTemporalRoundFrontierV1({
      originalQuery: "When did the events happen?",
      requirementText: "event dates",
      temporalMode: "history",
      queryScopeInterval: null,
      baselineAnchors: baseline,
      candidates: [
        { anchor: firstSource, content: "event date" },
        { anchor: secondSource, content: "event date" },
      ],
      lanes: [
        {
          kind: "original_query",
          evidenceRefs: [secondSource.evidenceRef],
        },
        {
          kind: "requirement",
          evidenceRefs: [firstSource.evidenceRef, secondSource.evidenceRef],
        },
      ],
      sourcePriorityIds: ["session-b", "session-a"],
      maxAnchors: 4,
    });
    expect(result.anchors.slice(0, 3)).toEqual(baseline);
    expect(result.anchors[3]?.evidenceRef).toBe(secondSource.evidenceRef);
    expect(result.baselineReservedEvidenceRefs).toEqual(
      baseline.map((item) => item.evidenceRef),
    );
  });
});
