import { describe, expect, test } from "bun:test";

import { hashTextV1 } from "../src/canonical.js";
import { enforceSelectedEvidenceAuthority } from "../src/evidence-authority.js";
import {
  mergeEvidenceHits,
  selectSupportCandidates,
  selectSupportCandidatesPreservingBaselineV1,
} from "../src/evidence-resolver-helpers.js";
import {
  compileMemorySourceLocalAssistantDialogueCertificatesV1,
  selectScopedCertifiedAssistantDialogueRefsV1,
} from "../src/evidence-resolution-pass.js";
import {
  type MemoryEvidenceIndexV1,
  PAW_MEMORY_TEMPORAL_EVIDENCE_FRONTIER_VERSION_V1,
  createMemoryTemporalEvidenceFrontierSnapshotV1,
  createMemoryTemporalRoundPostingV1,
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
  test("keeps cross-requirement baseline candidates ahead of frontier omissions at the 32 cap", () => {
    const baselineByRequirement = [1, 10, 10, 10].map(
      (count, requirementIndex) =>
        Array.from({ length: count }, (_, index) => ({
          sourceId: "session-1",
          evidenceRef: `session-1#baseline-${requirementIndex + 1}-${index + 1}`,
          content: `baseline content ${requirementIndex + 1}-${index + 1}`,
          authority: "user_asserted" as const,
        })),
    );
    const frontier = Array.from({ length: 7 }, (_, index) => ({
      sourceId: "session-1",
      evidenceRef: `session-1#frontier-${index + 1}`,
      content: `frontier content ${index + 1}`,
      authority: "user_asserted" as const,
    }));
    const featureOff = selectSupportCandidates(
      baselineByRequirement,
      ["session-1"],
      false,
      32,
    );
    const selected = selectSupportCandidatesPreservingBaselineV1({
      baselineRequirementHits: baselineByRequirement,
      augmentedRequirementHits: [
        mergeEvidenceHits(baselineByRequirement[0] ?? [], frontier),
        ...baselineByRequirement.slice(1),
      ],
      selectedSourceIds: ["session-1"],
      allowContextOnly: false,
      maximum: 32,
    });
    expect(selected.slice(0, 31).map((hit) => hit.evidenceRef)).toEqual(
      featureOff.map((hit) => hit.evidenceRef),
    );
    expect(selected[31]?.evidenceRef).toBe(frontier[0]?.evidenceRef);
  });

  test("enforces authority independently for mixed-role obligation leaves", () => {
    const requirements = [
      {
        requirementId: "user-request",
        label: "user request",
        searchText: "prior user request",
        temporalMode: "any" as const,
        roleConstraint: "user" as const,
      },
      {
        requirementId: "assistant-answer",
        label: "assistant answer",
        searchText: "prior assistant answer",
        temporalMode: "any" as const,
        roleConstraint: "assistant" as const,
      },
    ];
    const userHit = {
      sourceId: "dialogue",
      evidenceRef: "dialogue:turn-1",
      content: "Please use the blue option.",
      authority: "user_asserted" as const,
      sourceKind: "user_input" as const,
    };
    const assistantHit = {
      sourceId: "dialogue",
      evidenceRef: "dialogue:turn-2",
      content: "I used the blue option.",
      authority: "context_only" as const,
      sourceKind: "assistant_output" as const,
      contextEvidenceRefs: ["dialogue:turn-1", "dialogue:turn-2"],
    };
    const result = enforceSelectedEvidenceAuthority({
      assessments: [
        {
          requirementId: "user-request",
          supportingEvidenceRefs: [userHit.evidenceRef],
          contradictingEvidenceRefs: [],
          unknownEvidenceRefs: [],
        },
        {
          requirementId: "assistant-answer",
          supportingEvidenceRefs: [assistantHit.evidenceRef],
          contradictingEvidenceRefs: [],
          unknownEvidenceRefs: [],
        },
      ],
      requirements,
      candidateEvidenceRefs: new Set([
        userHit.evidenceRef,
        assistantHit.evidenceRef,
      ]),
      candidateEvidenceRefsByRequirement: new Map([
        ["user-request", new Set([userHit.evidenceRef])],
        ["assistant-answer", new Set([assistantHit.evidenceRef])],
      ]),
      requirementHits: [[userHit], [assistantHit]],
      roleConstraint: "any",
      certifiedSharedDialogueRefs: new Set([assistantHit.evidenceRef]),
      certifiedDialoguePredecessorsByAssistant: new Map([
        [assistantHit.evidenceRef, userHit.evidenceRef],
      ]),
      certifiedAssistantDialogueCandidate: false,
    });

    expect(result[0]?.supportingEvidenceRefs).toEqual([userHit.evidenceRef]);
    expect(result[1]?.supportingEvidenceRefs).toEqual([
      assistantHit.evidenceRef,
    ]);
  });

  test("compiles exact included assistant turns instead of the source-local anchor", () => {
    expect(
      compileMemorySourceLocalAssistantDialogueCertificatesV1([
        {
          sourceId: "session",
          evidenceRef: "session#turn-1",
          anchorEvidenceRef: "session#turn-1",
          contextEvidenceRefs: ["session#turn-1", "session#turn-2"],
          sourceKind: "user_input",
          content: "hydrated dialogue bundle",
          authority: "user_asserted",
          turnOrder: 1,
          includedTurns: [
            {
              evidenceRef: "session#turn-1",
              sourceKind: "user_input",
              turnOrder: 1,
            },
            {
              evidenceRef: "session#turn-2",
              sourceKind: "assistant_output",
              turnOrder: 2,
            },
          ],
        },
      ]),
    ).toEqual(["session#turn-2"]);

    expect(
      compileMemorySourceLocalAssistantDialogueCertificatesV1([
        {
          sourceId: "session",
          evidenceRef: "session#turn-2",
          anchorEvidenceRef: "session#turn-2",
          contextEvidenceRefs: ["session#turn-2"],
          sourceKind: "assistant_output",
          content: "assistant turn without an adjacent user turn",
          authority: "context_only",
          turnOrder: 2,
          includedTurns: [
            {
              evidenceRef: "session#turn-2",
              sourceKind: "assistant_output",
              turnOrder: 2,
            },
          ],
        },
      ]),
    ).toEqual([]);
  });

  test("drops dialogue certificates outside the bounded selector candidate aperture", () => {
    const certified = new Set(
      Array.from({ length: 33 }, (_, index) => `session#turn-${index + 1}`),
    );
    const candidateRefs = new Set([...certified].slice(0, 32));
    const selected = selectScopedCertifiedAssistantDialogueRefsV1({
      certifiedEvidenceRefs: certified,
      candidateEvidenceRefs: candidateRefs,
      candidateScopes: [{ evidenceRefs: [...candidateRefs] }],
    });

    expect(selected).toHaveLength(32);
    expect(selected).not.toContain("session#turn-33");
  });

  test("reopens the assistant lane after semantic role normalization", async () => {
    const query = "What amount was in the plan from our previous conversation?";
    const resolver = createMemoryEvidenceResolverV1({
      index: {
        indexVersion: "test-index.v1",
        async search() {
          return {
            lists: [
              {
                retrieverId: "lexical",
                channel: "l0" as const,
                weight: 1,
                candidates: [
                  {
                    candidateId: "user-ref",
                    sourceId: "dialogue",
                    evidenceRef: "user-ref",
                    sourceKind: "user_input" as const,
                    authority: "user_asserted" as const,
                  },
                  {
                    candidateId: "assistant-ref",
                    sourceId: "dialogue",
                    evidenceRef: "assistant-ref",
                    sourceKind: "assistant_output" as const,
                    authority: "context_only" as const,
                  },
                ],
              },
            ],
            hits: [
              {
                sourceId: "dialogue",
                evidenceRef: "user-ref",
                content: "The user asked for a working title.",
                sourceKind: "user_input" as const,
                authority: "user_asserted" as const,
              },
              {
                sourceId: "dialogue",
                evidenceRef: "assistant-ref",
                content: "The assistant ultimately proposed Project Lantern.",
                sourceKind: "assistant_output" as const,
                authority: "context_only" as const,
              },
            ],
          };
        },
      },
      planner: {
        plannerVersion: "test-semantic-planner.v1",
        async plan() {
          return {
            plannerVersion: "test-semantic-planner.v1",
            answerShape: "lookup" as const,
            temporalMode: "any" as const,
            roleConstraint: "assistant" as const,
            needsPlanning: true,
            requirements: [
              {
                requirementId: "proposal",
                label: "Assistant proposal",
                searchText: "assistant proposal",
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
      supportSelector: {
        selectorVersion: "test-selector.v1",
        async select() {
          return {
            selectorVersion: "test-selector.v1",
            selectionRevision: "assistant-only",
            assessments: [
              {
                requirementId: "proposal",
                supportingEvidenceRefs: ["assistant-ref"],
                contradictingEvidenceRefs: [],
                unknownEvidenceRefs: [],
              },
            ],
          };
        },
      },
    });

    const result = await resolver.resolve(query, new AbortController().signal);

    expect(result.intent.roleConstraint).toBe("assistant");
    expect(result.primaryHits.map((hit) => hit.evidenceRef)).toContain(
      "assistant-ref",
    );
    const packet = result.packetSources.map((source) => source.text).join("\n");
    expect(packet).toContain("Project Lantern");
    expect(packet).not.toContain("working title");
  });

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
      evidenceGroundedRoleBinding: true,
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
                  {
                    candidateId: "later-user-ref",
                    sourceId: "session",
                    evidenceRef: "session#turn-3",
                    sourceKind: "user_input" as const,
                    authority: "user_asserted" as const,
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
                evidenceRef: "assistant-source#turn-1",
                anchorEvidenceRef: "assistant-source#turn-1",
                contextEvidenceRefs: [
                  "assistant-source#turn-1",
                  "assistant-source#turn-2",
                ],
                sourceKind: "user_input" as const,
                content: "Please propose a label for the plan.",
                authority: "user_asserted" as const,
                turnOrder: 1,
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
              lexicalCandidates: 2,
              denseCandidates: 2,
              anchorCount: 2,
              includedTurnCount: 4,
              renderedChars:
                "Please propose a label for the plan.".length + content.length,
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
            expect(
              payload.candidates.filter(
                (candidate) => candidate.certifiedAssistantDialogue,
              ),
            ).toHaveLength(1);
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
      "How many items were in the plan from our previous conversation?",
      new AbortController().signal,
    );

    expect(result.intent.roleConstraint).toBe("user");
    expect(locatorCalls).toBe(1);
    expect(result.sources.map((source) => source.sourceId)).toEqual([
      "user-source",
    ]);
    expect(result.sourceLocalization).toMatchObject({
      executor: "per_leaf_v25",
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
    expect(result.requirementEvidence[0]).toMatchObject({
      supportingEvidenceRefs: ["assistant-source#turn-2"],
      candidateEvidenceRefs: [],
      contradictingEvidenceRefs: [],
    });
    expect(
      projectEvidenceFirstMemoryAnswerContractV1(result).requirements[0]
        ?.supportingEvidenceRefs,
    ).toEqual(["assistant-source#turn-2"]);
  });

  test("rejects requirement authority drift from a custom planner port", async () => {
    let locatedRole = "";
    const resolver = createMemoryEvidenceResolverV1({
      index: index(),
      planner: {
        plannerVersion:
          "paw.memory-evidence-query-planner.v11:closure-deficiency-replan",
        async plan() {
          return {
            plannerVersion:
              "paw.memory-evidence-query-planner.v11:closure-deficiency-replan",
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
          "paw.memory-evidence-query-planner.v11:closure-deficiency-replan",
        async plan() {
          return {
            plannerVersion:
              "paw.memory-evidence-query-planner.v11:closure-deficiency-replan",
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
    // Deterministic support floor: a failed selector is not an availability
    // verdict. Requirements keep lane-ranked locked-source candidates bound,
    // so the packet stays requirement-bound instead of collapsing to zero
    // evidence with unbound candidate fallback.
    expect(result.notebook.coverage.map((item) => item.status)).toEqual([
      "covered",
      "covered",
    ]);
    expect(
      result.sourceLocalization.deterministicSupportFloor?.policyVersion,
    ).toBe(
      "paw.memory-deterministic-support-floor.v1:nonempty-requirement-packet",
    );
    expect(
      result.sourceLocalization.deterministicSupportFloor
        ?.flooredRequirementCount,
    ).toBe(2);
    expect(result.packetSources.length).toBeGreaterThan(0);
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
          "paw.memory-evidence-query-planner.v11:closure-deficiency-replan",
        async plan() {
          return {
            plannerVersion:
              "paw.memory-evidence-query-planner.v11:closure-deficiency-replan",
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
    // The role-ineligible promotion is stripped, so the requirement binding is
    // empty and the deterministic support floor binds the legitimate
    // lane-ranked user turn instead. The uncertified assistant turn stays out.
    expect(result.notebook.coverage[0]?.status).toBe("covered");
    expect(result.supportAssessments[0]?.supportingEvidenceRefs).toEqual([]);
    expect(result.supportAssessments[0]?.unknownEvidenceRefs).toEqual([]);
    expect(result.supportAssessments[0]?.evidenceDispositions).toContainEqual(
      expect.objectContaining({
        evidenceRef: "session#turn-2",
        disposition: "role_ineligible",
      }),
    );
    expect(
      result.packetSources.map((source) => source.text).join("\n"),
    ).not.toContain("uncertified assistant name");
    expect(
      result.packetSources.flatMap((source) => source.evidenceRefs),
    ).toContain("session#turn-1");
  });

  test("keeps locator-only included assistant turns closed without an exact binding", async () => {
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
    let selectorCalls = 0;
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
                sourceKind: "user_input" as const,
                turnOrder: 1,
              },
              {
                sourceId: "session",
                evidenceRef: "session#turn-2",
                content: "The assistant proposed Northstar.",
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
          "paw.memory-evidence-query-planner.v11:closure-deficiency-replan",
        async plan() {
          return {
            plannerVersion:
              "paw.memory-evidence-query-planner.v11:closure-deficiency-replan",
            answerShape: "lookup" as const,
            temporalMode: "any" as const,
            roleConstraint: "any" as const,
            needsPlanning: true,
            requirements: [requirement],
          };
        },
      },
      sourceLocalLocator: {
        locatorVersion: "test-source-local.v1",
        async locate() {
          const content = "untrusted locator projection";
          return {
            locatorVersion: "test-source-local.v1",
            locatorRevision: "exact-adjacent-dialogue",
            hits: [
              {
                sourceId: "session",
                evidenceRef: "session#turn-1",
                anchorEvidenceRef: "session#turn-1",
                contextEvidenceRefs: ["session#turn-1", "session#turn-2"],
                sourceKind: "user_input" as const,
                content,
                authority: "user_asserted" as const,
                turnOrder: 1,
                includedTurns: [
                  {
                    evidenceRef: "session#turn-1",
                    sourceKind: "user_input" as const,
                    turnOrder: 1,
                  },
                  {
                    evidenceRef: "session#turn-2",
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
        "session#turn-1": "Please create a name.",
        "session#turn-2": "The assistant proposed Northstar.",
      }),
      supportSelector: {
        selectorVersion: "test-selector.v1",
        async select(input) {
          selectorCalls += 1;
          expect(input.certifiedAssistantDialogueEvidenceRefs).toBeUndefined();
          expect(
            input.candidates.find(
              (candidate) => candidate.evidenceRef === "session#turn-2",
            ),
          ).toMatchObject({
            sourceKind: "assistant_output",
            authority: "context_only",
          });
          return {
            selectorVersion: "test-selector.v1",
            selectionRevision: "selected-certified-assistant",
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

    expect(selectorCalls).toBe(1);
    expect(result.supportSelectorStatus).toBe("completed");
    expect(result.supportAssessments[0]?.supportingEvidenceRefs).toEqual([]);
    expect(result.supportAssessments[0]?.unknownEvidenceRefs).toEqual([]);
    expect(result.supportAssessments[0]?.evidenceDispositions).toContainEqual(
      expect.objectContaining({
        evidenceRef: "session#turn-2",
        disposition: "role_ineligible",
      }),
    );
    // Floor binds the certified-eligible user turn; the uncertified locator
    // assistant turn stays closed: it is never bound as requirement support
    // (locator context rendering is unchanged by the floor).
    expect(result.notebook.coverage[0]?.status).toBe("covered");
    expect(result.notebook.coverage[0]?.selectedEvidenceRefs).toEqual([
      "session#turn-1",
    ]);
    expect(result.notebook.coverage[0]?.selectedEvidenceRefs).not.toContain(
      "session#turn-2",
    );
  });

  test("late-binds a user slot to exact assistant evidence without widening discovery", async () => {
    const userContent = "Please create a project name.";
    const assistantContent = "Northstar is the proposed project name.";
    const requirement = {
      requirementId: "shared-item",
      label: "shared dialogue item",
      searchText: "project name from earlier conversation",
      temporalMode: "any" as const,
      roleConstraint: "user" as const,
      relation: "direct" as const,
      coverageMode: "any" as const,
      minimumEvidence: 1,
    };
    let observedLateBoundRequirement: unknown;
    let observedCertifiedRefs: readonly string[] | undefined;
    let observedAssistantCandidate: unknown;
    let observedCandidateScope: readonly string[] | undefined;
    const resolver = createMemoryEvidenceResolverV1({
      evidenceGroundedRoleBinding: true,
      index: {
        indexVersion: "test-index.v1",
        evidenceRefBelongsToSource(sourceId, evidenceRef) {
          return evidenceRef.startsWith(`${sourceId}#`);
        },
        async search() {
          return {
            lists: [
              {
                channel: "l0" as const,
                retrieverId: "exact-turns",
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
                    authority: "user_confirmed_dialogue" as const,
                  },
                ],
              },
            ],
            hits: [
              {
                sourceId: "session",
                evidenceRef: "session#turn-1",
                content: userContent,
                sourceKind: "user_input" as const,
                authority: "user_asserted" as const,
                turnOrder: 1,
              },
              {
                sourceId: "session",
                evidenceRef: "session#turn-2",
                content: `${userContent}\n${assistantContent}`,
                sourceKind: "assistant_output" as const,
                authority: "user_confirmed_dialogue" as const,
                turnOrder: 2,
              },
              {
                sourceId: "session",
                evidenceRef: "session#turn-3",
                content: "Please create a different item.",
                sourceKind: "user_input" as const,
                authority: "user_asserted" as const,
                turnOrder: 3,
              },
            ],
          };
        },
      },
      planner: {
        plannerVersion:
          "paw.memory-evidence-query-planner.v11:closure-deficiency-replan",
        async plan() {
          return {
            plannerVersion:
              "paw.memory-evidence-query-planner.v11:closure-deficiency-replan",
            answerShape: "lookup" as const,
            temporalMode: "any" as const,
            roleConstraint: "user" as const,
            needsPlanning: true,
            requirements: [requirement],
          };
        },
      },
      sourceLocalLocator: {
        locatorVersion: "test-source-local.v1",
        async locate(request) {
          expect(request.requirement.roleConstraint).toBe("any");
          expect(request.requirement.searchText).toBe(
            "project name from earlier conversation",
          );
          expect(request.assistantDialogueCandidate).toBe(true);
          expect(request.respondingAssistantMaterialization).toMatchObject({
            originalQuery:
              "Which project name came from our earlier conversation?",
            sourcePriorityIds: ["session"],
            maxPromptAnchorsPerSource: 1,
            authorization: {
              originKind: "dialogue_artifact_unowned",
              requirementId: requirement.requirementId,
              mode: "late_binding",
            },
          });
          expect(request.lockedSourceIds).toEqual(["session"]);
          return {
            locatorVersion: "test-source-local.v1",
            locatorRevision: "exact-assistant-anchor",
            hits: [
              {
                sourceId: "session",
                evidenceRef: "session#turn-2",
                anchorEvidenceRef: "session#turn-2",
                contextEvidenceRefs: ["session#turn-1", "session#turn-2"],
                sourceKind: "assistant_output" as const,
                content: assistantContent,
                authority: "context_only" as const,
                turnOrder: 2,
                includedTurns: [
                  {
                    evidenceRef: "session#turn-1",
                    sourceKind: "user_input" as const,
                    turnOrder: 1,
                  },
                  {
                    evidenceRef: "session#turn-2",
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
              renderedChars: assistantContent.length,
              cacheHit: false,
              durationMs: 1,
            },
          };
        },
      },
      sourceLocalHydrator: sourceLocalHydrator({
        "session#turn-1": userContent,
        "session#turn-2": assistantContent,
      }),
      dialoguePredecessorVerifier: {
        verifierVersion: "test-dialogue-predecessor-verifier.v1",
        async verify(input) {
          expect(input.targets).toEqual([
            { sourceId: "session", evidenceRef: "session#turn-2" },
          ]);
          return {
            verifierVersion: "test-dialogue-predecessor-verifier.v1",
            verificationRevision: "verified-exact-assistant-turn",
            proofs: [
              {
                sourceId: "session",
                assistant: {
                  evidenceRef: "session#turn-2",
                  sourceKind: "assistant_output" as const,
                  turnOrder: 2,
                  content: assistantContent,
                  contentHash: hashTextV1(assistantContent),
                },
                precedingUser: {
                  evidenceRef: "session#turn-1",
                  sourceKind: "user_input" as const,
                  turnOrder: 1,
                  content: userContent,
                  contentHash: hashTextV1(userContent),
                },
              },
            ],
          };
        },
      },
      supportSelector: {
        selectorVersion: "test-selector.v1",
        async select(input) {
          observedLateBoundRequirement = input.requirements[0];
          observedCertifiedRefs = input.certifiedAssistantDialogueEvidenceRefs;
          observedCandidateScope = input.candidateScopes?.[0]?.evidenceRefs;
          observedAssistantCandidate = input.candidates.find(
            (candidate) => candidate.evidenceRef === "session#turn-2",
          );
          return {
            selectorVersion: "test-selector.v1",
            selectionRevision: "selected-exact-assistant-turn",
            assessments: [
              {
                requirementId:
                  input.requirements[0]?.requirementId ??
                  requirement.requirementId,
                supportingEvidenceRefs: [
                  ...(input.candidateScopes?.[0]?.evidenceRefs ?? []),
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
      "Which project name came from our earlier conversation?",
      new AbortController().signal,
    );

    expect(observedLateBoundRequirement).toMatchObject({
      roleConstraint: "any",
      roleCandidates: ["user", "assistant"],
    });
    expect(observedCertifiedRefs).toEqual(["session#turn-2"]);
    expect(observedCandidateScope).toEqual([
      "session#turn-2",
      "session#turn-1",
      "session#turn-3",
    ]);
    expect(observedAssistantCandidate).toMatchObject({
      content: assistantContent,
      sourceKind: "assistant_output",
      authority: "context_only",
      contextEvidenceRefs: ["session#turn-1", "session#turn-2"],
    });
    expect(result.supportAssessments[0]?.supportingEvidenceRefs).toEqual([
      "session#turn-2",
    ]);
    expect(result.requirements[0]).toMatchObject({
      roleConstraint: "any",
      roleCandidates: ["user", "assistant"],
    });
    expect(result.supportAssessments[0]?.unknownEvidenceRefs).toEqual([]);
    expect(result.supportAssessments[0]?.evidenceDispositions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          evidenceRef: "session#turn-1",
          disposition: "causal_context",
          resolvedRole: "user",
        }),
        expect.objectContaining({
          evidenceRef: "session#turn-2",
          disposition: "supporting",
          resolvedRole: "assistant",
          evidenceUse: "shared_dialogue_artifact",
        }),
        expect.objectContaining({
          evidenceRef: "session#turn-3",
          disposition: "dominated_alternate",
          resolvedRole: "user",
        }),
      ]),
    );
    expect(result.notebook.coverage[0]?.selectedEvidenceRefs).toEqual([
      "session#turn-2",
    ]);
    expect(result.notebook.coverage[0]?.selectedEvidenceRefs).not.toContain(
      "session#turn-1",
    );
    expect(result.packetSources[0]?.text).toContain("Northstar");
    expect(projectEvidenceFirstMemoryContextPacketV1(result).stop).toBe(
      "sufficient",
    );
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
          "paw.memory-evidence-query-planner.v11:closure-deficiency-replan",
        async plan() {
          return {
            plannerVersion:
              "paw.memory-evidence-query-planner.v11:closure-deficiency-replan",
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
          expect(input.certifiedAssistantDialogueEvidenceRefs).toBeUndefined();
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
    expect(
      result.packetSources.flatMap((source) => source.evidenceBindings),
    ).toContainEqual({
      evidenceRef: "session-2#turn-2",
      evidenceUse: "assistant_report",
    });
    expect(
      result.packetSources.flatMap((source) => source.evidenceBindings),
    ).not.toContainEqual({
      evidenceRef: "session-2#turn-2",
      evidenceUse: "shared_dialogue_artifact",
    });
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
          "paw.memory-evidence-query-planner.v11:closure-deficiency-replan",
        async plan() {
          return {
            plannerVersion:
              "paw.memory-evidence-query-planner.v11:closure-deficiency-replan",
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

  test("locates direct assistant requirements independently without cross-leaf rollback", async () => {
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
    let selectorCertifiedRefs: readonly string[] | undefined;
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
          "paw.memory-evidence-query-planner.v11:closure-deficiency-replan",
        async plan() {
          return {
            plannerVersion:
              "paw.memory-evidence-query-planner.v11:closure-deficiency-replan",
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
          selectorCertifiedRefs = input.certifiedAssistantDialogueEvidenceRefs;
          return {
            selectorVersion: "test-selector.v1",
            selectionRevision: "selected-local-batch",
            assessments: requirements.map((requirement, index) => ({
              requirementId: requirement.requirementId,
              supportingEvidenceRefs:
                failSecond && index === 1
                  ? []
                  : [`session-1#turn-${index === 0 ? 2 : 4}`],
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
    expect(selectorCertifiedRefs).toEqual([
      "session-1#turn-2",
      "session-1#turn-4",
    ]);
    expect(result.sourceLocalization).toMatchObject({
      executor: "per_leaf_v25",
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
    expect(selectorCandidateRefs).toContain("session-1#turn-2");
    expect(selectorCandidateRefs).not.toContain("session-1#turn-4");
    expect(fallback.sourceLocalization).toMatchObject({
      executor: "per_leaf_v25",
      status: "completed",
      reasonCode: "partial_evidence_anchor_found",
      addedCandidateCount: 1,
      selectedCandidateCount: 1,
      leaves: [
        { status: "completed", localizedHitCount: 1 },
        { status: "fallback", localizedHitCount: 0 },
      ],
    });
    expect(fallback.packetSources[0]?.text).toContain("assistant answer 2");
    expect(fallback.packetSources[0]?.text).not.toContain("assistant answer 4");
    expect(
      fallback.packetSources.map((source) => source.text).join("\n"),
    ).not.toContain("unselected assistant fallback must stay closed");
  });

  test("keeps semantically unknown dialogue candidates out of the answer packet", async () => {
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
            "paw.memory-evidence-query-planner.v11:closure-deficiency-replan",
          async plan() {
            return {
              plannerVersion:
                "paw.memory-evidence-query-planner.v11:closure-deficiency-replan",
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
                  contextEvidenceRefs: ["session-1#turn-1", "session-1#turn-2"],
                  sourceKind: "assistant_output" as const,
                  content,
                  authority: "context_only" as const,
                  turnOrder: 2,
                  includedTurns: [
                    {
                      evidenceRef: "session-1#turn-1",
                      sourceKind: "user_input" as const,
                      turnOrder: 1,
                    },
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
                includedTurnCount: 2,
                renderedChars: content.length,
                cacheHit: false,
                durationMs: 1,
              },
            };
          },
        },
        sourceLocalHydrator: sourceLocalHydrator({
          "session-1#turn-1": "baseline only",
          "session-1#turn-2": "local secret answer",
        }),
      };
    const selector = {
      selectorVersion: "test-selector.v1",
      async select(input: {
        readonly candidates: readonly { readonly evidenceRef: string }[];
        readonly requirements: readonly { readonly roleConstraint: string }[];
      }) {
        const hasLocal = input.candidates.some(
          (candidate) => candidate.evidenceRef === "session-1#turn-2",
        );
        const ambiguous = input.requirements[0]?.roleConstraint === "any";
        return {
          selectorVersion: "test-selector.v1",
          selectionRevision: "reject-local",
          assessments: [
            {
              requirementId: requirement.requirementId,
              supportingEvidenceRefs: ambiguous ? [] : ["session-1#turn-1"],
              contradictingEvidenceRefs: [],
              unknownEvidenceRefs: ambiguous
                ? input.candidates.map((candidate) => candidate.evidenceRef)
                : hasLocal
                  ? ["session-1#turn-2"]
                  : [],
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
    expect(rejected.packetSources).toEqual(baseline.packetSources);
    expect(rejected.packetSources[0]?.text ?? "").not.toContain(
      "local secret answer",
    );

    const ambiguous = await createMemoryEvidenceResolverV1({
      ...resolverInput,
      planner: {
        plannerVersion:
          "paw.memory-evidence-query-planner.v11:closure-deficiency-replan",
        async plan() {
          return {
            plannerVersion:
              "paw.memory-evidence-query-planner.v11:closure-deficiency-replan",
            answerShape: "lookup" as const,
            temporalMode: "any" as const,
            roleConstraint: "any" as const,
            needsPlanning: true,
            requirements: [{ ...requirement, roleConstraint: "any" as const }],
          };
        },
      },
      supportSelector: selector,
    }).resolve(
      "Can you remind me what happened to the report you wrote?",
      new AbortController().signal,
    );
    expect(ambiguous.sourceLocalization).toMatchObject({
      status: "completed",
      addedCandidateCount: 1,
      selectedCandidateCount: 0,
    });
    expect(
      ambiguous.packetSources.map((source) => source.text).join("\n"),
    ).not.toContain("local secret answer");

    const userOwnedDialogueArtifact = await createMemoryEvidenceResolverV1({
      ...resolverInput,
      planner: {
        plannerVersion:
          "paw.memory-evidence-query-planner.v11:closure-deficiency-replan",
        async plan() {
          return {
            plannerVersion:
              "paw.memory-evidence-query-planner.v11:closure-deficiency-replan",
            answerShape: "lookup" as const,
            temporalMode: "any" as const,
            roleConstraint: "user" as const,
            needsPlanning: true,
            requirements: [
              {
                ...requirement,
                roleConstraint: "user" as const,
              },
            ],
          };
        },
      },
      supportSelector: {
        selectorVersion: "test-selector.v1",
        async select(input) {
          return {
            selectorVersion: "test-selector.v1",
            selectionRevision: "user-owned-artifact-unresolved",
            assessments: [
              {
                requirementId: requirement.requirementId,
                supportingEvidenceRefs: [],
                contradictingEvidenceRefs: [],
                unknownEvidenceRefs: input.candidates.map(
                  (candidate) => candidate.evidenceRef,
                ),
              },
            ],
          };
        },
      },
    }).resolve(
      "In our previous conversation, what was my draft title?",
      new AbortController().signal,
    );
    expect(userOwnedDialogueArtifact.intent.roleConstraint).toBe("user");
    expect(userOwnedDialogueArtifact.sourceLocalization).toMatchObject({
      status: "completed",
      addedCandidateCount: 1,
      selectedCandidateCount: 0,
    });
    expect(
      userOwnedDialogueArtifact.packetSources
        .map((source) => source.text)
        .join("\n"),
    ).not.toContain("local secret answer");
    expect(userOwnedDialogueArtifact.requirementEvidence[0]).toMatchObject({
      supportingEvidenceRefs: [],
      candidateEvidenceRefs: ["session-1#turn-1"],
      contradictingEvidenceRefs: [],
    });
    expect(
      projectEvidenceFirstMemoryAnswerContractV1(userOwnedDialogueArtifact)
        .requirements[0]?.candidateEvidenceRefs,
    ).toEqual(["session-1#turn-1"]);

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

  test("does not expose an ordinary source-local user fact that remains semantically unknown", async () => {
    const query = "How many plan changes did I describe?";
    const requirement = {
      requirementId: "plan-changes",
      label: "all plan changes",
      searchText: "focused plan changes",
      temporalMode: "any" as const,
      roleConstraint: "user" as const,
      relation: "comparative" as const,
      coverageMode: "all" as const,
      minimumEvidence: 2,
    };
    const resolver = createMemoryEvidenceResolverV1({
      index: {
        indexVersion: "test-index.v1",
        async search(searchText) {
          const focused = searchText !== query;
          const sourceId = focused ? "session-2" : "session-1";
          const evidenceRef = focused ? "session-2#turn-1" : "session-1#turn-1";
          return {
            lists: [
              {
                channel: "l0" as const,
                retrieverId: "global",
                weight: focused ? 0.1 : 1,
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
                content: focused
                  ? "An unrelated session mentioned a different plan."
                  : "I changed the first part of the plan.",
                authority: "user_asserted" as const,
                sourceKind: "user_input" as const,
                episodeOrder: 1,
                turnOrder: 1,
              },
            ],
          };
        },
      },
      planner: {
        plannerVersion:
          "paw.memory-evidence-query-planner.v11:closure-deficiency-replan",
        async plan() {
          return {
            plannerVersion:
              "paw.memory-evidence-query-planner.v11:closure-deficiency-replan",
            answerShape: "aggregate" as const,
            temporalMode: "any" as const,
            roleConstraint: "user" as const,
            needsPlanning: true,
            requirements: [requirement],
          };
        },
      },
      sourceLocalLocator: {
        locatorVersion: "test-source-local.v1",
        async locate() {
          const content = "I later changed the second part of the plan.";
          return {
            locatorVersion: "test-source-local.v1",
            locatorRevision: "ordinary-user-gap",
            hits: [
              {
                sourceId: "session-1",
                evidenceRef: "session-1#turn-3",
                anchorEvidenceRef: "session-1#turn-3",
                contextEvidenceRefs: ["session-1#turn-3"],
                sourceKind: "user_input" as const,
                content,
                authority: "user_asserted" as const,
                episodeOrder: 2,
                turnOrder: 3,
                includedTurns: [
                  {
                    evidenceRef: "session-1#turn-3",
                    sourceKind: "user_input" as const,
                    turnOrder: 3,
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
        "session-1#turn-3": "I later changed the second part of the plan.",
      }),
      supportSelector: {
        selectorVersion: "test-selector.v1",
        async select(input) {
          expect(input.certifiedAssistantDialogueEvidenceRefs).toBeUndefined();
          return {
            selectorVersion: "test-selector.v1",
            selectionRevision: "partial-support",
            assessments: [
              {
                requirementId: requirement.requirementId,
                supportingEvidenceRefs: ["session-1#turn-1"],
                contradictingEvidenceRefs: [],
                unknownEvidenceRefs: ["session-1#turn-3", "session-2#turn-1"],
              },
            ],
          };
        },
      },
      maxSources: 1,
    });

    const result = await resolver.resolve(query, new AbortController().signal);

    expect(result.notebook.coverage[0]?.status).toBe("partial");
    expect(result.notebook.coverage[0]?.selectedEvidenceRefs).toEqual([
      "session-1#turn-1",
    ]);
    expect(result.sourceLocalization).toMatchObject({
      executor: "plan_scoped_v24",
      status: "completed",
      selectedCandidateCount: 0,
      retainedContextCandidateCount: 0,
    });
    expect(result.packetSources[0]?.answerRole).toBe("supporting");
    expect(result.packetSources[0]?.text).not.toContain(
      "I later changed the second part of the plan.",
    );
    expect(result.packetSources.map((source) => source.sourceId)).toEqual([
      "session-1",
    ]);
    expect(
      result.packetSources.map((source) => source.text).join("\n"),
    ).not.toContain("unrelated session");
  });

  test("retries a failed recommendation selector against the immutable baseline once", async () => {
    const requirement = {
      requirementId: "recommendation-input",
      label: "direct preference evidence",
      searchText: "direct preference evidence",
      temporalMode: "any" as const,
      roleConstraint: "user" as const,
      relation: "direct" as const,
      coverageMode: "any" as const,
      minimumEvidence: 1,
    };
    let selectorCalls = 0;
    let rejectBaseline = false;
    let semanticUnknown = false;
    const candidateRefsByAttempt: string[][] = [];
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
                    candidateId: "baseline-preference",
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
                content: "I prefer the baseline option.",
                authority: "user_asserted" as const,
                sourceKind: "user_input" as const,
                episodeOrder: 1,
                turnOrder: 1,
              },
            ],
          };
        },
      },
      planner: {
        plannerVersion:
          "paw.memory-evidence-query-planner.v11:closure-deficiency-replan",
        async plan() {
          return {
            plannerVersion:
              "paw.memory-evidence-query-planner.v11:closure-deficiency-replan",
            answerShape: "recommend" as const,
            temporalMode: "any" as const,
            roleConstraint: "user" as const,
            needsPlanning: true,
            requirements: [requirement],
          };
        },
      },
      sourceLocalLocator: {
        locatorVersion: "test-source-local.v1",
        async locate() {
          const content = "A localized preference candidate.";
          return {
            locatorVersion: "test-source-local.v1",
            locatorRevision: "recommendation-local",
            hits: [
              {
                sourceId: "session-1",
                evidenceRef: "session-1#turn-3",
                anchorEvidenceRef: "session-1#turn-3",
                contextEvidenceRefs: ["session-1#turn-3"],
                sourceKind: "user_input" as const,
                content,
                authority: "user_asserted" as const,
                episodeOrder: 2,
                turnOrder: 3,
                includedTurns: [
                  {
                    evidenceRef: "session-1#turn-3",
                    sourceKind: "user_input" as const,
                    turnOrder: 3,
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
        "session-1#turn-3": "A localized preference candidate.",
      }),
      supportSelector: {
        selectorVersion: "test-selector.v1",
        async select(input) {
          selectorCalls += 1;
          const refs = input.candidates.map(
            (candidate) => candidate.evidenceRef,
          );
          candidateRefsByAttempt.push(refs);
          if (semanticUnknown) {
            return {
              selectorVersion: "test-selector.v1",
              selectionRevision: "semantic-unknown-selection",
              assessments: [
                {
                  requirementId:
                    input.requirements[0]?.requirementId ??
                    requirement.requirementId,
                  supportingEvidenceRefs: [],
                  contradictingEvidenceRefs: [],
                  unknownEvidenceRefs: refs,
                },
              ],
            };
          }
          if (selectorCalls % 2 === 1 || rejectBaseline) {
            const error = new Error("invalid augmented address");
            error.name = "MemoryEvidenceSupportAddressInvalid";
            throw error;
          }
          return {
            selectorVersion: "test-selector.v1",
            selectionRevision: "baseline-recommendation-selection",
            assessments: [
              {
                requirementId:
                  input.requirements[0]?.requirementId ??
                  requirement.requirementId,
                supportingEvidenceRefs: ["session-1#turn-1"],
                contradictingEvidenceRefs: [],
                unknownEvidenceRefs: refs.filter(
                  (evidenceRef) => evidenceRef !== "session-1#turn-1",
                ),
              },
            ],
          };
        },
      },
    });

    const result = await resolver.resolve(
      "Based on my history, what should I choose next?",
      new AbortController().signal,
    );

    expect(selectorCalls).toBe(2);
    expect(candidateRefsByAttempt[0]).toContain("session-1#turn-3");
    expect(candidateRefsByAttempt[1]).not.toContain("session-1#turn-3");
    expect(result.supportSelectorStatus).toBe("completed");
    expect(result.notebook.coverage[0]?.status).toBe("covered");
    expect(result.sourceLocalization).toMatchObject({
      executor: "per_leaf_v25",
      status: "fallback",
      reasonCode: "selector_baseline_fallback",
      selectorAttempts: 2,
      selectorCommittedAttempt: "baseline",
      addedCandidateCount: 0,
    });
    expect(
      result.packetSources.map((source) => source.text).join("\n"),
    ).not.toContain("localized preference candidate");

    semanticUnknown = true;
    const unknown = await resolver.resolve(
      "Based on my history, what should I choose next?",
      new AbortController().signal,
    );
    expect(selectorCalls).toBe(3);
    expect(unknown.supportSelectorStatus).toBe("completed");
    expect(unknown.supportAssessments).toHaveLength(1);
    expect(unknown.supportAssessments[0]?.supportingEvidenceRefs).toEqual([]);
    expect(unknown.sourceLocalization).toMatchObject({
      selectorAttempts: 1,
      selectorCommittedAttempt: "augmented",
    });

    semanticUnknown = false;
    rejectBaseline = true;
    const failed = await resolver.resolve(
      "Based on my history, what should I choose next?",
      new AbortController().signal,
    );
    expect(selectorCalls).toBe(5);
    expect(failed.supportSelectorStatus).toBe("fallback");
    expect(failed.supportAssessments).toEqual([]);
    expect(failed.sourceLocalization).toMatchObject({
      status: "fallback",
      reasonCode: "selector_failed",
      selectorAttempts: 2,
      selectorCommittedAttempt: "none",
      addedCandidateCount: 0,
    });
  });

  test("commits independent selector groups from one model response", async () => {
    const requirements = [
      {
        requirementId: "independent-a",
        label: "first independent fact",
        searchText: "first independent fact",
        temporalMode: "history" as const,
        roleConstraint: "user" as const,
        relation: "direct" as const,
        coverageMode: "any" as const,
        minimumEvidence: 1,
        dependencyRelation: "independent" as const,
        dependsOnRequirementIds: [] as const,
      },
      {
        requirementId: "independent-b",
        label: "second independent fact",
        searchText: "second independent fact",
        temporalMode: "history" as const,
        roleConstraint: "user" as const,
        relation: "direct" as const,
        coverageMode: "any" as const,
        minimumEvidence: 1,
        dependencyRelation: "independent" as const,
        dependsOnRequirementIds: [] as const,
      },
    ];
    let strictCalls = 0;
    let groupedCalls = 0;
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
                    candidateId: "candidate-a",
                    sourceId: "session-a",
                    evidenceRef: "session-a#turn-1",
                    sourceKind: "user_input" as const,
                    authority: "user_asserted" as const,
                  },
                  {
                    candidateId: "candidate-b",
                    sourceId: "session-b",
                    evidenceRef: "session-b#turn-1",
                    sourceKind: "user_input" as const,
                    authority: "user_asserted" as const,
                  },
                ],
              },
            ],
            hits: [
              {
                sourceId: "session-a",
                evidenceRef: "session-a#turn-1",
                content: "The first independent fact.",
                authority: "user_asserted" as const,
                sourceKind: "user_input" as const,
                episodeOrder: 1,
                turnOrder: 1,
              },
              {
                sourceId: "session-b",
                evidenceRef: "session-b#turn-1",
                content: "The second independent fact.",
                authority: "user_asserted" as const,
                sourceKind: "user_input" as const,
                episodeOrder: 2,
                turnOrder: 1,
              },
            ],
          };
        },
      },
      planner: {
        plannerVersion: "test-planner.v1",
        async plan() {
          return {
            plannerVersion: "test-planner.v1",
            answerShape: "aggregate" as const,
            temporalMode: "history" as const,
            roleConstraint: "user" as const,
            needsPlanning: true,
            requirements,
          };
        },
      },
      supportSelector: {
        selectorVersion: "test-group-selector.v1",
        async select() {
          strictCalls += 1;
          throw new Error("strict selector must not run");
        },
        async selectGrouped(input, groups) {
          groupedCalls += 1;
          const secondScope = input.candidateScopes?.find(
            (scope) => scope.requirementId === "independent-b",
          );
          const supportingEvidenceRef = secondScope?.evidenceRefs[0];
          if (!supportingEvidenceRef) {
            throw new Error("second group fixture has no candidate");
          }
          return {
            selectorVersion: "test-group-selector.v1",
            selectionRevision: "group-selection-revision",
            groups: groups.map((group) =>
              group.requirementIds.includes("independent-a")
                ? {
                    groupId: group.groupId,
                    status: "fallback" as const,
                    assessments: [],
                    failureCodes: ["MemoryEvidenceSupportAddressInvalid"],
                  }
                : {
                    groupId: group.groupId,
                    status: "completed" as const,
                    assessments: [
                      {
                        requirementId: "independent-b",
                        supportingEvidenceRefs: [supportingEvidenceRef],
                        contradictingEvidenceRefs: [],
                        unknownEvidenceRefs: [],
                      },
                    ],
                    failureCodes: [],
                  },
            ),
          };
        },
      },
    });

    const result = await resolver.resolve(
      "List all independent facts from my history.",
      new AbortController().signal,
    );

    expect(strictCalls).toBe(0);
    expect(groupedCalls).toBe(1);
    expect(result.supportSelectorStatus).toBe("partial");
    expect(result.supportAssessments.map((item) => item.requirementId)).toEqual(
      ["independent-b"],
    );
    // The failed group's requirement keeps lane-ranked candidates bound by the
    // deterministic support floor; the committed group keeps its selection.
    expect(result.notebook.coverage.map((item) => item.status)).toEqual([
      "covered",
      "covered",
    ]);
    expect(result.sourceLocalization).toMatchObject({
      selectorGroupCount: 2,
      selectorCommittedGroupCount: 1,
      selectorFailedGroupCount: 1,
      selectorTotalAttemptCount: 1,
    });
    expect(
      result.sourceLocalization.deterministicSupportFloor
        ?.flooredRequirementCount,
    ).toBe(1);
  });

  test("rolls back an ordinary plan-scoped localization as one transaction", async () => {
    const requirements = [
      {
        requirementId: "history-a",
        label: "first history operand",
        searchText: "first history operand",
        temporalMode: "range" as const,
        roleConstraint: "user" as const,
        relation: "comparative" as const,
        coverageMode: "any" as const,
        minimumEvidence: 1,
      },
      {
        requirementId: "history-b",
        label: "second history operand",
        searchText: "second history operand",
        temporalMode: "range" as const,
        roleConstraint: "user" as const,
        relation: "comparative" as const,
        coverageMode: "any" as const,
        minimumEvidence: 1,
      },
    ];
    const locatorCalls: string[] = [];
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
                    candidateId: "baseline",
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
                content: "baseline history evidence",
                authority: "user_asserted" as const,
                sourceKind: "user_input" as const,
                episodeOrder: 1,
                turnOrder: 1,
              },
            ],
          };
        },
      },
      planner: {
        plannerVersion:
          "paw.memory-evidence-query-planner.v11:closure-deficiency-replan",
        async plan() {
          return {
            plannerVersion:
              "paw.memory-evidence-query-planner.v11:closure-deficiency-replan",
            answerShape: "compare" as const,
            temporalMode: "range" as const,
            roleConstraint: "user" as const,
            needsPlanning: true,
            requirements,
          };
        },
      },
      sourceLocalLocator: {
        locatorVersion: "test-source-local.v1",
        async locate(request) {
          locatorCalls.push(request.requirement.requirementId);
          if (request.requirement.requirementId === "history-b") {
            throw new Error("second plan leaf unavailable");
          }
          const content = "localized first history operand";
          return {
            locatorVersion: "test-source-local.v1",
            locatorRevision: "first-plan-leaf",
            hits: [
              {
                sourceId: "session-1",
                evidenceRef: "session-1#turn-3",
                anchorEvidenceRef: "session-1#turn-3",
                contextEvidenceRefs: ["session-1#turn-3"],
                sourceKind: "user_input" as const,
                content,
                authority: "user_asserted" as const,
                episodeOrder: 2,
                turnOrder: 3,
                includedTurns: [
                  {
                    evidenceRef: "session-1#turn-3",
                    sourceKind: "user_input" as const,
                    turnOrder: 3,
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
        "session-1#turn-3": "localized first history operand",
      }),
      supportSelector: {
        selectorVersion: "test-selector.v1",
        async select(input) {
          selectorCandidateRefs = input.candidates.map(
            (candidate) => candidate.evidenceRef,
          );
          return {
            selectorVersion: "test-selector.v1",
            selectionRevision: "baseline-after-plan-rollback",
            assessments: requirements.map((requirement) => ({
              requirementId: requirement.requirementId,
              supportingEvidenceRefs: [],
              contradictingEvidenceRefs: [],
              unknownEvidenceRefs: input.candidates
                .filter((candidate) =>
                  input.candidateScopes
                    ?.find(
                      (scope) =>
                        scope.requirementId === requirement.requirementId,
                    )
                    ?.evidenceRefs.includes(candidate.evidenceRef),
                )
                .map((candidate) => candidate.evidenceRef),
            })),
          };
        },
      },
    });

    const result = await resolver.resolve(
      "What is the difference between my old and current commute?",
      new AbortController().signal,
    );

    expect(locatorCalls).toEqual(["history-a", "history-b"]);
    expect(selectorCandidateRefs).not.toContain("session-1#turn-3");
    expect(result.sourceLocalization).toMatchObject({
      executor: "plan_scoped_v24",
      status: "fallback",
      reasonCode: "locator_failed",
      addedCandidateCount: 0,
      leaves: [{ status: "fallback" }, { status: "fallback" }],
    });
  });

  test("locks sources only after bounded planned discovery", async () => {
    const resolver = createMemoryEvidenceResolverV1({
      index: index(),
      planner: {
        plannerVersion:
          "paw.memory-evidence-query-planner.v11:closure-deficiency-replan",
        async plan() {
          return {
            plannerVersion:
              "paw.memory-evidence-query-planner.v11:closure-deficiency-replan",
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
      "a",
      "b",
      "c",
    ]);
    expect(result.notebook.sources.map((source) => source.sourceId)).toEqual([
      "c",
      "b",
    ]);
    expect(result.packetSources.map((source) => source.sourceId)).toEqual([
      "a",
      "b",
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
    expect(result).not.toHaveProperty("directCertificateStatus");
    expect(result.notebook.coverage).toHaveLength(0);
    expect(result.primaryHits).toHaveLength(2);
    expect(result.packetSources).toHaveLength(2);
    expect(result.packetSources[0]?.text).toContain(
      "Primary exact memory evidence",
    );
  });

  test("requires semantic support even for a lexically obvious direct hit", async () => {
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
      "What is my favorite color?",
      new AbortController().signal,
    );

    expect(result).not.toHaveProperty("directCertificateStatus");
    expect(result.supportSelectorStatus).toBe("completed");
    expect(result.notebook.coverage[0]?.status).toBe("covered");
    expect(result.packetSources[0]?.answerRole).toBe("supporting");
    expect(projectEvidenceFirstMemoryContextPacketV1(result).stop).toBe(
      "sufficient",
    );
    expect(selectorCalls).toBe(1);
  });

  test("uses the same planner path for single-source and multi-source lookups", async () => {
    const forceValues: Array<boolean | undefined> = [];
    const planner = {
      plannerVersion:
        "paw.memory-evidence-query-planner.v11:closure-deficiency-replan" as const,
      async plan(
        _query: string,
        _signal: AbortSignal,
        options?: Readonly<{ force?: boolean }>,
      ) {
        forceValues.push(options?.force);
        return {
          plannerVersion:
            "paw.memory-evidence-query-planner.v11:closure-deficiency-replan" as const,
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

    expect(forceValues).toEqual([true, true]);
    expect(singleResult.plannerStatus).toBe("completed");
    expect(singleResult).not.toHaveProperty("directCertificateStatus");
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
          "paw.memory-evidence-query-planner.v11:closure-deficiency-replan",
        async plan() {
          plannerCalls += 1;
          return {
            plannerVersion:
              "paw.memory-evidence-query-planner.v11:closure-deficiency-replan",
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
    expect(result).not.toHaveProperty("directCertificateStatus");
  });

  test("treats an empty complex plan as fallback instead of completed", async () => {
    const resolver = createMemoryEvidenceResolverV1({
      index: index(),
      planner: {
        plannerVersion:
          "paw.memory-evidence-query-planner.v11:closure-deficiency-replan",
        async plan() {
          return {
            plannerVersion:
              "paw.memory-evidence-query-planner.v11:closure-deficiency-replan",
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
                supportingEvidenceRefs: ["ref-a", "ref-b"],
                contradictingEvidenceRefs: [],
                unknownEvidenceRefs: [],
              },
            ],
          };
        },
      },
      closureAuditor: {
        auditorVersion: "test-auditor.v1",
        async audit(_input) {
          return {
            auditorVersion: "test-auditor.v1",
            auditRevision: "fallback-closure-pass",
            decision: "pass" as const,
            deficiencies: [],
            rejectedEvidenceRefs: [],
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
    expect(result.notebook.coverage[0]?.status).toBe("covered");
    expect(result.closureVerdict).toBe("pass");
    expect(projectEvidenceFirstMemoryContextPacketV1(result).stop).toBe(
      "sufficient",
    );
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
          "paw.memory-evidence-query-planner.v11:closure-deficiency-replan",
        async plan() {
          return {
            plannerVersion:
              "paw.memory-evidence-query-planner.v11:closure-deficiency-replan",
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

  test("expands only aggregate evidence budgets beyond the direct lookup cap", async () => {
    const hits = Array.from({ length: 6 }, (_, index) => ({
      sourceId: `session-${index + 1}`,
      evidenceRef: `session-${index + 1}#turn-1`,
      content: `Milestone ${index + 1} was completed.`,
      authority: "user_asserted" as const,
      sourceKind: "user_input" as const,
      episodeOrder: index + 1,
      turnOrder: 1,
    }));
    const resolver = createMemoryEvidenceResolverV1({
      index: {
        indexVersion: "test-index.v1",
        async search() {
          return {
            lists: [
              {
                channel: "l0" as const,
                retrieverId: "milestones",
                weight: 1,
                candidates: hits.map((hit) => ({
                  candidateId: hit.evidenceRef,
                  sourceId: hit.sourceId,
                  evidenceRef: hit.evidenceRef,
                  sourceKind: hit.sourceKind,
                  authority: hit.authority,
                })),
              },
            ],
            hits,
          };
        },
      },
      planner: {
        plannerVersion:
          "paw.memory-evidence-query-planner.v11:closure-deficiency-replan",
        async plan(query) {
          const aggregate = query.startsWith("How many");
          return {
            plannerVersion:
              "paw.memory-evidence-query-planner.v11:closure-deficiency-replan",
            answerShape: aggregate
              ? ("aggregate" as const)
              : ("lookup" as const),
            temporalMode: "any" as const,
            roleConstraint: "user" as const,
            needsPlanning: aggregate,
            requirements: [
              {
                requirementId: "milestones",
                label: "completed milestones",
                searchText: "milestones completed",
                temporalMode: "any" as const,
                roleConstraint: "user" as const,
                relation: aggregate
                  ? ("comparative" as const)
                  : ("direct" as const),
                coverageMode: aggregate ? ("all" as const) : ("any" as const),
                minimumEvidence: aggregate ? 2 : 1,
              },
            ],
          };
        },
      },
      supportSelector: {
        selectorVersion: "test-selector.v1",
        async select(input) {
          return {
            selectorVersion: "test-selector.v1",
            selectionRevision: "all-milestones",
            assessments: [
              {
                requirementId: requiredAt(input.requirements, 0).requirementId,
                supportingEvidenceRefs: hits.map((hit) => hit.evidenceRef),
                contradictingEvidenceRefs: [],
                unknownEvidenceRefs: [],
              },
            ],
          };
        },
      },
      maxSources: 8,
      maxHitsPerRequirement: 8,
      maxNotebookChars: 8_192,
    });

    const result = await resolver.resolve(
      "How many milestones did I complete?",
      new AbortController().signal,
    );

    expect(result.plannerStatus).toBe("completed");
    expect(result.supportSelectorStatus).toBe("completed");
    expect(result.supportAssessments[0]?.supportingEvidenceRefs).toHaveLength(
      6,
    );
    expect(result.notebook.coverage[0]?.selectedEvidenceRefs).toHaveLength(6);
    expect(result.notebook.sources).toHaveLength(6);

    const direct = await resolver.resolve(
      "Which milestones did I complete?",
      new AbortController().signal,
    );
    expect(direct.notebook.coverage[0]?.selectedEvidenceRefs).toHaveLength(4);
  });

  test("keeps bounded candidates when latest-state support is still missing", async () => {
    const resolver = createMemoryEvidenceResolverV1({
      index: index(),
      planner: {
        plannerVersion:
          "paw.memory-evidence-query-planner.v11:closure-deficiency-replan",
        async plan() {
          return {
            plannerVersion:
              "paw.memory-evidence-query-planner.v11:closure-deficiency-replan",
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
    // Floor-bound latest-mode candidates stay requirement-bound in the packet.
    // The code-owned state reducer — not the selector — owns latest selection:
    // one observation resolves current, conflicting peers stay ambiguous, so
    // coverage is partial and the answer never claims unresolved state.
    expect(result.notebook.coverage[0]?.status).toBe("partial");
    expect(result.packetSources.map((source) => source.answerRole)).toContain(
      "current",
    );
    expect(
      result.packetSources.map((source) => source.answerRole),
    ).not.toContain("candidate");
    expect(result.packetSources.length).toBeGreaterThan(0);
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
          "paw.memory-evidence-query-planner.v11:closure-deficiency-replan",
        async plan() {
          return {
            plannerVersion:
              "paw.memory-evidence-query-planner.v11:closure-deficiency-replan",
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

  test("keeps closure audits observational unless repair is explicitly enabled", async () => {
    let plannerCalls = 0;
    let auditorCalls = 0;
    const resolver = createMemoryEvidenceResolverV1({
      index: {
        indexVersion: "test-index.v1",
        async search() {
          return {
            lists: [
              {
                retrieverId: "lexical",
                channel: "l0" as const,
                weight: 1,
                candidates: [
                  {
                    candidateId: "city-ref",
                    sourceId: "city-session",
                    evidenceRef: "city-ref",
                    sourceKind: "user_input" as const,
                    authority: "user_asserted" as const,
                  },
                ],
              },
            ],
            hits: [
              {
                sourceId: "city-session",
                evidenceRef: "city-ref",
                content: "My current city is Seattle.",
                authority: "user_asserted" as const,
                observedAt: "2025-01-01T00:00:00.000Z",
              },
            ],
          };
        },
      },
      planner: {
        plannerVersion: "test-planner.v1",
        async plan() {
          plannerCalls += 1;
          return {
            plannerVersion: "test-planner.v1",
            answerShape: "lookup" as const,
            temporalMode: "latest" as const,
            roleConstraint: "user" as const,
            needsPlanning: true,
            requirements: [
              {
                requirementId: "city",
                label: "Current city",
                searchText: "current city",
                temporalMode: "latest" as const,
                roleConstraint: "user" as const,
                relation: "direct" as const,
                coverageMode: "latest" as const,
                minimumEvidence: 1,
              },
            ],
          };
        },
      },
      supportSelector: {
        selectorVersion: "test-selector.v1",
        async select(input) {
          return {
            selectorVersion: "test-selector.v1",
            selectionRevision: "selection",
            assessments: input.requirements.map((requirement) => ({
              requirementId: requirement.requirementId,
              supportingEvidenceRefs: ["city-ref"],
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
            auditRevision: "observer-audit",
            decision: "incomplete" as const,
            deficiencies: [
              {
                reason: "weak_support" as const,
                targetRequirementId: "city",
              },
            ],
            rejectedEvidenceRefs: ["city-ref"],
          };
        },
      },
    });

    const result = await resolver.resolve(
      "What is my current city?",
      new AbortController().signal,
    );

    expect(result.closureMode).toBe("observe");
    expect(result.closureVerdict).toBe("insufficient");
    expect(result.closureRepairMode).toBe("none");
    expect(result.requirements.map((item) => item.requirementId)).toEqual([
      "city",
    ]);
    expect(
      result.packetSources.map((source) => source.text).join("\n"),
    ).toContain("Seattle");
    expect(plannerCalls).toBe(1);
    expect(auditorCalls).toBe(1);
  });

  test("repairs closure only inside locked sources without reopening global retrieval", async () => {
    const searchTexts: string[] = [];
    let selectorCalls = 0;
    let auditorCalls = 0;
    const oldRequirement = {
      requirementId: "old",
      label: "Old commute",
      searchText: "old commute",
      temporalMode: "range" as const,
      roleConstraint: "user" as const,
      relation: "comparative" as const,
      coverageMode: "any" as const,
      minimumEvidence: 1,
    };
    const currentRequirement = {
      requirementId: "current",
      label: "Current commute",
      searchText: "current commute",
      temporalMode: "range" as const,
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
          "paw.memory-evidence-query-planner.v11:closure-deficiency-replan",
        async plan(_query, _signal, options) {
          const requirements = options?.revision
            ? [
                oldRequirement,
                currentRequirement,
                {
                  ...currentRequirement,
                  requirementId: "current-detail",
                  label: "Current commute duration detail",
                  searchText: "current commute duration detail",
                },
              ]
            : [oldRequirement, currentRequirement];
          return {
            plannerVersion:
              "paw.memory-evidence-query-planner.v11:closure-deficiency-replan",
            answerShape: "compare" as const,
            temporalMode: "range" as const,
            roleConstraint: "user" as const,
            needsPlanning: true,
            requirements,
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
              supportingEvidenceRefs:
                selectorCalls === 1 && requirement.requirementId === "current"
                  ? []
                  : [
                      requirement.requirementId === "old"
                        ? "old-ref"
                        : "current-ref",
                    ],
              contradictingEvidenceRefs: [],
              unknownEvidenceRefs: [],
            })),
          };
        },
      },
      closureMode: "repair",
      closureAuditor: {
        auditorVersion: "test-auditor.v1",
        async audit() {
          auditorCalls += 1;
          if (auditorCalls > 1) {
            return {
              auditorVersion: "test-auditor.v1",
              auditRevision: "final-audit",
              decision: "incomplete" as const,
              deficiencies: [
                {
                  reason: "weak_support" as const,
                  targetRequirementId: "current-detail",
                },
              ],
              rejectedEvidenceRefs: [],
            };
          }
          return {
            auditorVersion: "test-auditor.v1",
            auditRevision: "repair-audit",
            decision: "incomplete" as const,
            deficiencies: [
              {
                reason: "missing_operand" as const,
                targetRequirementId: "current",
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
      "covered",
      "covered",
    ]);
    expect(result.closureAuditStatus).toBe("completed");
    expect(result.closureVerdict).toBe("insufficient");
    expect(result.closureRepairCount).toBe(1);
    expect(result.closureRepairMode).toBe("replan");
    expect(result.requirements).toHaveLength(3);
    expect(
      result.notebook.coverage.every((item) => item.status === "covered"),
    ).toBe(true);
    expect(selectorCalls).toBe(2);
    expect(auditorCalls).toBe(2);
    expect(
      searchTexts.filter((text) => text === "current commute"),
    ).toHaveLength(1);
    expect(
      result.sourceAcquisition.requirementContributions.map(
        (lane) => lane.requirementId,
      ),
    ).toEqual(["old", "current"]);
  });

  test("proposes exact temporal rounds only inside the frozen repair lock", async () => {
    const query = "What happened last month?";
    const observedAt = "2025-04-10T00:00:00.000Z";
    const baselineRef = "session-1#turn-1";
    const physicalBaselineAlias = "amb:document/session-1#source-1";
    const frontierRef = "session-1#turn-3";
    const contents: Readonly<Record<string, string>> = {
      [baselineRef]: "I mentioned an unrelated appointment.",
      [physicalBaselineAlias]: "I mentioned an unrelated appointment.",
      [frontierRef]: "I completed the relevant renewal event.",
    } as const;
    const locatorRequests: Array<{
      readonly lockedSourceIds: readonly string[];
      readonly temporalFrontier?: unknown;
    }> = [];
    let selectorCalls = 0;
    let auditorCalls = 0;
    const resolver = createMemoryEvidenceResolverV1({
      index: {
        indexVersion: "test-index.v1",
        async search() {
          return {
            lists: [
              {
                retrieverId: "lexical",
                channel: "l0" as const,
                weight: 1,
                candidates: [
                  {
                    candidateId: physicalBaselineAlias,
                    sourceId: "session-1",
                    evidenceRef: physicalBaselineAlias,
                    sourceKind: "user_input" as const,
                    authority: "user_asserted" as const,
                    observedAt,
                  },
                ],
              },
            ],
            hits: [
              {
                sourceId: "session-1",
                evidenceRef: physicalBaselineAlias,
                content:
                  contents[physicalBaselineAlias] ?? "missing test content",
                sourceKind: "user_input" as const,
                authority: "user_asserted" as const,
                observedAt,
                turnOrder: 1,
              },
            ],
          };
        },
      },
      planner: {
        plannerVersion: "test-temporal-planner.v1",
        async plan() {
          return {
            plannerVersion: "test-temporal-planner.v1",
            answerShape: "lookup" as const,
            temporalMode: "range" as const,
            roleConstraint: "user" as const,
            needsPlanning: true,
            requirements: [
              {
                requirementId: "event",
                label: "relevant event",
                searchText: "renewal event",
                temporalMode: "range" as const,
                roleConstraint: "user" as const,
                relation: "temporal" as const,
                coverageMode: "any" as const,
                minimumEvidence: 1,
              },
            ],
          };
        },
      },
      supportSelector: {
        selectorVersion: "test-selector.v1",
        async select(input) {
          selectorCalls += 1;
          const refs = input.candidates.map((item) => item.evidenceRef);
          return {
            selectorVersion: "test-selector.v1",
            selectionRevision: `selection-${selectorCalls}`,
            assessments: [
              {
                requirementId: "event",
                supportingEvidenceRefs:
                  refs.includes(frontierRef)
                    ? [frontierRef]
                    : [baselineRef],
                contradictingEvidenceRefs: [],
                unknownEvidenceRefs: refs.filter(
                  (evidenceRef) =>
                    refs.includes(frontierRef)
                      ? evidenceRef !== frontierRef
                      : evidenceRef !== baselineRef,
                ),
              },
            ],
          };
        },
      },
      sourceLocalLocator: {
        locatorVersion: "test-temporal-locator.v1",
        async locate(request) {
          locatorRequests.push(request);
          const refs = request.temporalFrontier
            ? [baselineRef, frontierRef]
            : [baselineRef];
          const hits = refs.map((evidenceRef) => {
            const turnOrder = evidenceRef === baselineRef ? 1 : 3;
            return {
              sourceId: "session-1",
              evidenceRef,
              anchorEvidenceRef: evidenceRef,
              contextEvidenceRefs: [evidenceRef],
              sourceKind: "user_input" as const,
                content: contents[evidenceRef] ?? "missing test content",
              authority: "user_asserted" as const,
              observedAt,
              turnOrder,
              includedTurns: [
                {
                  evidenceRef,
                  sourceKind: "user_input" as const,
                  observedAt,
                  turnOrder,
                },
              ],
            };
          });
          const temporalFrontier = request.temporalFrontier
            ? createMemoryTemporalEvidenceFrontierSnapshotV1({
                request,
                indexRevision: "turn-index-v1",
                postings: refs.map((evidenceRef) =>
                  createMemoryTemporalRoundPostingV1({
                    sourceId: "session-1",
                    evidenceRef,
                    role: "user_input",
                    contentDigest: hashTextV1(
                      contents[evidenceRef] ?? "missing test content",
                    ),
                    observedAt,
                    episodeOrder: 0,
                    turnOrder: evidenceRef === baselineRef ? 1 : 3,
                    timeBasis: "source_observed_at",
                  }),
                ),
                returnedEvidenceRefs: refs,
              })
            : undefined;
          return {
            locatorVersion: "test-temporal-locator.v1",
            locatorRevision: `locator-${locatorRequests.length}`,
            hits,
            degradedChannels: [] as const,
            telemetry: {
              lexicalCandidates: refs.length,
              denseCandidates: 0,
              anchorCount: refs.length,
              includedTurnCount: refs.length,
              renderedChars: hits.reduce(
                (total, hit) => total + hit.content.length,
                0,
              ),
              cacheHit: false,
              durationMs: 1,
            },
            ...(temporalFrontier === undefined
              ? {}
              : { temporalFrontier }),
          };
        },
      },
      sourceLocalHydrator: {
        hydratorVersion: "test-hydrator.v1",
        async hydrate(evidenceRefs) {
          return evidenceRefs.map((evidenceRef) => {
            const content = contents[evidenceRef];
            if (!content) throw new Error("missing test evidence");
            return {
              evidenceRef,
              sourceKind: "user_input" as const,
              turnOrder: evidenceRef === baselineRef ? 1 : 3,
              observedAt,
              content,
              contentHash: hashTextV1(content),
            };
          });
        },
      },
      temporalRoundFrontier: true,
      evidenceTimeUpperBound: "2025-05-20T00:00:00.000Z",
      closureMode: "repair",
      closureAuditor: {
        auditorVersion: "test-auditor.v1",
        async audit() {
          auditorCalls += 1;
          return auditorCalls === 1
            ? {
                auditorVersion: "test-auditor.v1",
                auditRevision: "repair-audit",
                decision: "incomplete" as const,
                deficiencies: [
                  {
                    reason: "missing_constraint" as const,
                    targetRequirementId: "event",
                  },
                ],
                rejectedEvidenceRefs: [],
              }
            : {
                auditorVersion: "test-auditor.v1",
                auditRevision: "final-audit",
                decision: "pass" as const,
                deficiencies: [],
                rejectedEvidenceRefs: [],
              };
        },
      },
    });

    const result = await resolver.resolve(query, new AbortController().signal);

    expect(locatorRequests).toHaveLength(2);
    expect(locatorRequests[0]?.temporalFrontier).toBeUndefined();
    expect(locatorRequests[1]?.temporalFrontier).toMatchObject({
      frontierVersion: PAW_MEMORY_TEMPORAL_EVIDENCE_FRONTIER_VERSION_V1,
      lanePolicy: "original_and_requirement",
      baselineEvidenceRefs: [baselineRef],
    });
    expect(locatorRequests[1]?.lockedSourceIds).toEqual(
      locatorRequests[0]?.lockedSourceIds,
    );
    expect(result.closureRepairCount).toBe(1);
    expect(result.notebook.coverage[0]?.selectedEvidenceRefs).toContain(
      frontierRef,
    );
  });

  test("replaces a stale single-slot latest requirement with its audited refinement", async () => {
    let selectorCalls = 0;
    let auditorCalls = 0;
    const resolver = createMemoryEvidenceResolverV1({
      index: {
        indexVersion: "test-index.v1",
        async search() {
          return {
            lists: [
              {
                retrieverId: "lexical",
                channel: "l0" as const,
                weight: 1,
                candidates: [
                  {
                    candidateId: "old-ref",
                    sourceId: "old-session",
                    evidenceRef: "old-ref",
                    sourceKind: "user_input" as const,
                    authority: "user_asserted" as const,
                  },
                  {
                    candidateId: "current-ref",
                    sourceId: "current-session",
                    evidenceRef: "current-ref",
                    sourceKind: "user_input" as const,
                    authority: "user_asserted" as const,
                  },
                ],
              },
            ],
            hits: [
              {
                sourceId: "old-session",
                evidenceRef: "old-ref",
                content: "My location was Portland.",
                authority: "user_asserted" as const,
                observedAt: "2024-01-01T00:00:00.000Z",
              },
              {
                sourceId: "current-session",
                evidenceRef: "current-ref",
                content: "My current location is Seattle.",
                authority: "user_asserted" as const,
                observedAt: "2025-01-01T00:00:00.000Z",
              },
            ],
          };
        },
      },
      planner: {
        plannerVersion:
          "paw.memory-evidence-query-planner.v11:closure-deficiency-replan",
        async plan(_query, _signal, options) {
          return {
            plannerVersion:
              "paw.memory-evidence-query-planner.v11:closure-deficiency-replan",
            answerShape: "lookup" as const,
            temporalMode: "latest" as const,
            roleConstraint: "user" as const,
            needsPlanning: true,
            requirements: [
              {
                requirementId: options?.revision
                  ? "current-location"
                  : "location",
                label: options?.revision ? "Current location" : "Location",
                searchText: options?.revision ? "current location" : "location",
                temporalMode: "latest" as const,
                roleConstraint: "user" as const,
                relation: "direct" as const,
                coverageMode: "latest" as const,
                minimumEvidence: 1,
              },
            ],
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
                requirement.requirementId === "location"
                  ? "old-ref"
                  : "current-ref",
              ],
              contradictingEvidenceRefs: [],
              unknownEvidenceRefs: [],
            })),
          };
        },
      },
      closureMode: "repair",
      closureAuditor: {
        auditorVersion: "test-auditor.v1",
        async audit() {
          auditorCalls += 1;
          if (auditorCalls > 1) {
            return {
              auditorVersion: "test-auditor.v1",
              auditRevision: "final-audit",
              decision: "pass" as const,
              deficiencies: [],
              rejectedEvidenceRefs: [],
            };
          }
          return {
            auditorVersion: "test-auditor.v1",
            auditRevision: "repair-audit",
            decision: "incomplete" as const,
            deficiencies: [
              {
                reason: "wrong_time" as const,
                targetRequirementId: "location",
              },
            ],
            rejectedEvidenceRefs: ["old-ref"],
          };
        },
      },
    });

    const result = await resolver.resolve(
      "Where do I currently live?",
      new AbortController().signal,
    );

    expect({
      status: result.closureAuditStatus,
      failure: result.closureAuditFailureCode,
      repairMode: result.closureRepairMode,
    }).toEqual({
      status: "completed",
      failure: undefined,
      repairMode: "replan",
    });
    expect(result.closureVerdict).toBe("pass");
    expect(result.requirements.map((item) => item.requirementId)).toEqual([
      "current-location",
    ]);
    expect(
      result.packetSources.map((source) => source.text).join("\n"),
    ).toContain("Seattle");
    expect(
      result.packetSources.map((source) => source.text).join("\n"),
    ).not.toContain("Portland");
    expect(selectorCalls).toBe(2);
    expect(auditorCalls).toBe(2);
  });

  test("settles an empty repaired packet without sending invalid input to the auditor", async () => {
    let selectorCalls = 0;
    let auditorCalls = 0;
    const resolver = createMemoryEvidenceResolverV1({
      index: {
        indexVersion: "test-index.v1",
        async search() {
          return {
            lists: [
              {
                retrieverId: "lexical",
                channel: "l0" as const,
                weight: 1,
                candidates: [
                  {
                    candidateId: "old-ref",
                    sourceId: "old-session",
                    evidenceRef: "old-ref",
                    sourceKind: "user_input" as const,
                    authority: "user_asserted" as const,
                  },
                ],
              },
            ],
            hits: [
              {
                sourceId: "old-session",
                evidenceRef: "old-ref",
                content: "My current location is Portland.",
                authority: "user_asserted" as const,
                observedAt: "2024-01-01T00:00:00.000Z",
              },
            ],
          };
        },
      },
      planner: {
        plannerVersion:
          "paw.memory-evidence-query-planner.v11:closure-deficiency-replan",
        async plan(_query, _signal, options) {
          return {
            plannerVersion:
              "paw.memory-evidence-query-planner.v11:closure-deficiency-replan",
            answerShape: "lookup" as const,
            temporalMode: "latest" as const,
            roleConstraint: "user" as const,
            needsPlanning: true,
            requirements: [
              {
                requirementId: options?.revision ? "revised" : "initial",
                label: options?.revision ? "Current location" : "Location",
                searchText: options?.revision ? "current location" : "location",
                temporalMode: "latest" as const,
                roleConstraint: "user" as const,
                relation: "direct" as const,
                coverageMode: "latest" as const,
                minimumEvidence: 1,
              },
            ],
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
              supportingEvidenceRefs: selectorCalls === 1 ? ["old-ref"] : [],
              contradictingEvidenceRefs: [],
              unknownEvidenceRefs: [],
            })),
          };
        },
      },
      closureMode: "repair",
      closureAuditor: {
        auditorVersion: "test-auditor.v1",
        async audit() {
          auditorCalls += 1;
          return {
            auditorVersion: "test-auditor.v1",
            auditRevision: "initial-audit",
            decision: "incomplete" as const,
            deficiencies: [
              {
                reason: "wrong_time" as const,
                targetRequirementId: "initial",
              },
            ],
            rejectedEvidenceRefs: ["old-ref"],
          };
        },
      },
    });

    const result = await resolver.resolve(
      "Where do I currently live?",
      new AbortController().signal,
    );

    expect(result.closureAuditStatus).toBe("completed");
    expect(result.closureVerdict).toBe("insufficient");
    expect(result.closureRepairMode).toBe("replan");
    expect(result.closureAuditFailureCode).toBeUndefined();
    expect(result.packetSources).toEqual([]);
    expect(selectorCalls).toBe(1);
    expect(auditorCalls).toBe(1);
  });
});
