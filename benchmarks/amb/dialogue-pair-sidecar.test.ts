import { describe, expect, test } from "bun:test";

import {
  buildAmbDialoguePairSearchPlanV1,
  compileAmbDialoguePairFacetsV1,
  selectAmbSourceFairDialoguePairsV1,
  type AmbDialoguePairCandidateV1,
} from "./dialogue-pair-sidecar.js";

function pair(
  source: string,
  seq: number,
  pairId = `${source}-${seq}`,
): AmbDialoguePairCandidateV1 {
  return {
    pairId,
    documentId: source,
    userSeq: seq,
    assistantSeq: seq + 1,
    userEvidenceRef: `amb:document/${source}#source-${seq}`,
    assistantEvidenceRef: `amb:document/${source}#source-${seq + 1}`,
  };
}

describe("immutable dialogue-pair sidecar", () => {
  test("builds independently hard-filtered prompt and response search lanes", () => {
    expect(
      buildAmbDialoguePairSearchPlanV1({
        requirementText: "planner leaf",
        originalQuery: "original question",
      }),
    ).toEqual([
      {
        lane: "requirement",
        face: "prompt",
        sourceKind: "user_input",
        text: "planner leaf",
      },
      {
        lane: "requirement",
        face: "response",
        sourceKind: "assistant_output",
        text: "planner leaf",
      },
      {
        lane: "original_query",
        face: "prompt",
        sourceKind: "user_input",
        text: "original question",
      },
      {
        lane: "original_query",
        face: "response",
        sourceKind: "assistant_output",
        text: "original question",
      },
    ]);
  });

  test("compiles only exact adjacent user to assistant pairs", () => {
    const facets = compileAmbDialoguePairFacetsV1({
      runKey: "run",
      userId: "user",
      documentId: "session",
      turns: [
        { seq: 1, kind: "verification", content: "system" },
        { seq: 2, kind: "user_input", content: "question" },
        { seq: 3, kind: "assistant_output", content: "answer" },
        { seq: 4, kind: "assistant_output", content: "extra" },
        { seq: 6, kind: "user_input", content: "not adjacent" },
        { seq: 8, kind: "assistant_output", content: "gap" },
      ],
    });

    expect(facets).toHaveLength(2);
    expect(new Set(facets.map((facet) => facet.pairId)).size).toBe(1);
    expect(facets.map((facet) => facet.face)).toEqual([
      "prompt",
      "response",
    ]);
  });

  test("pair identity changes when immutable content changes", () => {
    const compile = (answer: string) =>
      compileAmbDialoguePairFacetsV1({
        runKey: "run",
        userId: "user",
        documentId: "session",
        turns: [
          { seq: 1, kind: "user_input" as const, content: "question" },
          { seq: 2, kind: "assistant_output" as const, content: answer },
        ],
      })[0]!.pairId;

    expect(compile("answer-a")).not.toBe(compile("answer-b"));
  });

  test("deduplicates identical windows and fails closed on conflicting turns", () => {
    const base = [
      { seq: 1, kind: "user_input" as const, content: "question" },
      { seq: 2, kind: "assistant_output" as const, content: "answer" },
    ];
    expect(
      compileAmbDialoguePairFacetsV1({
        runKey: "run",
        userId: "user",
        documentId: "session",
        turns: [...base, ...base],
      }),
    ).toHaveLength(2);
    expect(
      compileAmbDialoguePairFacetsV1({
        runKey: "run",
        userId: "user",
        documentId: "session",
        turns: [...base, { ...base[1]!, content: "conflict" }],
      }),
    ).toEqual([]);
  });

  test("fuses prompt and response faces into one pair candidate", () => {
    const candidate = pair("source-1", 1);
    const selected = selectAmbSourceFairDialoguePairsV1({
      sourcePriority: ["source-1"],
      rankingsBySource: new Map([
        [
          "source-1",
          [
            { lane: "requirement_prompt", pairs: [candidate] },
            { lane: "original_query_response", pairs: [candidate] },
          ],
        ],
      ]),
      maxPairs: 8,
      maxPairsPerSource: 1,
    });

    expect(selected).toEqual([candidate]);
  });

  test("allocates lower-priority sources before a second pair when cap is two", () => {
    const source1 = [pair("source-1", 1), pair("source-1", 3)];
    const source3 = pair("source-3", 5);
    const selected = selectAmbSourceFairDialoguePairsV1({
      sourcePriority: ["source-1", "source-2", "source-3"],
      rankingsBySource: new Map([
        [
          "source-1",
          [{ lane: "requirement_prompt", pairs: source1 }],
        ],
        ["source-2", []],
        [
          "source-3",
          [{ lane: "original_query_response", pairs: [source3] }],
        ],
      ]),
      maxPairs: 3,
      maxPairsPerSource: 2,
    });

    expect(selected).toEqual([source1[0]!, source3, source1[1]!]);
  });

  test("enforces the pre-registered one-pair-per-source cap", () => {
    const source1 = [pair("source-1", 1), pair("source-1", 3)];
    expect(
      selectAmbSourceFairDialoguePairsV1({
        sourcePriority: ["source-1"],
        rankingsBySource: new Map([
          [
            "source-1",
            [{ lane: "requirement_prompt", pairs: source1 }],
          ],
        ]),
        maxPairs: 8,
        maxPairsPerSource: 1,
      }),
    ).toEqual([source1[0]!]);
  });

  test("drops malformed and foreign-source pair records", () => {
    const malformed = {
      ...pair("source-1", 1),
      assistantSeq: 9,
    };
    const selected = selectAmbSourceFairDialoguePairsV1({
      sourcePriority: ["source-1"],
      rankingsBySource: new Map([
        [
          "source-1",
          [
            {
              lane: "requirement_response",
              pairs: [malformed, pair("foreign", 1)],
            },
          ],
        ],
      ]),
      maxPairs: 8,
      maxPairsPerSource: 1,
    });

    expect(selected).toEqual([]);
  });
});
