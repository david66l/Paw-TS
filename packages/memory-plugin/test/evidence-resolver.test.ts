import { describe, expect, test } from "bun:test";

import {
  type MemoryEvidenceIndexV1,
  createMemoryEvidenceResolverV1,
} from "../src/index.js";

function index(): MemoryEvidenceIndexV1 {
  return {
    indexVersion: "test-index.v1",
    async search(query) {
      const supplemental = query.includes("focused");
      const candidates = supplemental
        ? [
            ["c", "ref-c"],
            ["b", "ref-b-focused"],
          ]
        : [
            ["a", "ref-a"],
            ["b", "ref-b"],
          ];
      return {
        lists: [
          {
            channel: "l0",
            retrieverId: "test",
            weight: 1,
            candidates: candidates.map(([sourceId, evidenceRef]) => ({
              candidateId: evidenceRef!,
              sourceId: sourceId!,
              evidenceRef: evidenceRef!,
              sourceKind: "user_input",
              authority: "user_asserted",
            })),
          },
        ],
        hits: candidates.map(([sourceId, evidenceRef]) => ({
          sourceId: sourceId!,
          evidenceRef: evidenceRef!,
          content: `${query} evidence in ${sourceId}`,
          authority: "user_asserted",
        })),
      };
    },
  };
}

describe("shared evidence resolver v1", () => {
  test("locks sources only after bounded planned discovery", async () => {
    const resolver = createMemoryEvidenceResolverV1({
      index: index(),
      planner: {
        plannerVersion:
          "paw.memory-evidence-query-planner.v6:typed-evidence-closure",
        async plan() {
          return {
            plannerVersion:
              "paw.memory-evidence-query-planner.v6:typed-evidence-closure",
            answerShape: "aggregate",
            temporalMode: "any",
            roleConstraint: "user",
            needsPlanning: true,
            requirements: [
              {
                requirementId: "focused",
                label: "focused evidence",
                searchText: "focused clue",
                temporalMode: "any",
                roleConstraint: "user",
              },
            ],
          };
        },
      },
      maxSources: 3,
    });

    const result = await resolver.resolve(
      "How many items are there?",
      new AbortController().signal,
    );

    expect(result.sources.map((source) => source.sourceId)).toEqual([
      "b",
      "a",
      "c",
    ]);
    expect(result.notebook.sources.map((source) => source.sourceId)).toEqual([
      "c",
      "b",
    ]);
    expect(result.packetSources.map((source) => source.sourceId)).toEqual([
      "b",
      "a",
      "c",
    ]);
    expect(result.packetSources.some((source) => source.sourceId === "c")).toBe(
      true,
    );
  });

  test("uses primary exact hits for deterministic lookups", async () => {
    const resolver = createMemoryEvidenceResolverV1({ index: index() });
    const result = await resolver.resolve(
      "Which city did I visit?",
      new AbortController().signal,
    );
    expect(result.plannerStatus).toBe("not_needed");
    expect(result.directCertificateStatus).toBe("missing");
    expect(result.notebook.coverage).toHaveLength(0);
    expect(result.primaryHits).toHaveLength(2);
    expect(result.packetSources).toHaveLength(2);
    expect(result.packetSources[0]?.text).toContain(
      "Primary exact memory evidence",
    );
  });

  test("plans an ambiguous simple lookup only when primary discovery spans sources", async () => {
    const forceValues: Array<boolean | undefined> = [];
    const planner = {
      plannerVersion:
        "paw.memory-evidence-query-planner.v6:typed-evidence-closure" as const,
      async plan(
        _query: string,
        _signal: AbortSignal,
        options?: Readonly<{ force?: boolean }>,
      ) {
        forceValues.push(options?.force);
        return {
          plannerVersion:
            "paw.memory-evidence-query-planner.v6:typed-evidence-closure" as const,
          answerShape: "lookup" as const,
          temporalMode: "any" as const,
          roleConstraint: "user" as const,
          needsPlanning: false,
          requirements: [
            {
              requirementId: "city",
              label: "city explicitly visited",
              searchText: "city visited trip",
              temporalMode: "any" as const,
              roleConstraint: "user" as const,
              relation: "direct" as const,
              coverageMode: "any" as const,
              minimumEvidence: 1,
            },
          ],
        };
      },
    };
    const multiSource = createMemoryEvidenceResolverV1({
      index: index(),
      planner,
    });
    const multiResult = await multiSource.resolve(
      "Which city did I visit?",
      new AbortController().signal,
    );

    expect(forceValues).toEqual([true]);
    expect(multiResult.plannerStatus).toBe("completed");

    const singleSource = createMemoryEvidenceResolverV1({
      planner,
      index: {
        indexVersion: "single-source.v1",
        async search(query) {
          return {
            lists: [
              {
                channel: "l0" as const,
                retrieverId: "single",
                weight: 1,
                candidates: [
                  {
                    candidateId: "one-ref",
                    sourceId: "one-source",
                    evidenceRef: "one-ref",
                    sourceKind: "user_input" as const,
                    authority: "user_asserted" as const,
                  },
                ],
              },
            ],
            hits: [
              {
                sourceId: "one-source",
                evidenceRef: "one-ref",
                content: `${query} Paris`,
                authority: "user_asserted" as const,
              },
            ],
          };
        },
      },
    });
    const singleResult = await singleSource.resolve(
      "Which city did I visit?",
      new AbortController().signal,
    );

    expect(forceValues).toEqual([true]);
    expect(singleResult.plannerStatus).toBe("not_needed");
    expect(singleResult.directCertificateStatus).toBe("deterministic_direct");
  });

  test("plans when primary discovery returns no direct evidence", async () => {
    let plannerCalls = 0;
    const resolver = createMemoryEvidenceResolverV1({
      index: {
        indexVersion: "empty-primary.v1",
        async search() {
          return { lists: [], hits: [] };
        },
      },
      planner: {
        plannerVersion:
          "paw.memory-evidence-query-planner.v6:typed-evidence-closure",
        async plan() {
          plannerCalls += 1;
          return {
            plannerVersion:
              "paw.memory-evidence-query-planner.v6:typed-evidence-closure",
            answerShape: "lookup",
            temporalMode: "any",
            roleConstraint: "user",
            needsPlanning: false,
            requirements: [
              {
                requirementId: "city",
                label: "city visited",
                searchText: "travel destination city name",
                temporalMode: "any",
                roleConstraint: "user",
                relation: "direct",
                coverageMode: "any",
                minimumEvidence: 1,
              },
            ],
          } as const;
        },
      },
    });

    const result = await resolver.resolve(
      "Which city did I visit?",
      new AbortController().signal,
    );

    expect(plannerCalls).toBe(1);
    expect(result.plannerStatus).toBe("completed");
    expect(result.directCertificateStatus).toBe("missing");
  });

  test("treats an empty complex plan as fallback instead of completed", async () => {
    const resolver = createMemoryEvidenceResolverV1({
      index: index(),
      planner: {
        plannerVersion:
          "paw.memory-evidence-query-planner.v6:typed-evidence-closure",
        async plan() {
          return {
            plannerVersion:
              "paw.memory-evidence-query-planner.v6:typed-evidence-closure",
            answerShape: "aggregate",
            temporalMode: "any",
            roleConstraint: "user",
            needsPlanning: true,
            requirements: [],
          } as const;
        },
      },
      supportSelector: {
        selectorVersion: "test-support-selector.v1",
        async select(input) {
          return {
            selectorVersion: "test-support-selector.v1",
            selectionRevision: "root-after-empty-plan",
            assessments: [
              {
                requirementId: input.requirements[0]!.requirementId,
                supportingEvidenceRefs: ["ref-a"],
                contradictingEvidenceRefs: [],
                unknownEvidenceRefs: [],
              },
            ],
          };
        },
      },
    });

    const result = await resolver.resolve(
      "How many items are there?",
      new AbortController().signal,
    );

    expect(result.plannerStatus).toBe("fallback");
    expect(result.requirements[0]?.requirementId).toBe("root-requirement");
  });

  test("creates a root requirement for a multi-source lookup", async () => {
    let selectedRequirementId = "";
    const resolver = createMemoryEvidenceResolverV1({
      index: index(),
      supportSelector: {
        selectorVersion: "test-support-selector.v1",
        async select(input) {
          selectedRequirementId = input.requirements[0]?.requirementId ?? "";
          return {
            selectorVersion: "test-support-selector.v1",
            selectionRevision: "root-support-revision",
            assessments: [
              {
                requirementId: selectedRequirementId,
                supportingEvidenceRefs: ["ref-a"],
                contradictingEvidenceRefs: [],
                unknownEvidenceRefs: [],
              },
            ],
          };
        },
      },
    });

    const result = await resolver.resolve(
      "Which city did I visit?",
      new AbortController().signal,
    );

    expect(selectedRequirementId).toBe("root-requirement");
    expect(result.plannerStatus).toBe("not_needed");
    expect(result.supportSelectorStatus).toBe("completed");
    expect(result.packetSources.map((source) => source.sourceId)).toEqual([
      "a",
      "b",
    ]);
    expect(result.packetSources[1]?.answerRole).toBe("candidate");
  });

  test("retains enough exact addresses to hydrate a selected source", async () => {
    const candidates = Array.from({ length: 8 }, (_, index) => ({
      candidateId: `turn-${index + 1}`,
      sourceId: "session-1",
      evidenceRef: `session-1#turn-${index + 1}`,
      sourceKind: "source_span" as const,
      authority: "user_asserted" as const,
    }));
    const resolver = createMemoryEvidenceResolverV1({
      index: {
        indexVersion: "test-index.v1",
        async search() {
          return {
            lists: [
              {
                channel: "l0" as const,
                retrieverId: "turn-index",
                weight: 1,
                candidates,
              },
            ],
            hits: [],
          };
        },
      },
      maxEvidencePerSource: 8,
    });

    const result = await resolver.resolve(
      "Which detail did I mention?",
      new AbortController().signal,
    );

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]?.evidence).toHaveLength(8);
  });

  test("binds each planned requirement to support-selected addresses", async () => {
    const resolver = createMemoryEvidenceResolverV1({
      index: index(),
      planner: {
        plannerVersion:
          "paw.memory-evidence-query-planner.v6:typed-evidence-closure",
        async plan() {
          return {
            plannerVersion:
              "paw.memory-evidence-query-planner.v6:typed-evidence-closure",
            answerShape: "aggregate",
            temporalMode: "any",
            roleConstraint: "user",
            needsPlanning: true,
            requirements: [
              {
                requirementId: "focused",
                label: "focused evidence",
                searchText: "focused clue",
                temporalMode: "any",
                roleConstraint: "user",
              },
            ],
          } as const;
        },
      },
      supportSelector: {
        selectorVersion: "test-support-selector.v1",
        async select() {
          return {
            selectorVersion: "test-support-selector.v1",
            selectionRevision: "support-revision",
            assessments: [
              {
                requirementId: "focused",
                supportingEvidenceRefs: ["ref-b-focused"],
                contradictingEvidenceRefs: [],
                unknownEvidenceRefs: [],
              },
            ],
          };
        },
      },
      maxSources: 2,
    });

    const result = await resolver.resolve(
      "How many items are there?",
      new AbortController().signal,
    );

    expect(result.supportSelectorStatus).toBe("completed");
    expect(result.notebook.coverage[0]?.selectedEvidenceRefs).toEqual([
      "ref-b-focused",
    ]);
    expect(result.notebook.sources.map((source) => source.sourceId)).toEqual([
      "b",
    ]);
    expect(
      result.packetSources.find((source) => source.sourceId === "a")
        ?.answerRole,
    ).toBe("candidate");
    expect(result.notebook.coverage[0]?.selectedEvidenceRefs).not.toContain(
      "ref-a",
    );
  });

  test("keeps bounded candidates when latest-state support is still missing", async () => {
    const resolver = createMemoryEvidenceResolverV1({
      index: index(),
      planner: {
        plannerVersion:
          "paw.memory-evidence-query-planner.v6:typed-evidence-closure",
        async plan() {
          return {
            plannerVersion:
              "paw.memory-evidence-query-planner.v6:typed-evidence-closure",
            answerShape: "lookup",
            temporalMode: "latest",
            roleConstraint: "user",
            needsPlanning: true,
            requirements: [
              {
                requirementId: "current-city",
                label: "current city",
                searchText: "current city location",
                temporalMode: "latest",
                roleConstraint: "user",
                relation: "temporal",
                coverageMode: "latest",
                minimumEvidence: 1,
              },
            ],
          } as const;
        },
      },
      supportSelector: {
        selectorVersion: "test-support-selector.v1",
        async select() {
          return {
            selectorVersion: "test-support-selector.v1",
            selectionRevision: "missing-latest-revision",
            assessments: [
              {
                requirementId: "current-city",
                supportingEvidenceRefs: [],
                contradictingEvidenceRefs: [],
                unknownEvidenceRefs: [],
              },
            ],
          };
        },
      },
    });

    const result = await resolver.resolve(
      "What is my current city?",
      new AbortController().signal,
    );

    expect(result.notebook.coverage[0]?.status).toBe("missing");
    expect(result.packetSources.length).toBeGreaterThan(0);
    expect(result.packetSources[0]?.answerRole).toBe("candidate");
    expect(result.packetSources[0]?.text).toContain(
      "Primary exact memory evidence",
    );
  });

  test("keeps ordinal-matched L0 as an unverified fallback when semantic selection misses it", async () => {
    const requirement = {
      requirementId: "ordinal-item",
      label: "27th parameter",
      searchText: "27th parameter",
      temporalMode: "any" as const,
      roleConstraint: "assistant" as const,
    };
    const resolver = createMemoryEvidenceResolverV1({
      index: {
        indexVersion: "test-index.v1",
        async search() {
          return {
            lists: [
              {
                channel: "l0" as const,
                retrieverId: "turn-index",
                weight: 1,
                candidates: [
                  {
                    candidateId: "user-turn",
                    sourceId: "session",
                    evidenceRef: "session#user-1",
                    sourceKind: "user_input" as const,
                    authority: "user_asserted" as const,
                  },
                  {
                    candidateId: "assistant-turn",
                    sourceId: "session",
                    evidenceRef: "session#assistant-2",
                    sourceKind: "assistant_output" as const,
                    authority: "context_only" as const,
                  },
                ],
              },
            ],
            hits: [
              {
                sourceId: "session",
                evidenceRef: "session#user-1",
                content: "Give me a numbered list of 100 prompt parameters.",
                authority: "user_asserted" as const,
                turnOrder: 1,
              },
              {
                sourceId: "session",
                evidenceRef: "session#assistant-2",
                content: "26. Soliloquy\n27. Sound effects\n28. Music",
                authority: "context_only" as const,
                turnOrder: 2,
              },
            ],
          };
        },
      },
      planner: {
        plannerVersion:
          "paw.memory-evidence-query-planner.v6:typed-evidence-closure",
        async plan() {
          return {
            plannerVersion:
              "paw.memory-evidence-query-planner.v6:typed-evidence-closure",
            answerShape: "lookup" as const,
            temporalMode: "any" as const,
            roleConstraint: "assistant" as const,
            needsPlanning: true,
            requirements: [requirement],
          };
        },
      },
      supportSelector: {
        selectorVersion: "test-support-selector.v1",
        async select() {
          return {
            selectorVersion: "test-support-selector.v1",
            selectionRevision: "semantic-miss-revision",
            assessments: [
              {
                requirementId: requirement.requirementId,
                supportingEvidenceRefs: ["session#user-1"],
                contradictingEvidenceRefs: [],
                unknownEvidenceRefs: [],
              },
            ],
          };
        },
      },
    });

    const result = await resolver.resolve(
      "Can you remind me what was the 27th parameter on the list you provided?",
      new AbortController().signal,
    );

    expect(result.notebook.coverage[0]?.selectedEvidenceRefs).toEqual([
      "session#user-1",
    ]);
    expect(result.packetSources[0]?.answerRole).toBe("mixed");
    expect(result.packetSources[0]?.text).toContain("Bounded primary fallback");
    expect(result.packetSources[0]?.text).toContain("27. Sound effects");
  });
});
