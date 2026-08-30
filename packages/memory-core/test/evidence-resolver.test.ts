import { describe, expect, test } from "bun:test";

import { hashTextV1 } from "../src/canonical.js";
import {
  type MemoryEvidenceIndexV1,
  createJsonMemoryEvidenceSupportSelectorV1,
  createMemoryEvidenceResolverV1,
  projectEvidenceFirstMemoryAnswerContractV1,
  projectEvidenceFirstMemoryContextPacketV1,
} from "../src/legacy.js";

function requiredAt<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined)
    throw new Error(`Missing test value at index ${index}`);
  return value;
}

function sourceLocalHydrator(contents: Readonly<Record<string, string>>) {
  return {
    hydratorVersion: "test-source-local-hydrator.v1",
    async hydrate(evidenceRefs: readonly string[]) {
      return evidenceRefs.flatMap((evidenceRef) => {
        const content = contents[evidenceRef];
        const turnOrder = Number(/turn-(\d+)$/.exec(evidenceRef)?.[1]);
        return content === undefined
          ? []
          : [
              {
                evidenceRef,
                sourceKind:
                  turnOrder % 2 === 0
                    ? ("assistant_output" as const)
                    : ("user_input" as const),
                turnOrder,
                content,
                contentHash: hashTextV1(content),
              },
            ];
      });
    },
  };
}

function index(): MemoryEvidenceIndexV1 {
  return {
    indexVersion: "test-index.v1",
    async search(query) {
      const supplemental = query.includes("focused");
      const candidates: readonly (readonly [string, string])[] = supplemental
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
              candidateId: evidenceRef,
              sourceId,
              evidenceRef,
              sourceKind: "user_input",
              authority: "user_asserted",
            })),
          },
        ],
        hits: candidates.map(([sourceId, evidenceRef]) => ({
          sourceId,
          evidenceRef,
          content: `${query} evidence in ${sourceId}`,
          authority: "user_asserted",
        })),
      };
    },
  };
}

describe("shared evidence resolver v1", () => {
  test("filters assistant-only candidates before locking sources for user facts", async () => {
    const resolver = createMemoryEvidenceResolverV1({
      index: {
        indexVersion: "test-index.v1",
        async search() {
          return {
            lists: [
              {
                channel: "l0" as const,
                retrieverId: "global",
                weight: 1,
                candidates: [
                  {
                    candidateId: "assistant-ref",
                    sourceId: "assistant-session",
                    evidenceRef: "assistant-session#turn-2",
                    sourceKind: "assistant_output" as const,
                    authority: "context_only" as const,
                  },
                  {
                    candidateId: "user-ref",
                    sourceId: "user-session",
                    evidenceRef: "user-session#turn-1",
                    sourceKind: "user_input" as const,
                    authority: "user_asserted" as const,
                  },
                ],
              },
            ],
            hits: [
              {
                sourceId: "assistant-session",
                evidenceRef: "assistant-session#turn-2",
                content: "assistant invented city",
                authority: "context_only" as const,
              },
              {
                sourceId: "user-session",
                evidenceRef: "user-session#turn-1",
                content: "I visited Porto.",
                authority: "user_asserted" as const,
              },
            ],
          };
        },
      },
      maxSources: 1,
    });

    const result = await resolver.resolve(
      "Which city did I visit?",
      new AbortController().signal,
    );

    expect(result.intent.roleConstraint).toBe("user");
    expect(result.sources.map((source) => source.sourceId)).toEqual([
      "user-session",
    ]);
    expect(
      result.packetSources.map((source) => source.text).join("\n"),
    ).not.toContain("assistant invented city");
  });

  test("keeps explicit user-origin history closed even beside an assistant repetition", async () => {
    let locatorCalls = 0;
    const resolver = createMemoryEvidenceResolverV1({
      index: {
        indexVersion: "test-index.v1",
        async search() {
          return {
            lists: [
              {
                channel: "l0" as const,
                retrieverId: "global",
                weight: 1,
                candidates: [
                  {
                    candidateId: "user-ref",
                    sourceId: "session",
                    evidenceRef: "session#turn-1",
                    sourceKind: "user_input" as const,
                    authority: "user_asserted" as const,
                  },
                  {
                    candidateId: "assistant-ref",
                    sourceId: "session",
                    evidenceRef: "session#turn-2",
                    sourceKind: "assistant_output" as const,
                    authority: "context_only" as const,
                  },
                ],
              },
            ],
            hits: [
              {
                sourceId: "session",
                evidenceRef: "session#turn-1",
                content: "I said I visited Porto.",
                authority: "user_asserted" as const,
                turnOrder: 1,
              },
              {
                sourceId: "session",
                evidenceRef: "session#turn-2",
                content: "You visited a different invented city.",
                authority: "context_only" as const,
                turnOrder: 2,
              },
            ],
          };
        },
      },
      sourceLocalLocator: {
        locatorVersion: "test-source-local.v1",
        async locate() {
          locatorCalls += 1;
          throw new Error("must not be called for an explicit user fact");
        },
      },
      sourceLocalHydrator: sourceLocalHydrator({}),
      supportSelector: {
        selectorVersion: "test-selector.v1",
        async select(input) {
          expect(
            input.candidates.map((candidate) => candidate.evidenceRef),
          ).toEqual(["session#turn-1"]);
          return {
            selectorVersion: "test-selector.v1",
            selectionRevision: "user-origin-selection",
            assessments: input.requirements.map((requirement) => ({
              requirementId: requirement.requirementId,
              supportingEvidenceRefs: ["session#turn-1"],
              contradictingEvidenceRefs: [],
              unknownEvidenceRefs: [],
            })),
          };
        },
      },
    });

    const result = await resolver.resolve(
      "What city did I say I visited in our last conversation?",
      new AbortController().signal,
    );

    expect(result.intent.roleConstraint).toBe("user");
    expect(locatorCalls).toBe(0);
    expect(
      result.packetSources.map((source) => source.text).join("\n"),
    ).toContain("Porto");
    expect(
      result.packetSources.map((source) => source.text).join("\n"),
    ).not.toContain("invented city");
  });

  test("opens a certified assistant candidate without weakening primary user authority", async () => {
    let locatorCalls = 0;
    const resolver = createMemoryEvidenceResolverV1({
      index: {
        indexVersion: "test-index.v1",
        evidenceRefBelongsToSource(sourceId, evidenceRef) {
          const match = /^amb:document\/(.+?)#/.exec(evidenceRef);
          return match?.[1] === sourceId;
        },
        async search() {
          return {
            lists: [
              {
                channel: "l1" as const,
                retrieverId: "primary-derived",
                weight: 1.1,
                candidates: [
                  {
                    candidateId: "user-ref",
                    sourceId: "user-source",
                    evidenceRef: "amb:document/user-source#derived-1",
                    sourceKind: "derived_atom" as const,
                    authority: "derived" as const,
                  },
                ],
              },
              {
                channel: "l0" as const,
                retrieverId: "dialogue-source-discovery",
                weight: 1,
                candidates: [
                  {
                    candidateId: "cross-source-duplicate-ref",
                    sourceId: "escape-source",
                    evidenceRef: "amb:document/assistant-source#source-2",
                    sourceKind: "assistant_output" as const,
                    authority: "context_only" as const,
                  },
                  {
                    candidateId: "mismatched-ref-family",
                    sourceId: "family-escape-source",
                    evidenceRef: "amb:document/different-source#source-2",
                    sourceKind: "assistant_output" as const,
                    authority: "context_only" as const,
                  },
                  {
                    candidateId: "assistant-source-request",
                    sourceId: "assistant-source",
                    evidenceRef: "amb:document/assistant-source#source-1",
                    sourceKind: "user_input" as const,
                    authority: "user_asserted" as const,
                  },
                  {
                    candidateId: "assistant-source-uncertified",
                    sourceId: "assistant-source",
                    evidenceRef: "amb:document/assistant-source#source-4",
                    sourceKind: "assistant_output" as const,
                    authority: "context_only" as const,
                  },
                ],
              },
            ],
            hits: [
              {
                sourceId: "user-source",
                evidenceRef: "user-source#turn-1",
                content: "The user-side discovery stays authoritative.",
                authority: "user_asserted" as const,
                turnOrder: 1,
              },
              {
                sourceId: "assistant-source",
                evidenceRef: "assistant-source#turn-2",
                content: "Untrusted index projection of an assistant answer.",
                authority: "context_only" as const,
                sourceKind: "assistant_output" as const,
                turnOrder: 2,
              },
              {
                sourceId: "assistant-source",
                evidenceRef: "assistant-source#turn-4",
                content: "Uncertified assistant decoy.",
                authority: "context_only" as const,
                sourceKind: "assistant_output" as const,
                turnOrder: 4,
              },
              {
                sourceId: "escape-source",
                evidenceRef: "assistant-source#turn-2",
                content: "A duplicate ref must not authorize this source.",
                authority: "context_only" as const,
                turnOrder: 2,
              },
              {
                sourceId: "family-escape-source",
                evidenceRef: "different-source#turn-2",
                content: "A mismatched ref family must remain closed.",
                authority: "context_only" as const,
                turnOrder: 2,
              },
            ],
          };
        },
      },
      maxSources: 1,
      sourceLocalLocator: {
        locatorVersion: "test-source-local.v1",
        async locate(request) {
          locatorCalls += 1;
          expect(request.requirement.roleConstraint).toBe("user");
          expect(request.assistantDialogueCandidate).toBe(true);
          expect(request.lockedSourceIds).toEqual([
            "user-source",
            "assistant-source",
          ]);
          const content = "The proposed label was Northstar.";
          return {
            locatorVersion: "test-source-local.v1",
            locatorRevision: "certified-dialogue-candidate",
            hits: [
              {
                sourceId: "assistant-source",
                evidenceRef: "assistant-source#turn-2",
                anchorEvidenceRef: "assistant-source#turn-2",
                contextEvidenceRefs: [
                  "assistant-source#turn-1",
                  "assistant-source#turn-2",
                ],
                sourceKind: "assistant_output" as const,
                content,
                authority: "context_only" as const,
                turnOrder: 2,
                includedTurns: [
                  {
                    evidenceRef: "assistant-source#turn-1",
                    sourceKind: "user_input" as const,
                    turnOrder: 1,
                  },
                  {
                    evidenceRef: "assistant-source#turn-2",
                    sourceKind: "assistant_output" as const,
                    turnOrder: 2,
                  },
                ],
              },
            ],
            degradedChannels: [] as const,
            telemetry: {
              lexicalCandidates: 1,
              denseCandidates: 1,
              anchorCount: 1,
              includedTurnCount: 2,
              renderedChars: content.length,
              cacheHit: false,
              durationMs: 1,
            },
          };
        },
      },
      sourceLocalHydrator: sourceLocalHydrator({
        "assistant-source#turn-1": "Please propose a label for the plan.",
        "assistant-source#turn-2": "The proposed label was Northstar.",
      }),
      supportSelector: createJsonMemoryEvidenceSupportSelectorV1({
        model: {
          async complete(request) {
            const payload = JSON.parse(request.user) as {
              requirements: Array<{
                requirementId: string;
                roleConstraint: string;
                certifiedAssistantDialogueCandidate: boolean;
              }>;
              candidates: Array<{
                evidenceRef: string;
                sourceKind: string;
                certifiedAssistantDialogue: boolean;
              }>;
            };
            expect(payload.requirements).toHaveLength(1);
            expect(payload.requirements[0]).toMatchObject({
              roleConstraint: "user",
              certifiedAssistantDialogueCandidate: true,
            });
            const certified = payload.candidates.find(
              (candidate) => candidate.certifiedAssistantDialogue,
            );
            expect(certified).toMatchObject({
              sourceKind: "assistant_output",
            });
            return {
              status: "completed" as const,
              text: JSON.stringify({
                assessments: [
                  {
                    requirementId: payload.requirements[0]?.requirementId,
                    supportingEvidenceRefs: [certified?.evidenceRef],
                    contradictingEvidenceRefs: [],
                    unknownEvidenceRefs: [],
                  },
                ],
              }),
            };
          },
        },
      }),
    });

    const result = await resolver.resolve(
      "What amount was in the plan from our previous conversation?",
      new AbortController().signal,
    );

    expect(result.intent.roleConstraint).toBe("user");
    expect(locatorCalls).toBe(1);
    expect(result.sources.map((source) => source.sourceId)).toEqual([
      "user-source",
    ]);
    expect(result.sourceLocalization).toMatchObject({
      status: "completed",
      selectedCandidateCount: 1,
    });
    expect(
      result.packetSources.map((source) => source.text).join("\n"),
    ).toContain("Northstar");
    expect(
      result.packetSources.flatMap((source) => source.evidenceBindings),
    ).toContainEqual({
      evidenceRef: "assistant-source#turn-2",
      evidenceUse: "shared_dialogue_artifact",
    });
    expect(
      result.packetSources.flatMap((source) => source.evidenceBindings),
    ).not.toContainEqual({
      evidenceRef: "assistant-source#turn-4",
      evidenceUse: "shared_dialogue_artifact",
    });
    const expectedBindings = result.packetSources.flatMap(
      (source) => source.evidenceBindings,
    );
    expect(
      projectEvidenceFirstMemoryContextPacketV1(result).evidence.flatMap(
        (evidence) => evidence.evidenceBindings ?? [],
      ),
    ).toEqual(expectedBindings);
    expect(
      projectEvidenceFirstMemoryAnswerContractV1(result).evidenceBindings,
    ).toEqual(expectedBindings);
  });

  test("rejects requirement authority drift from a custom planner port", async () => {
    let locatedRole = "";
    const resolver = createMemoryEvidenceResolverV1({
      index: index(),
      planner: {
        plannerVersion:
          "paw.memory-evidence-query-planner.v10:certified-dialogue-candidate",
        async plan() {
          return {
            plannerVersion:
              "paw.memory-evidence-query-planner.v10:certified-dialogue-candidate",
            answerShape: "lookup" as const,
            temporalMode: "any" as const,
            roleConstraint: "any" as const,
            needsPlanning: true,
            requirements: [
              {
                requirementId: "drifted",
                label: "drifted authority",
                searchText: "prior assistant output",
                temporalMode: "any" as const,
                roleConstraint: "assistant" as const,
                relation: "direct" as const,
                coverageMode: "any" as const,
                minimumEvidence: 1,
              },
            ],
          };
        },
      },
      sourceLocalLocator: {
        locatorVersion: "test-source-local.v1",
        async locate(request) {
          locatedRole = request.requirement.roleConstraint;
          return {
            locatorVersion: "test-source-local.v1",
            locatorRevision: "empty",
            hits: [],
            degradedChannels: [] as const,
            telemetry: {
              lexicalCandidates: 0,
              denseCandidates: 0,
              anchorCount: 0,
              includedTurnCount: 0,
              renderedChars: 0,
              cacheHit: false,
              durationMs: 0,
            },
          };
        },
      },
      sourceLocalHydrator: sourceLocalHydrator({}),
      supportSelector: {
        selectorVersion: "test-selector.v1",
        async select(input) {
          return {
            selectorVersion: "test-selector.v1",
            selectionRevision: "root-selection",
            assessments: input.requirements.map((requirement) => ({
              requirementId: requirement.requirementId,
              supportingEvidenceRefs: [],
              contradictingEvidenceRefs: [],
              unknownEvidenceRefs: [],
            })),
          };
        },
      },
    });

    const result = await resolver.resolve(
      "Could you repeat the item from our earlier conversation?",
      new AbortController().signal,
    );

    expect(result.plannerStatus).toBe("fallback");
    expect(result.requirements[0]?.requirementId).toBe("root-requirement");
    expect(result.requirements[0]?.roleConstraint).toBe("any");
    expect(locatedRole).toBe("any");
  });

  test("fails closed when a custom selector omits a requirement", async () => {
    const requirements = ["first", "second"].map((requirementId) => ({
      requirementId,
      label: requirementId,
      searchText: `${requirementId} earlier item`,
      temporalMode: "any" as const,
      roleConstraint: "any" as const,
      relation: "direct" as const,
      coverageMode: "any" as const,
      minimumEvidence: 1,
    }));
    const resolver = createMemoryEvidenceResolverV1({
      index: index(),
      planner: {
        plannerVersion:
          "paw.memory-evidence-query-planner.v10:certified-dialogue-candidate",
        async plan() {
          return {
            plannerVersion:
              "paw.memory-evidence-query-planner.v10:certified-dialogue-candidate",
            answerShape: "lookup" as const,
            temporalMode: "any" as const,
            roleConstraint: "any" as const,
            needsPlanning: true,
            requirements,
          };
        },
      },
      supportSelector: {
        selectorVersion: "broken-selector.v1",
        async select(input) {
          return {
            selectorVersion: "broken-selector.v1",
            selectionRevision: "missing-assessment",
            assessments: [
              {
                requirementId: requiredAt(input.requirements, 0).requirementId,
                supportingEvidenceRefs: [
                  requiredAt(input.candidates, 0).evidenceRef,
                ],
                contradictingEvidenceRefs: [],
                unknownEvidenceRefs: [],
              },
            ],
          };
        },
      },
    });

    const result = await resolver.resolve(
      "Could you repeat the two items from our earlier conversation?",
      new AbortController().signal,
    );

    expect(result.supportSelectorStatus).toBe("fallback");
    expect(result.supportAssessments).toEqual([]);
    expect(result.notebook.coverage.map((item) => item.status)).toEqual([
      "missing",
      "missing",
    ]);
    expect(result.packetSources.length).toBeGreaterThan(0);
    expect(
      result.packetSources.every((source) => source.answerRole === "candidate"),
    ).toBe(true);
  });

  test("does not let a selector promote uncertified assistant context for any", async () => {
    const requirement = {
      requirementId: "shared-item",
      label: "shared dialogue item",
      searchText: "item from earlier conversation",
      temporalMode: "any" as const,
      roleConstraint: "any" as const,
      relation: "direct" as const,
      coverageMode: "any" as const,
      minimumEvidence: 1,
    };
    const resolver = createMemoryEvidenceResolverV1({
      index: {
        indexVersion: "test-index.v1",
        async search() {
          return {
            lists: [
              {
                channel: "l0" as const,
                retrieverId: "global",
                weight: 1,
                candidates: [
                  {
                    candidateId: "user-ref",
                    sourceId: "session",
                    evidenceRef: "session#turn-1",
                    sourceKind: "user_input" as const,
                    authority: "user_asserted" as const,
                  },
                  {
                    candidateId: "assistant-ref",
                    sourceId: "session",
                    evidenceRef: "session#turn-2",
                    sourceKind: "assistant_output" as const,
                    authority: "context_only" as const,
                  },
                ],
              },
            ],
            hits: [
              {
                sourceId: "session",
                evidenceRef: "session#turn-1",
                content: "Please create a name.",
                authority: "user_asserted" as const,
                turnOrder: 1,
              },
              {
                sourceId: "session",
                evidenceRef: "session#turn-2",
                content: "uncertified assistant name",
                authority: "context_only" as const,
                turnOrder: 2,
              },
            ],
          };
        },
      },
      planner: {
        plannerVersion:
          "paw.memory-evidence-query-planner.v10:certified-dialogue-candidate",
        async plan() {
          return {
            plannerVersion:
              "paw.memory-evidence-query-planner.v10:certified-dialogue-candidate",
            answerShape: "lookup" as const,
            temporalMode: "any" as const,
            roleConstraint: "any" as const,
            needsPlanning: true,
            requirements: [requirement],
          };
        },
      },
      supportSelector: {
        selectorVersion: "test-selector.v1",
        async select() {
          return {
            selectorVersion: "test-selector.v1",
            selectionRevision: "wrong-assistant-selection",
            assessments: [
              {
                requirementId: requirement.requirementId,
                supportingEvidenceRefs: ["session#turn-2"],
                contradictingEvidenceRefs: [],
                unknownEvidenceRefs: [],
              },
            ],
          };
        },
      },
    });

    const result = await resolver.resolve(
      "Could you repeat the item from our earlier conversation?",
      new AbortController().signal,
    );
    expect(result.supportSelectorStatus).toBe("completed");
    expect(result.notebook.coverage[0]?.status).toBe("missing");
    expect(result.supportAssessments[0]?.supportingEvidenceRefs).toEqual([]);
    expect(result.supportAssessments[0]?.unknownEvidenceRefs).toContain(
      "session#turn-2",
    );
    expect(
      result.packetSources.map((source) => source.text).join("\n"),
    ).not.toContain("uncertified assistant name");
  });

  test("uses bounded source-only discovery for assistant evidence without changing fusion", async () => {
    const requirement = {
      requirementId: "assistant-answer",
      label: "prior assistant answer",
      searchText: "the answer you gave",
      temporalMode: "any" as const,
      roleConstraint: "assistant" as const,
      relation: "direct" as const,
      coverageMode: "any" as const,
      minimumEvidence: 1,
    };
    let lockedSources: readonly string[] = [];
    const resolver = createMemoryEvidenceResolverV1({
      index: {
        indexVersion: "test-index.v1",
        async search() {
          return {
            lists: [
              {
                channel: "l0" as const,
                retrieverId: "global",
                weight: 1,
                candidates: [
                  {
                    candidateId: "global-ref",
                    sourceId: "session-1",
                    evidenceRef: "session-1#turn-1",
                    sourceKind: "user_input" as const,
                    authority: "user_asserted" as const,
                  },
                  {
                    candidateId: "unselected-assistant-ref",
                    sourceId: "session-1",
                    evidenceRef: "session-1#turn-9",
                    sourceKind: "assistant_output" as const,
                    authority: "context_only" as const,
                  },
                  {
                    candidateId: "alternate-dialogue-ref",
                    sourceId: "session-2",
                    evidenceRef: "session-2#turn-1",
                    sourceKind: "user_input" as const,
                    authority: "user_asserted" as const,
                  },
                ],
              },
            ],
            hits: [
              {
                sourceId: "session-1",
                evidenceRef: "session-1#turn-1",
                content: "Please answer the question.",
                authority: "user_asserted" as const,
                turnOrder: 1,
              },
              {
                sourceId: "session-1",
                evidenceRef: "session-1#turn-9",
                content: "unselected assistant fallback must stay closed",
                authority: "context_only" as const,
                turnOrder: 9,
              },
            ],
          };
        },
      },
      maxSources: 1,
      planner: {
        plannerVersion:
          "paw.memory-evidence-query-planner.v10:certified-dialogue-candidate",
        async plan() {
          return {
            plannerVersion:
              "paw.memory-evidence-query-planner.v10:certified-dialogue-candidate",
            answerShape: "lookup" as const,
            temporalMode: "any" as const,
            roleConstraint: "assistant" as const,
            needsPlanning: true,
            requirements: [requirement],
          };
        },
      },
      sourceLocalLocator: {
        locatorVersion: "test-source-local.v1",
        async locate(request) {
          lockedSources = request.lockedSourceIds;
          const content = "forged locator prose";
          return {
            locatorVersion: "test-source-local.v1",
            locatorRevision: "local-revision",
            hits: [
              {
                sourceId: "session-2",
                evidenceRef: "session-2#turn-2",
                anchorEvidenceRef: "session-2#turn-2",
                contextEvidenceRefs: ["session-2#turn-2"],
                sourceKind: "assistant_output" as const,
                content,
                authority: "context_only" as const,
                turnOrder: 2,
                includedTurns: [
                  {
                    evidenceRef: "session-2#turn-2",
                    sourceKind: "assistant_output" as const,
                    turnOrder: 2,
                  },
                ],
              },
            ],
            degradedChannels: [] as const,
            telemetry: {
              lexicalCandidates: 1,
              denseCandidates: 1,
              anchorCount: 1,
              includedTurnCount: 1,
              renderedChars: content.length,
              cacheHit: false,
              durationMs: 2,
            },
          };
        },
      },
      sourceLocalHydrator: sourceLocalHydrator({
        "session-2#turn-2": "The answer was cobalt.",
      }),
      supportSelector: {
        selectorVersion: "test-selector.v1",
        async select(input) {
          expect(input.candidates[0]?.sourceKind).toBe("assistant_output");
          return {
            selectorVersion: "test-selector.v1",
            selectionRevision: "selected-local",
            assessments: [
              {
                requirementId: requirement.requirementId,
                supportingEvidenceRefs: ["session-2#turn-2"],
                contradictingEvidenceRefs: [],
                unknownEvidenceRefs: [],
              },
            ],
          };
        },
      },
    });

    const result = await resolver.resolve(
      "What answer did you give me?",
      new AbortController().signal,
    );

    expect(lockedSources).toEqual(["session-1", "session-2"]);
    expect(result.sources.map((source) => source.sourceId)).toEqual([
      "session-1",
    ]);
    expect(result.sourceLocalization).toMatchObject({
      status: "completed",
      addedCandidateCount: 1,
      selectedCandidateCount: 1,
    });
    expect(result.packetSources[0]?.text).toContain("cobalt");
    expect(result.packetSources[0]?.text).not.toContain("forged locator prose");
  });

  test("collapses untrusted source-local error names to a content-free failure code", async () => {
    const requirement = {
      requirementId: "assistant-answer",
      label: "prior assistant answer",
      searchText: "the answer you gave",
      temporalMode: "any" as const,
      roleConstraint: "assistant" as const,
      relation: "direct" as const,
      coverageMode: "any" as const,
      minimumEvidence: 1,
    };
    const secret = "PRIVATE_QUERY_PAYLOAD";
    const resolver = createMemoryEvidenceResolverV1({
      index: {
        indexVersion: "test-index.v1",
        async search() {
          return {
            lists: [
              {
                channel: "l0" as const,
                retrieverId: "global",
                weight: 1,
                candidates: [
                  {
                    candidateId: "baseline-ref",
                    sourceId: "session-1",
                    evidenceRef: "session-1#turn-1",
                    sourceKind: "user_input" as const,
                    authority: "user_asserted" as const,
                  },
                ],
              },
            ],
            hits: [
              {
                sourceId: "session-1",
                evidenceRef: "session-1#turn-1",
                content: "safe baseline evidence",
                authority: "user_asserted" as const,
                turnOrder: 1,
              },
            ],
          };
        },
      },
      planner: {
        plannerVersion:
          "paw.memory-evidence-query-planner.v10:certified-dialogue-candidate",
        async plan() {
          return {
            plannerVersion:
              "paw.memory-evidence-query-planner.v10:certified-dialogue-candidate",
            answerShape: "lookup" as const,
            temporalMode: "any" as const,
            roleConstraint: "assistant" as const,
            needsPlanning: true,
            requirements: [requirement],
          };
        },
      },
      sourceLocalLocator: {
        locatorVersion: "malicious-locator.v1",
        async locate() {
          const error = new Error("rejected");
          error.name = `MemorySourceLocalEvidence${secret}`;
          throw error;
        },
      },
      sourceLocalHydrator: sourceLocalHydrator({}),
      supportSelector: {
        selectorVersion: "test-selector.v1",
        async select() {
          throw new Error("selector unavailable");
        },
      },
    });

    const result = await resolver.resolve(
      "What answer did you give me?",
      new AbortController().signal,
    );
    const serialized = JSON.stringify(result);

    expect(result.sourceLocalization).toMatchObject({
      status: "invalid_result",
      reasonCode: "result_rejected",
      failureCode: "MemorySourceLocalEvidenceBoundaryRejected",
      addedCandidateCount: 0,
      selectedCandidateCount: 0,
    });
    expect(serialized).not.toContain(secret);
    expect(result.packetSources).toEqual([]);
  });

  test("locates every direct assistant requirement and commits the batch together", async () => {
    const requirements = [
      {
        requirementId: "assistant-answer-1",
        label: "first prior assistant answer",
        searchText: "first answer you gave",
        temporalMode: "any" as const,
        roleConstraint: "any" as const,
        relation: "direct" as const,
        coverageMode: "any" as const,
        minimumEvidence: 1,
      },
      {
        requirementId: "assistant-answer-2",
        label: "second prior assistant answer",
        searchText: "second answer you gave",
        temporalMode: "any" as const,
        roleConstraint: "any" as const,
        relation: "direct" as const,
        coverageMode: "any" as const,
        minimumEvidence: 1,
      },
    ];
    const located: string[] = [];
    let failSecond = false;
    let selectorCandidateRefs: readonly string[] = [];
    const resolver = createMemoryEvidenceResolverV1({
      index: {
        indexVersion: "test-index.v1",
        async search() {
          return {
            lists: [
              {
                channel: "l0" as const,
                retrieverId: "global",
                weight: 1,
                candidates: [
                  {
                    candidateId: "global-ref",
                    sourceId: "session-1",
                    evidenceRef: "session-1#turn-1",
                    sourceKind: "user_input" as const,
                    authority: "user_asserted" as const,
                  },
                ],
              },
            ],
            hits: [
              {
                sourceId: "session-1",
                evidenceRef: "session-1#turn-1",
                content: "Please answer both questions.",
                authority: "user_asserted" as const,
                turnOrder: 1,
              },
            ],
          };
        },
      },
      planner: {
        plannerVersion:
          "paw.memory-evidence-query-planner.v10:certified-dialogue-candidate",
        async plan() {
          return {
            plannerVersion:
              "paw.memory-evidence-query-planner.v10:certified-dialogue-candidate",
            answerShape: "lookup" as const,
            temporalMode: "any" as const,
            roleConstraint: "any" as const,
            needsPlanning: true,
            requirements,
          };
        },
      },
      sourceLocalLocator: {
        locatorVersion: "test-source-local.v1",
        async locate(request) {
          located.push(request.requirement.requirementId);
          if (
            failSecond &&
            request.requirement.requirementId === "assistant-answer-2"
          ) {
            throw new Error("second locator failed");
          }
          const suffix = request.requirement.requirementId.endsWith("1")
            ? "2"
            : "4";
          const userTurn = Number(suffix) - 1;
          const content = `assistant answer ${suffix}`;
          const evidenceRef = `session-1#turn-${suffix}`;
          return {
            locatorVersion: "test-source-local.v1",
            locatorRevision: `local-revision-${suffix}`,
            hits: [
              {
                sourceId: "session-1",
                evidenceRef,
                anchorEvidenceRef: evidenceRef,
                contextEvidenceRefs: [
                  `session-1#turn-${userTurn}`,
                  evidenceRef,
                ],
                sourceKind: "assistant_output" as const,
                content,
                authority: "context_only" as const,
                turnOrder: Number(suffix),
                includedTurns: [
                  {
                    evidenceRef: `session-1#turn-${userTurn}`,
                    sourceKind: "user_input" as const,
                    turnOrder: userTurn,
                  },
                  {
                    evidenceRef,
                    sourceKind: "assistant_output" as const,
                    turnOrder: Number(suffix),
                  },
                ],
              },
            ],
            degradedChannels: [] as const,
            telemetry: {
              lexicalCandidates: 1,
              denseCandidates: 1,
              anchorCount: 1,
              includedTurnCount: 2,
              renderedChars: content.length,
              cacheHit: false,
              durationMs: 2,
            },
          };
        },
      },
      sourceLocalHydrator: sourceLocalHydrator({
        "session-1#turn-1": "Please answer the first question.",
        "session-1#turn-2": "assistant answer 2",
        "session-1#turn-3": "Please answer the second question.",
        "session-1#turn-4": "assistant answer 4",
      }),
      supportSelector: {
        selectorVersion: "test-selector.v1",
        async select(input) {
          selectorCandidateRefs = input.candidates.map(
            (candidate) => candidate.evidenceRef,
          );
          return {
            selectorVersion: "test-selector.v1",
            selectionRevision: "selected-local-batch",
            assessments: requirements.map((requirement, index) => ({
              requirementId: requirement.requirementId,
              supportingEvidenceRefs: [
                failSecond
                  ? "session-1#turn-1"
                  : `session-1#turn-${index === 0 ? 2 : 4}`,
              ],
              contradictingEvidenceRefs: [],
              unknownEvidenceRefs: [],
            })),
          };
        },
      },
    });

    const result = await resolver.resolve(
      "Could you repeat the two items from our earlier conversation?",
      new AbortController().signal,
    );

    expect(located).toEqual(["assistant-answer-1", "assistant-answer-2"]);
    expect(result.sourceLocalization).toMatchObject({
      status: "completed",
      addedCandidateCount: 2,
      selectedCandidateCount: 2,
      telemetry: {
        lexicalCandidates: 2,
        denseCandidates: 2,
        anchorCount: 2,
        includedTurnCount: 4,
        cacheHit: false,
        durationMs: 4,
      },
    });
    expect(result.packetSources[0]?.text).toContain("assistant answer 2");
    expect(result.packetSources[0]?.text).toContain("assistant answer 4");
    expect(
      result.packetSources.map((source) => source.text).join("\n"),
    ).not.toContain("unselected assistant fallback must stay closed");

    failSecond = true;
    located.length = 0;
    const fallback = await resolver.resolve(
      "Could you repeat the two items from our earlier conversation?",
      new AbortController().signal,
    );

    expect(located).toEqual(["assistant-answer-1", "assistant-answer-2"]);
    expect(selectorCandidateRefs).not.toContain("session-1#turn-2");
    expect(selectorCandidateRefs).not.toContain("session-1#turn-4");
    expect(fallback.sourceLocalization).toMatchObject({
      status: "fallback",
      reasonCode: "locator_failed",
      addedCandidateCount: 0,
      selectedCandidateCount: 0,
    });
    expect(fallback.packetSources[0]?.text).not.toContain("assistant answer 2");
    expect(fallback.packetSources[0]?.text).not.toContain("assistant answer 4");
    expect(
      fallback.packetSources.map((source) => source.text).join("\n"),
    ).not.toContain("unselected assistant fallback must stay closed");
  });

  test("keeps bounded assistant candidates after a conservative selection but drops them on selector failure", async () => {
    const requirement = {
      requirementId: "assistant-answer",
      label: "prior assistant answer",
      searchText: "the answer you gave",
      temporalMode: "any" as const,
      roleConstraint: "assistant" as const,
      relation: "direct" as const,
      coverageMode: "any" as const,
      minimumEvidence: 1,
    };
    const resolverInput: Parameters<typeof createMemoryEvidenceResolverV1>[0] =
      {
        index: {
          indexVersion: "test-index.v1",
          async search() {
            return {
              lists: [
                {
                  channel: "l0" as const,
                  retrieverId: "global",
                  weight: 1,
                  candidates: [
                    {
                      candidateId: "global-ref",
                      sourceId: "session-1",
                      evidenceRef: "session-1#turn-1",
                      sourceKind: "user_input" as const,
                      authority: "user_asserted" as const,
                    },
                  ],
                },
              ],
              hits: [
                {
                  sourceId: "session-1",
                  evidenceRef: "session-1#turn-1",
                  content: "baseline only",
                  authority: "user_asserted" as const,
                  turnOrder: 1,
                },
              ],
            };
          },
        },
        planner: {
          plannerVersion:
            "paw.memory-evidence-query-planner.v10:certified-dialogue-candidate",
          async plan() {
            return {
              plannerVersion:
                "paw.memory-evidence-query-planner.v10:certified-dialogue-candidate",
              answerShape: "lookup" as const,
              temporalMode: "any" as const,
              roleConstraint: "assistant" as const,
              needsPlanning: true,
              requirements: [requirement],
            };
          },
        },
        sourceLocalLocator: {
          locatorVersion: "test-source-local.v1",
          async locate() {
            const content = "local secret answer";
            return {
              locatorVersion: "test-source-local.v1",
              locatorRevision: "local-revision",
              hits: [
                {
                  sourceId: "session-1",
                  evidenceRef: "session-1#turn-2",
                  anchorEvidenceRef: "session-1#turn-2",
                  contextEvidenceRefs: ["session-1#turn-2"],
                  sourceKind: "assistant_output" as const,
                  content,
                  authority: "context_only" as const,
                  turnOrder: 2,
                  includedTurns: [
                    {
                      evidenceRef: "session-1#turn-2",
                      sourceKind: "assistant_output" as const,
                      turnOrder: 2,
                    },
                  ],
                },
              ],
              degradedChannels: [] as const,
              telemetry: {
                lexicalCandidates: 1,
                denseCandidates: 0,
                anchorCount: 1,
                includedTurnCount: 1,
                renderedChars: content.length,
                cacheHit: false,
                durationMs: 1,
              },
            };
          },
        },
        sourceLocalHydrator: sourceLocalHydrator({
          "session-1#turn-2": "local secret answer",
        }),
      };
    const selector = {
      selectorVersion: "test-selector.v1",
      async select(input: {
        readonly candidates: readonly { readonly evidenceRef: string }[];
      }) {
        const hasLocal = input.candidates.some(
          (candidate) => candidate.evidenceRef === "session-1#turn-2",
        );
        return {
          selectorVersion: "test-selector.v1",
          selectionRevision: "reject-local",
          assessments: [
            {
              requirementId: requirement.requirementId,
              supportingEvidenceRefs: ["session-1#turn-1"],
              contradictingEvidenceRefs: [],
              unknownEvidenceRefs: hasLocal ? ["session-1#turn-2"] : [],
            },
          ],
        };
      },
    };
    const baseline = await createMemoryEvidenceResolverV1({
      ...resolverInput,
      sourceLocalLocator: undefined,
      supportSelector: selector,
    }).resolve("What answer did you give me?", new AbortController().signal);
    const rejected = await createMemoryEvidenceResolverV1({
      ...resolverInput,
      supportSelector: selector,
    }).resolve("What answer did you give me?", new AbortController().signal);
    expect(rejected.sourceLocalization).toMatchObject({
      status: "completed",
      selectedCandidateCount: 0,
    });
    expect(rejected.packetSources).not.toEqual(baseline.packetSources);
    expect(rejected.packetSources[0]?.answerRole).toBe("candidate");
    expect(rejected.packetSources[0]?.text ?? "").toContain(
      "local secret answer",
    );

    const result = await createMemoryEvidenceResolverV1({
      ...resolverInput,
      supportSelector: {
        selectorVersion: "test-selector.v1",
        async select() {
          throw new Error("selector unavailable");
        },
      },
    }).resolve("What answer did you give me?", new AbortController().signal);
    expect(result.sourceLocalization).toMatchObject({
      status: "fallback",
      reasonCode: "selector_failed",
      addedCandidateCount: 0,
    });
    expect(result.packetSources[0]?.text ?? "").not.toContain(
      "local secret answer",
    );
  });
  test("locks sources only after bounded planned discovery", async () => {
    const resolver = createMemoryEvidenceResolverV1({
      index: index(),
      planner: {
        plannerVersion:
          "paw.memory-evidence-query-planner.v10:certified-dialogue-candidate",
        async plan() {
          return {
            plannerVersion:
              "paw.memory-evidence-query-planner.v10:certified-dialogue-candidate",
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

  test("keeps deterministically certified L0 authoritative when semantic triage misses it", async () => {
    let selectorCalls = 0;
    const resolver = createMemoryEvidenceResolverV1({
      index: {
        indexVersion: "direct-certificate.v1",
        async search() {
          return {
            lists: [
              {
                channel: "l0" as const,
                retrieverId: "exact-turn",
                weight: 1,
                candidates: [
                  {
                    candidateId: "favorite-color-ref",
                    sourceId: "one-source",
                    evidenceRef: "favorite-color-ref",
                    sourceKind: "user_input" as const,
                    authority: "user_asserted" as const,
                  },
                ],
              },
            ],
            hits: [
              {
                sourceId: "one-source",
                evidenceRef: "favorite-color-ref",
                content: "My favorite color is blue.",
                authority: "user_asserted" as const,
              },
            ],
          };
        },
      },
      supportSelector: {
        selectorVersion: "test-support-selector.v1",
        async select(input) {
          selectorCalls += 1;
          return {
            selectorVersion: "test-support-selector.v1",
            selectionRevision: "missed-direct-revision",
            assessments: [
              {
                requirementId: requiredAt(input.requirements, 0).requirementId,
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
      "What is my favorite color?",
      new AbortController().signal,
    );

    expect(result.directCertificateStatus).toBe("deterministic_direct");
    expect(result.supportSelectorStatus).toBe("completed");
    expect(result.notebook.coverage[0]?.status).toBe("missing");
    expect(result.packetSources[0]?.answerRole).toBe("supporting");
    expect(projectEvidenceFirstMemoryContextPacketV1(result).stop).toBe(
      "partial",
    );
    expect(selectorCalls).toBe(1);
  });

  test("plans an ambiguous simple lookup only when primary discovery spans sources", async () => {
    const forceValues: Array<boolean | undefined> = [];
    const planner = {
      plannerVersion:
        "paw.memory-evidence-query-planner.v10:certified-dialogue-candidate" as const,
      async plan(
        _query: string,
        _signal: AbortSignal,
        options?: Readonly<{ force?: boolean }>,
      ) {
        forceValues.push(options?.force);
        return {
          plannerVersion:
            "paw.memory-evidence-query-planner.v10:certified-dialogue-candidate" as const,
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
          "paw.memory-evidence-query-planner.v10:certified-dialogue-candidate",
        async plan() {
          plannerCalls += 1;
          return {
            plannerVersion:
              "paw.memory-evidence-query-planner.v10:certified-dialogue-candidate",
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
          "paw.memory-evidence-query-planner.v10:certified-dialogue-candidate",
        async plan() {
          return {
            plannerVersion:
              "paw.memory-evidence-query-planner.v10:certified-dialogue-candidate",
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
                requirementId: requiredAt(input.requirements, 0).requirementId,
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
          "paw.memory-evidence-query-planner.v10:certified-dialogue-candidate",
        async plan() {
          return {
            plannerVersion:
              "paw.memory-evidence-query-planner.v10:certified-dialogue-candidate",
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
          "paw.memory-evidence-query-planner.v10:certified-dialogue-candidate",
        async plan() {
          return {
            plannerVersion:
              "paw.memory-evidence-query-planner.v10:certified-dialogue-candidate",
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
                sourceKind: "user_input" as const,
                turnOrder: 1,
              },
              {
                sourceId: "session",
                evidenceRef: "session#assistant-2",
                content: "26. Soliloquy\n27. Sound effects\n28. Music",
                authority: "context_only" as const,
                sourceKind: "assistant_output" as const,
                turnOrder: 2,
              },
            ],
          };
        },
      },
      planner: {
        plannerVersion:
          "paw.memory-evidence-query-planner.v10:certified-dialogue-candidate",
        async plan() {
          return {
            plannerVersion:
              "paw.memory-evidence-query-planner.v10:certified-dialogue-candidate",
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
      "Can you remind me what you provided as the 27th parameter on the list?",
      new AbortController().signal,
    );

    expect(result.notebook.coverage[0]?.selectedEvidenceRefs).toEqual([]);
    expect(result.packetSources[0]?.answerRole).toBe("candidate");
    expect(result.packetSources[0]?.text).toContain("27. Sound effects");
  });

  test("keeps the legacy closure auditor read-only and outside retrieval", async () => {
    const searchTexts: string[] = [];
    let selectorCalls = 0;
    let auditorCalls = 0;
    const oldRequirement = {
      requirementId: "old",
      label: "Old commute",
      searchText: "old commute",
      temporalMode: "history" as const,
      roleConstraint: "user" as const,
      relation: "comparative" as const,
      coverageMode: "any" as const,
      minimumEvidence: 1,
    };
    const resolver = createMemoryEvidenceResolverV1({
      index: {
        indexVersion: "test-index.v1",
        async search(searchText) {
          searchTexts.push(searchText);
          const current = searchText.includes("current commute");
          const sourceId = current ? "current-session" : "old-session";
          const evidenceRef = current ? "current-ref" : "old-ref";
          return {
            lists: [
              {
                retrieverId: `lexical-${sourceId}`,
                channel: "l0" as const,
                weight: 1,
                candidates: [
                  {
                    candidateId: evidenceRef,
                    sourceId,
                    evidenceRef,
                    sourceKind: "user_input" as const,
                    authority: "user_asserted" as const,
                  },
                ],
              },
            ],
            hits: [
              {
                sourceId,
                evidenceRef,
                content: current
                  ? "My current commute is a fifteen minute train ride."
                  : "My old commute was a forty minute bus ride.",
                authority: "user_asserted" as const,
              },
            ],
          };
        },
      },
      planner: {
        plannerVersion:
          "paw.memory-evidence-query-planner.v10:certified-dialogue-candidate",
        async plan() {
          return {
            plannerVersion:
              "paw.memory-evidence-query-planner.v10:certified-dialogue-candidate",
            answerShape: "compare" as const,
            temporalMode: "history" as const,
            roleConstraint: "user" as const,
            needsPlanning: true,
            requirements: [oldRequirement],
          };
        },
      },
      supportSelector: {
        selectorVersion: "test-selector.v1",
        async select(input) {
          selectorCalls += 1;
          return {
            selectorVersion: "test-selector.v1",
            selectionRevision: `selection-${selectorCalls}`,
            assessments: input.requirements.map((requirement) => ({
              requirementId: requirement.requirementId,
              supportingEvidenceRefs: [
                requirement.requirementId === "old" ? "old-ref" : "current-ref",
              ],
              contradictingEvidenceRefs: [],
              unknownEvidenceRefs: [],
            })),
          };
        },
      },
      closureAuditor: {
        auditorVersion: "test-auditor.v1",
        async audit() {
          auditorCalls += 1;
          return {
            auditorVersion: "test-auditor.v1",
            auditRevision: "repair-audit",
            verdict: "repair" as const,
            missingRequirements: [
              {
                requirementId: "closure-repair-1",
                label: "Current commute",
                searchText: "current commute",
                temporalMode: "history" as const,
                roleConstraint: "user" as const,
                relation: "comparative" as const,
                coverageMode: "any" as const,
                minimumEvidence: 1,
              },
            ],
            rejectedEvidenceRefs: [],
          };
        },
      },
    });

    const result = await resolver.resolve(
      "What is the difference between my old and current commute?",
      new AbortController().signal,
    );

    expect(result.notebook.coverage.map((item) => item.status)).toEqual([
      "covered",
    ]);
    expect(result.closureAuditStatus).toBe("completed");
    expect(result.closureVerdict).toBe("insufficient");
    expect(result.closureRepairCount).toBe(0);
    expect(result.requirements).toHaveLength(1);
    expect(
      result.notebook.coverage.every((item) => item.status === "covered"),
    ).toBe(true);
    expect(selectorCalls).toBe(1);
    expect(auditorCalls).toBe(1);
    expect(
      searchTexts.filter((text) => text === "current commute"),
    ).toHaveLength(0);
  });
});
