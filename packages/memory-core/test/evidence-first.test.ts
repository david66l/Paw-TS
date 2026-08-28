import { describe, expect, test } from "bun:test";

import {
  PAW_MEMORY_EVIDENCE_CANDIDATE_FUSION_VERSION_V2,
  PAW_MEMORY_EVIDENCE_FIRST_POLICY_VERSION_V1,
  buildMemoryConversationTurnBundleV1,
  buildMemoryEvidenceNotebookV1,
  isAssistantMemoryQueryV1,
  projectMemoryEvidenceExcerptV1,
  rankMemoryEvidenceCandidatesV2,
  rankMemoryEvidenceSourcesV1,
  selectRankedMemoryConversationBundlesV1,
} from "../src/index.js";

describe("evidence-first source fusion v1", () => {
  test("unions independent L0 and L1 discovery without a graph gate", () => {
    const result = rankMemoryEvidenceSourcesV1({
      lists: [
        { channel: "l0", weight: 1, sourceIds: ["raw-a", "raw-b"] },
        { channel: "l1", weight: 0.75, sourceIds: ["raw-c", "raw-a"] },
      ],
      maxSources: 8,
    });

    expect(result.policyVersion).toBe(
      PAW_MEMORY_EVIDENCE_FIRST_POLICY_VERSION_V1,
    );
    expect(result.sources.map((item) => item.sourceId)).toEqual([
      "raw-a",
      "raw-b",
      "raw-c",
    ]);
    expect(result.sources[0]).toEqual(
      expect.objectContaining({
        sourceId: "raw-a",
        channelHits: 2,
        channels: ["l0", "l1"],
      }),
    );
    expect(result.telemetry).toEqual({
      inputListCount: 2,
      l0CandidateCount: 2,
      l1CandidateCount: 2,
      fusedCandidateCount: 3,
      dualChannelCount: 1,
      returnedCount: 3,
    });
  });

  test("deduplicates repeated source pointers within one channel", () => {
    const result = rankMemoryEvidenceSourcesV1({
      lists: [
        {
          channel: "l1",
          weight: 1,
          sourceIds: ["source-a", "source-a", "source-b"],
        },
      ],
      maxSources: 1,
    });

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.sourceId).toBe("source-a");
    expect(result.telemetry.l1CandidateCount).toBe(2);
  });

  test("is deterministic under exact score ties", () => {
    const input = {
      lists: [
        { channel: "l0" as const, weight: 1, sourceIds: ["source-b"] },
        { channel: "l1" as const, weight: 1, sourceIds: ["source-a"] },
      ],
      maxSources: 2,
    };

    expect(
      rankMemoryEvidenceSourcesV1(input).sources.map((item) => item.sourceId),
    ).toEqual(["source-a", "source-b"]);
  });

  test("fails closed on invalid budgets and weights", () => {
    expect(() =>
      rankMemoryEvidenceSourcesV1({ lists: [], maxSources: 0 }),
    ).toThrow("MemoryEvidenceFirstSourceBudgetInvalid");
    expect(() =>
      rankMemoryEvidenceSourcesV1({
        lists: [{ channel: "l0", weight: 0, sourceIds: ["source-a"] }],
        maxSources: 1,
      }),
    ).toThrow("MemoryEvidenceFirstWeightInvalid");
  });
});

describe("evidence excerpt projection", () => {
  test("maps natural-language numeric ordinals to enumerated source positions", () => {
    const content = [
      "Prompt parameters that influence output:",
      ...Array.from({ length: 40 }, (_, index) =>
        index === 26
          ? "27. Sound effects (ambient, diegetic, non-diegetic)"
          : `${index + 1}. parameter ${index + 1} ${"detail ".repeat(8)}`,
      ),
    ].join("\n");

    const excerpt = projectMemoryEvidenceExcerptV1(
      content,
      "What was the 27th parameter?",
      384,
    );

    expect(excerpt).toContain("27. Sound effects");
    expect(excerpt.length).toBeLessThanOrEqual(384);
  });
});

describe("evidence-address fusion v2", () => {
  const candidate = (
    candidateId: string,
    sourceId: string,
    authority: "user_asserted" | "context_only" = "user_asserted",
  ) => ({
    candidateId,
    sourceId,
    evidenceRef: `amb:document/${sourceId}#${candidateId}`,
    sourceKind: "source_span" as const,
    authority,
  });

  test("keeps exact evidence addresses while ranking one best hit per retriever", () => {
    const result = rankMemoryEvidenceCandidatesV2({
      lists: [
        {
          channel: "l0",
          retrieverId: "coarse-vector",
          weight: 0.65,
          candidates: [
            candidate("chunk-1", "doc-a"),
            candidate("chunk-2", "doc-a"),
            candidate("chunk-3", "doc-b"),
          ],
        },
        {
          channel: "l0",
          retrieverId: "role-aware-conversation",
          weight: 1,
          candidates: [
            candidate("turn-7", "doc-b"),
            candidate("turn-8", "doc-c", "context_only"),
          ],
        },
      ],
      maxSources: 3,
      maxEvidencePerSource: 4,
    });

    expect(result.policyVersion).toBe(
      PAW_MEMORY_EVIDENCE_CANDIDATE_FUSION_VERSION_V2,
    );
    expect(result.sources.map((source) => source.sourceId)).toEqual([
      "doc-b",
      "doc-c",
      "doc-a",
    ]);
    expect(result.sources[0]?.evidence.map((item) => item.candidateId)).toEqual(
      ["turn-7", "chunk-3"],
    );
    expect(result.telemetry).toEqual({
      inputListCount: 2,
      l0CandidateCount: 5,
      l1CandidateCount: 0,
      fusedCandidateCount: 5,
      fusedSourceCount: 3,
      dualChannelSourceCount: 0,
      returnedSourceCount: 3,
      returnedEvidenceCount: 5,
    });
  });

  test("rejects a reused candidate id with conflicting provenance", () => {
    expect(() =>
      rankMemoryEvidenceCandidatesV2({
        lists: [
          {
            channel: "l0",
            retrieverId: "first",
            weight: 1,
            candidates: [candidate("same", "doc-a")],
          },
          {
            channel: "l1",
            retrieverId: "second",
            weight: 1,
            candidates: [candidate("same", "doc-b")],
          },
        ],
        maxSources: 2,
        maxEvidencePerSource: 2,
      }),
    ).toThrow("MemoryEvidenceCandidateIdentityConflict");
  });
});

describe("evidence-first conversational bundles", () => {
  test("opens assistant recall only for explicit prior-assistant questions", () => {
    expect(
      isAssistantMemoryQueryV1(
        "In the book you wrote in our previous conversation, what color was the Plesiosaur?",
      ),
    ).toBe(true);
    expect(isAssistantMemoryQueryV1("What did you recommend last time?")).toBe(
      true,
    );
    expect(
      isAssistantMemoryQueryV1(
        "Can you remind me what was the 27th parameter on the list you provided?",
      ),
    ).toBe(true);
    expect(
      isAssistantMemoryQueryV1("What phone accessory did I tell you I bought?"),
    ).toBe(false);
    expect(
      isAssistantMemoryQueryV1("How have my travel preferences changed?"),
    ).toBe(false);
  });

  test("preserves chronological roles around a user-confirmed assistant antecedent", () => {
    const bundle = buildMemoryConversationTurnBundleV1({
      query: "a writer discussed their works and writing process",
      maxChars: 900,
      turns: [
        {
          sourceSeq: 5,
          sourceKind: "user_input",
          content:
            "Yes, I asked about their writing process and admired their previous works.",
          hit: true,
        },
        {
          sourceSeq: 4,
          sourceKind: "assistant_output",
          content:
            "It must have been exciting to attend the author signing for your favorite writer.",
          hit: false,
        },
        {
          sourceSeq: 6,
          sourceKind: "assistant_output",
          content: "Author signings can be thrilling.",
          hit: false,
        },
      ],
    });

    expect(bundle.text.indexOf("assistant_output previous")).toBeLessThan(
      bundle.text.indexOf("user_input hit"),
    );
    expect(bundle.text.indexOf("user_input hit")).toBeLessThan(
      bundle.text.indexOf("assistant_output next"),
    );
    expect(bundle.text).toContain("author signing");
    expect(bundle.text).toContain("Yes, I asked");
    expect(bundle.hitSeq).toBe(5);
    expect(bundle.authority).toBe("user_confirmed_dialogue");
    expect(bundle.includedTurns).toBe(3);
    expect(bundle.chars).toBeLessThanOrEqual(900);
  });

  test("does not promote an unconfirmed assistant proposition", () => {
    const bundle = buildMemoryConversationTurnBundleV1({
      query: "favorite city",
      maxChars: 600,
      turns: [
        {
          sourceSeq: 1,
          sourceKind: "assistant_output",
          content: "Your favorite city is Paris.",
          hit: true,
        },
        {
          sourceSeq: 2,
          sourceKind: "user_input",
          content: "Tell me about train tickets.",
          hit: false,
        },
      ],
    });

    expect(bundle.authority).toBe("context_only");
  });

  test("fails closed without exactly one hit or a valid budget", () => {
    const turn = {
      sourceSeq: 1,
      sourceKind: "user_input" as const,
      content: "I like concise answers.",
      hit: false,
    };
    expect(() =>
      buildMemoryConversationTurnBundleV1({
        query: "answers",
        maxChars: 900,
        turns: [turn],
      }),
    ).toThrow("MemoryConversationTurnBundleHitInvalid");
    expect(() =>
      buildMemoryConversationTurnBundleV1({
        query: "answers",
        maxChars: 100,
        turns: [{ ...turn, hit: true }],
      }),
    ).toThrow("MemoryConversationTurnBundleBudgetInvalid");
  });

  test("keeps multiple ranked hits from one document within one budget", () => {
    const selected = selectRankedMemoryConversationBundlesV1({
      bundles: [
        "first ".repeat(100),
        "second ".repeat(100),
        "third ".repeat(100),
      ],
      query: "first second",
      maxBundles: 2,
      maxChars: 700,
    });

    expect(selected.selectedBundles).toBe(2);
    expect(selected.text).toContain("first");
    expect(selected.text).toContain("second");
    expect(selected.text).not.toContain("third");
    expect(selected.chars).toBeLessThanOrEqual(700);
  });

  test("keeps the query-bearing middle of a long assistant bundle", () => {
    const selected = selectRankedMemoryConversationBundlesV1({
      bundles: [
        `${"earlier chapter filler ".repeat(80)}The Plesiosaur has a blue scaly body.${" later filler".repeat(80)}`,
      ],
      query: "what color was the scaly body of the Plesiosaur",
      maxBundles: 1,
      maxChars: 900,
    });

    expect(selected.text).toContain("Plesiosaur has a blue scaly body");
    expect(selected.chars).toBeLessThanOrEqual(900);
  });
});

describe("evidence notebook v1", () => {
  test("skips a metadata-heavy hit when the remaining excerpt budget is below the projector minimum", () => {
    const notebook = buildMemoryEvidenceNotebookV1({
      requirements: [
        {
          requirementId: "small-budget",
          label: "city visited",
          searchText: "city visited",
          hits: [
            {
              sourceId: "session-a",
              evidenceRef: `journal:prior#${"long-address-".repeat(8)}`,
              content: "I visited Kyoto and enjoyed the trip.",
              authority: "user_asserted",
            },
          ],
        },
      ],
      allowedSourceIds: ["session-a"],
      maxHitsPerRequirement: 1,
      maxChars: 320,
    });

    expect(notebook.coverage[0]?.status).toBe("missing");
    expect(notebook.sources).toEqual([]);
  });

  test("fills independent requirements only inside primary-selected sources", () => {
    const notebook = buildMemoryEvidenceNotebookV1({
      allowedSourceIds: ["trip-japan", "trip-chicago"],
      maxHitsPerRequirement: 1,
      maxChars: 4_096,
      requirements: [
        {
          requirementId: "japan-days",
          label: "days spent in Japan",
          searchText: "Japan trip dates duration",
          hits: [
            {
              sourceId: "not-selected",
              evidenceRef: "e0",
              content: "I spent nine days elsewhere.",
              authority: "user_asserted",
            },
            {
              sourceId: "trip-japan",
              evidenceRef: "e1",
              content: "I was in Japan from April 15 through April 22.",
              authority: "user_asserted",
              observedAt: "2023-05-29T00:00:00.000Z",
            },
          ],
        },
        {
          requirementId: "chicago-days",
          label: "days spent in Chicago",
          searchText: "Chicago trip days",
          hits: [
            {
              sourceId: "trip-chicago",
              evidenceRef: "e2",
              content: "My last trip to Chicago lasted four days.",
              authority: "user_asserted",
            },
          ],
        },
      ],
    });

    expect(notebook.coverage).toEqual([
      {
        requirementId: "japan-days",
        status: "covered",
        selectedHitCount: 1,
        independentEvidenceCount: 1,
        closureEvidenceCount: 1,
        selectedEvidenceRefs: ["e1"],
        historicalEvidenceRefs: [],
        unresolvedEvidenceRefs: [],
      },
      {
        requirementId: "chicago-days",
        status: "covered",
        selectedHitCount: 1,
        independentEvidenceCount: 1,
        closureEvidenceCount: 1,
        selectedEvidenceRefs: ["e2"],
        historicalEvidenceRefs: [],
        unresolvedEvidenceRefs: [],
      },
    ]);
    expect(notebook.sources.map((source) => source.sourceId)).toEqual([
      "trip-japan",
      "trip-chicago",
    ]);
    const text = notebook.sources.map((source) => source.text).join("\n");
    expect(text).toContain("four days");
    expect(text).not.toContain("nine days");
  });

  test("keeps assistant-only context closed unless explicitly opened", () => {
    const requirement = {
      requirementId: "prior-answer",
      label: "prior assistant answer",
      searchText: "what assistant said",
      hits: [
        {
          sourceId: "session-1",
          evidenceRef: "assistant-1",
          content: "I previously recommended the train.",
          authority: "context_only" as const,
        },
      ],
    };
    expect(
      buildMemoryEvidenceNotebookV1({
        requirements: [requirement],
        allowedSourceIds: ["session-1"],
        maxHitsPerRequirement: 1,
        maxChars: 512,
      }).coverage[0]?.status,
    ).toBe("missing");
    expect(
      buildMemoryEvidenceNotebookV1({
        requirements: [requirement],
        allowedSourceIds: ["session-1"],
        maxHitsPerRequirement: 1,
        maxChars: 512,
        allowContextOnly: true,
      }).coverage[0]?.status,
    ).toBe("covered");
  });

  test("requires distinct episodes before convergent evidence is covered", () => {
    const baseRequirement = {
      requirementId: "exercise-preference",
      label: "exercise preference inferred from repeated behavior",
      searchText: "exercise activities repeatedly enjoyed",
      relation: "inferred" as const,
      coverageMode: "convergent" as const,
      minimumEvidence: 2,
      hits: [
        {
          sourceId: "session-a",
          evidenceRef: "a-1",
          content: "I really enjoyed the long trail run today.",
          authority: "user_asserted" as const,
          episodeOrder: 1,
          turnOrder: 1,
        },
        {
          sourceId: "session-a",
          evidenceRef: "a-2",
          content: "That trail run was enjoyable and fun.",
          authority: "user_asserted" as const,
          episodeOrder: 1,
          turnOrder: 3,
        },
      ],
    };
    const oneEpisode = buildMemoryEvidenceNotebookV1({
      requirements: [baseRequirement],
      allowedSourceIds: ["session-a"],
      maxHitsPerRequirement: 3,
      maxChars: 2_048,
    });

    expect(oneEpisode.coverage[0]?.status).toBe("partial");
    expect(oneEpisode.coverage[0]?.selectedHitCount).toBe(1);
    expect(oneEpisode.coverage[0]?.independentEvidenceCount).toBe(1);
    expect(oneEpisode.coverage[0]?.closureEvidenceCount).toBe(1);

    const twoEpisodes = buildMemoryEvidenceNotebookV1({
      requirements: [
        {
          ...baseRequirement,
          hits: [
            ...baseRequirement.hits,
            {
              sourceId: "session-b",
              evidenceRef: "b-1",
              content: "I chose another trail run and enjoyed it again.",
              authority: "user_asserted" as const,
              episodeOrder: 2,
              turnOrder: 2,
            },
          ],
        },
      ],
      allowedSourceIds: ["session-a", "session-b"],
      maxHitsPerRequirement: 3,
      maxChars: 2_048,
    });

    expect(twoEpisodes.coverage[0]?.status).toBe("covered");
    expect(twoEpisodes.coverage[0]?.selectedEvidenceRefs).toEqual([
      "a-1",
      "b-1",
    ]);
    expect(twoEpisodes.coverage[0]?.independentEvidenceCount).toBe(2);
    expect(twoEpisodes.coverage[0]?.closureEvidenceCount).toBe(2);
  });

  test("does not count one event restated across sessions twice", () => {
    const notebook = buildMemoryEvidenceNotebookV1({
      requirements: [
        {
          requirementId: "restated-event",
          label: "repeated activity preference",
          searchText: "activity enjoyed",
          relation: "inferred",
          coverageMode: "convergent",
          minimumEvidence: 2,
          hits: [
            {
              sourceId: "session-a",
              evidenceRef: "a",
              content: "I enjoyed the activity.",
              authority: "user_asserted",
              eventKey: "activity-42",
            },
            {
              sourceId: "session-b",
              evidenceRef: "b",
              content: "I later said that activity was enjoyable.",
              authority: "user_asserted",
              eventKey: "activity-42",
            },
          ],
        },
      ],
      allowedSourceIds: ["session-a", "session-b"],
      maxHitsPerRequirement: 2,
      maxChars: 2_048,
    });

    expect(notebook.coverage[0]?.status).toBe("partial");
    expect(notebook.coverage[0]?.closureEvidenceCount).toBe(1);
  });

  test("uses the same distinct-episode count while scanning and closing all-mode evidence", () => {
    const hits = [
      ...Array.from({ length: 3 }, (_, index) => ({
        sourceId: "session-a",
        evidenceRef: `same-episode-${index}`,
        content: `budget operand fact ${index}`,
        authority: "user_asserted" as const,
        episodeOrder: 1,
        turnOrder: index,
      })),
      {
        sourceId: "session-b",
        evidenceRef: "episode-b",
        content: "budget operand fact from another episode",
        authority: "user_asserted" as const,
        episodeOrder: 2,
      },
      {
        sourceId: "session-c",
        evidenceRef: "episode-c",
        content: "budget operand fact from a third episode",
        authority: "user_asserted" as const,
        episodeOrder: 3,
      },
    ];
    const notebook = buildMemoryEvidenceNotebookV1({
      requirements: [
        {
          requirementId: "all-operands",
          label: "all budget operands",
          searchText: "budget operand fact",
          coverageMode: "all",
          minimumEvidence: 3,
          hits,
        },
      ],
      allowedSourceIds: ["session-a", "session-b", "session-c"],
      maxHitsPerRequirement: 4,
      maxChars: 4_096,
    });

    expect(notebook.coverage[0]?.status).toBe("covered");
    expect(notebook.coverage[0]?.selectedEvidenceRefs).toEqual([
      "same-episode-0",
      "episode-b",
      "episode-c",
    ]);
    expect(notebook.coverage[0]?.closureEvidenceCount).toBe(3);
  });

  test("reserves notebook space so an early requirement cannot starve later ones", () => {
    const requirements = ["alpha", "beta", "gamma", "delta"].map(
      (name, index) => ({
        requirementId: name,
        label: `${name} fact`,
        searchText: `${name} answer`,
        minimumEvidence: 1,
        hits: Array.from({ length: index === 0 ? 2 : 1 }, (_, hitIndex) => ({
          sourceId: `${name}-session-${hitIndex}`,
          evidenceRef: `${name}-${hitIndex}`,
          content: `${name} answer ${"supporting detail ".repeat(80)}`,
          authority: "user_asserted" as const,
          episodeOrder: index * 10 + hitIndex,
        })),
      }),
    );
    const notebook = buildMemoryEvidenceNotebookV1({
      requirements,
      allowedSourceIds: requirements.flatMap((requirement) =>
        requirement.hits.map((hit) => hit.sourceId),
      ),
      maxHitsPerRequirement: 2,
      maxChars: 4_096,
    });

    expect(notebook.coverage.map((item) => item.status)).toEqual([
      "covered",
      "covered",
      "covered",
      "covered",
    ]);
    expect(notebook.chars).toBeLessThanOrEqual(4_096);
  });

  test("orders latest-state evidence by timestamp and monotonic source order", () => {
    const notebook = buildMemoryEvidenceNotebookV1({
      requirements: [
        {
          requirementId: "followers",
          label: "latest follower count",
          searchText: "Instagram follower count",
          selection: "latest",
          hits: [
            {
              sourceId: "older",
              evidenceRef: "old-ref",
              content: "I have 1,250 followers.",
              authority: "user_asserted",
              observedAt: "2023-05-25T00:00:00.000Z",
              observedOrder: 1,
            },
            {
              sourceId: "newer",
              evidenceRef: "new-ref",
              content: "I am close to 1,300 followers now.",
              authority: "user_asserted",
              observedAt: "2023-05-25T00:00:00.000Z",
              observedOrder: 2,
            },
            {
              sourceId: "irrelevant-later-turn",
              evidenceRef: "irrelevant-ref",
              content: "I will reach out to a collaborator tomorrow.",
              authority: "user_asserted",
              observedAt: "2023-05-25T00:00:00.000Z",
              observedOrder: 3,
            },
          ],
        },
      ],
      allowedSourceIds: ["older", "newer", "irrelevant-later-turn"],
      maxHitsPerRequirement: 2,
      maxChars: 1_024,
    });

    const newer = notebook.sources.find(
      (source) => source.sourceId === "newer",
    );
    expect(newer?.text).toContain("timeline=latest");
    expect(newer?.text).toContain("state=current");
    expect(newer?.text).toContain("relation=controls_current_answer");
    expect(newer?.text).toContain("precision=approximate");
    expect(notebook.sources.some((source) => source.sourceId === "older")).toBe(
      false,
    );
    expect(notebook.coverage[0]?.selectedEvidenceRefs).toEqual(["new-ref"]);
    expect(notebook.coverage[0]?.historicalEvidenceRefs).toEqual(["old-ref"]);
    expect(
      notebook.sources.some(
        (source) => source.sourceId === "irrelevant-later-turn",
      ),
    ).toBe(false);
  });

  test("keeps equal-time conflicting latest states unresolved", () => {
    const notebook = buildMemoryEvidenceNotebookV1({
      requirements: [
        {
          requirementId: "location",
          label: "latest location",
          searchText: "current location",
          selection: "latest",
          coverageMode: "latest",
          minimumEvidence: 1,
          hits: [
            {
              sourceId: "session-a",
              evidenceRef: "location-a",
              content: "My current location is Kyoto.",
              authority: "user_asserted",
              observedAt: "2026-08-27T00:00:00.000Z",
            },
            {
              sourceId: "session-b",
              evidenceRef: "location-b",
              content: "My current location is Osaka.",
              authority: "user_asserted",
              observedAt: "2026-08-27T00:00:00.000Z",
            },
          ],
        },
      ],
      allowedSourceIds: ["session-a", "session-b"],
      maxHitsPerRequirement: 2,
      maxChars: 2_048,
    });

    expect(notebook.coverage[0]?.status).toBe("partial");
    expect(notebook.coverage[0]?.unresolvedEvidenceRefs).toHaveLength(1);
    expect(
      notebook.sources.some((source) => source.answerRole === "ambiguous"),
    ).toBe(true);
  });

  test("renders shared evidence once without truncating the answer-bearing tail", () => {
    const shared = {
      sourceId: "game",
      evidenceRef: "game#assistant-4",
      content: `The game reached 27. Kg2 Bd5+. ${"continuation ".repeat(12)}The next move was 28. Kg3.`,
      authority: "context_only" as const,
    };
    const notebook = buildMemoryEvidenceNotebookV1({
      requirements: [
        {
          requirementId: "position",
          label: "chess position",
          searchText: "27. Kg2 Bd5+",
          hits: [shared],
        },
        {
          requirementId: "next-move",
          label: "next move",
          searchText: "move after 27. Kg2 Bd5+",
          hits: [shared],
        },
      ],
      allowedSourceIds: ["game"],
      maxHitsPerRequirement: 2,
      maxChars: 2_048,
      allowContextOnly: true,
    });

    expect(notebook.selectedHitCount).toBe(1);
    expect(notebook.coverage.map((item) => item.selectedHitCount)).toEqual([
      1, 1,
    ]);
    expect(notebook.sources[0]?.text).toContain("28. Kg3");
    expect(notebook.sources[0]?.evidenceRefs).toEqual(["game#assistant-4"]);
  });

  test("reduces latest state from a bounded projection of long immutable L0", () => {
    const notebook = buildMemoryEvidenceNotebookV1({
      requirements: [
        {
          requirementId: "current-location",
          label: "current location",
          searchText: "current location Kyoto",
          selection: "latest",
          hits: [
            {
              sourceId: "long-session",
              evidenceRef: "long-session#turn-12",
              content: `${"background detail ".repeat(700)}My current location is Kyoto. ${"tail ".repeat(20)}`,
              authority: "user_asserted",
              observedAt: "2026-08-27T00:00:00.000Z",
              observedOrder: 12,
            },
          ],
        },
      ],
      allowedSourceIds: ["long-session"],
      maxHitsPerRequirement: 1,
      maxChars: 4_096,
    });

    expect(notebook.coverage[0]?.status).toBe("covered");
    expect(notebook.sources[0]?.text).toContain("Kyoto");
  });
});
