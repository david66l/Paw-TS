import { describe, expect, test } from "bun:test";

import {
  type MemoryProviderV1,
  type MemoryRawEvidenceArchiveV1,
  PAW_NEXT_MEMORY_PLUGIN_POLICY_VERSION_V1,
  PAW_NEXT_MEMORY_V2_PROVIDER_VERSION_V1,
  type PawNextMemoryPluginProfileV1,
  createEvidenceFirstMemoryContextResolverV1,
  createMemoryEvidenceResolverV1,
  createProductMemoryEvidenceIndexV1,
  evidenceSourceIdV1,
  projectEvidenceFirstMemoryAnswerContractV1,
  projectEvidenceFirstMemoryContextPacketV1,
} from "../src/index.js";

const profile: PawNextMemoryPluginProfileV1 = {
  policyVersion: PAW_NEXT_MEMORY_PLUGIN_POLICY_VERSION_V1,
  mode: "read_only",
  providerVersion: PAW_NEXT_MEMORY_V2_PROVIDER_VERSION_V1,
  scope: {
    tenantId: "tenant",
    userId: "user",
    workspaceId: "workspace",
    repositoryId: "repository",
  },
  maxCards: 8,
  maxInjectedTokens: 2_048,
};

describe("product evidence adapter", () => {
  test("rejects an L0 archive bound to another memory scope", () => {
    const provider: MemoryProviderV1 = {
      providerVersion: PAW_NEXT_MEMORY_V2_PROVIDER_VERSION_V1,
      async retrieve() {
        return { status: "completed", cards: [] };
      },
    };
    const archive: MemoryRawEvidenceArchiveV1 = {
      scope: { ...profile.scope, userId: "another-user" },
      async put() {},
      async resolve() {
        return [];
      },
    };

    expect(() =>
      createProductMemoryEvidenceIndexV1({ profile, provider, archive }),
    ).toThrow("MemoryProductEvidenceArchiveScopeMismatch");
  });

  test("keeps L0 evidence when the L1 provider fails", async () => {
    const index = createProductMemoryEvidenceIndexV1({
      profile,
      provider: {
        providerVersion: PAW_NEXT_MEMORY_V2_PROVIDER_VERSION_V1,
        async retrieve() {
          throw new Error("provider unavailable");
        },
      },
      archive: {
        scope: profile.scope,
        async put() {},
        async resolve() {
          return [];
        },
        async search() {
          return [
            {
              evidenceRef: "runs/run-1/trajectory#step-2",
              sourceKind: "user_input",
              sourceSeq: 2,
              authority: "user_asserted",
              content: "[user_input hit] I visited Kyoto.",
              contentHash: "bundle-hash",
              hitContent: "I visited Kyoto.",
              hitContentHash: "hit-hash",
              createdAt: "2026-08-01T00:00:00.000Z",
            },
          ];
        },
      },
    });

    const result = await index.search(
      "Which city did I visit?",
      new AbortController().signal,
    );

    expect(result.degradedChannels).toEqual(["l1"]);
    expect(result.lists.map((list) => list.channel)).toEqual(["l0"]);
    expect(result.hits).toHaveLength(1);
  });

  test("never marks a channel-degraded packet sufficient", async () => {
    const evidenceResolver = createMemoryEvidenceResolverV1({
      index: {
        indexVersion: "degraded-index.v1",
        async search() {
          return {
            degradedChannels: ["l1"] as const,
            lists: [
              {
                channel: "l0" as const,
                retrieverId: "raw-only",
                weight: 1,
                candidates: [
                  {
                    candidateId: "session#turn-1",
                    sourceId: "session",
                    evidenceRef: "session#turn-1",
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
                content: "I visited Kyoto.",
                authority: "user_asserted" as const,
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
            selectionRevision: "degraded-selection",
            assessments: [
              {
                requirementId: input.requirements[0]!.requirementId,
                supportingEvidenceRefs: ["session#turn-1"],
                contradictingEvidenceRefs: [],
                unknownEvidenceRefs: [],
              },
            ],
          };
        },
      },
    });

    const packet = projectEvidenceFirstMemoryContextPacketV1(
      await evidenceResolver.resolve(
        "Which city did I visit?",
        new AbortController().signal,
      ),
    );

    expect(packet.requirements[0]?.status).toBe("covered");
    expect(packet.verification.status).toBe("failed");
    expect(packet.stop).toBe("partial");
  });

  test("keeps L1 navigation when the L0 archive search fails", async () => {
    const index = createProductMemoryEvidenceIndexV1({
      profile,
      provider: {
        providerVersion: PAW_NEXT_MEMORY_V2_PROVIDER_VERSION_V1,
        async retrieve() {
          return {
            status: "completed",
            cards: [
              {
                id: "memory-1",
                revision: 1,
                kind: "semantic",
                statement: "The user visited Kyoto.",
                applicability: "applicable",
                scope: { repositoryId: "repository" },
                sources: [
                  {
                    kind: "memory_store_evidence",
                    ref: "runs/run-1/trajectory#step-2",
                  },
                ],
                confidence: 0.9,
                contentHash: "memory-content-hash",
              },
            ],
          };
        },
      },
      archive: {
        scope: profile.scope,
        async put() {},
        async resolve() {
          return [];
        },
        async search() {
          throw new Error("archive unavailable");
        },
      },
    });

    const result = await index.search(
      "Which city did I visit?",
      new AbortController().signal,
    );

    expect(result.degradedChannels).toEqual(["l0"]);
    expect(result.lists.map((list) => list.channel)).toEqual(["l1"]);
    expect(result.hits).toEqual([]);
  });

  test("normalizes L0 and L1 pointers into one evidence resolver packet", async () => {
    let rawSearchCalls = 0;
    const provider: MemoryProviderV1 = {
      providerVersion: PAW_NEXT_MEMORY_V2_PROVIDER_VERSION_V1,
      async retrieve() {
        return {
          status: "completed",
          cards: [
            {
              id: "memory-1",
              revision: 1,
              kind: "semantic",
              statement: "The user visited Kyoto.",
              applicability: "applicable",
              scope: { repositoryId: "repository" },
              confidence: 0.9,
              sources: [
                {
                  kind: "memory_store_evidence",
                  ref: "runs/run-1/trajectory#step-2",
                },
              ],
              contentHash: "memory-content-hash",
            },
          ],
        };
      },
    };
    const archive: MemoryRawEvidenceArchiveV1 = {
      scope: profile.scope,
      async put() {},
      async resolve() {
        return [];
      },
      async search() {
        rawSearchCalls += 1;
        const city = rawSearchCalls === 1 ? "Kyoto" : "Osaka";
        return [
          {
            evidenceRef: "runs/run-1/trajectory#step-2",
            sourceKind: "user_input",
            sourceSeq: 2,
            authority: "user_asserted",
            content: `[user_input hit] I visited ${city}.`,
            contentHash: "bundle-hash",
            hitContent: `I visited ${city}.`,
            hitContentHash: "hit-hash",
            createdAt: "2026-08-01T00:00:00.000Z",
          },
        ];
      },
    };
    const evidenceResolver = createMemoryEvidenceResolverV1({
      index: createProductMemoryEvidenceIndexV1({
        profile,
        provider,
        archive,
      }),
    });
    const contextResolver = createEvidenceFirstMemoryContextResolverV1({
      evidenceResolver,
    });

    const packet = await contextResolver.resolve(
      "Which city did I visit?",
      new AbortController().signal,
    );

    expect(packet.stop).toBe("partial");
    expect(packet.evidence).toHaveLength(1);
    expect(packet.evidence[0]?.layer).toBe("L0");
    expect(packet.evidence[0]?.statement).toContain("I visited Kyoto");
    expect(packet.spans[0]?.evidenceRef).toContain("memory:notebook/");

    const refreshed = await contextResolver.resolve(
      "Which city did I visit?",
      new AbortController().signal,
    );
    expect(rawSearchCalls).toBe(2);
    expect(refreshed.evidence[0]?.statement).toContain("I visited Osaka");
  });

  test("uses the immutable source root before the evidence fragment", () => {
    expect(evidenceSourceIdV1("runs/run-1/trajectory#step-9")).toBe(
      "runs/run-1/trajectory",
    );
  });

  test("never declares a failed complex plan sufficient from one selected source", async () => {
    const evidenceResolver = createMemoryEvidenceResolverV1({
      index: {
        indexVersion: "single-source-complex.v1",
        async search() {
          return {
            lists: [
              {
                channel: "l0" as const,
                retrieverId: "exact-address",
                weight: 1,
                candidates: [
                  {
                    candidateId: "session#turn-1",
                    sourceId: "session",
                    evidenceRef: "session#turn-1",
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
                content: "The first amount was 12.",
                authority: "user_asserted" as const,
              },
            ],
          };
        },
      },
      planner: {
        plannerVersion:
          "paw.memory-evidence-query-planner.v8:shared-dialogue-candidates",
        async plan() {
          throw Object.assign(new Error("planner failed"), {
            name: "PlannerFailed",
          });
        },
      },
      supportSelector: {
        selectorVersion: "test-selector.v1",
        async select(input) {
          return {
            selectorVersion: "test-selector.v1",
            selectionRevision: "selected-root-after-fallback",
            assessments: [
              {
                requirementId: input.requirements[0]!.requirementId,
                supportingEvidenceRefs: ["session#turn-1"],
                contradictingEvidenceRefs: [],
                unknownEvidenceRefs: [],
              },
            ],
          };
        },
      },
    });
    const contextResolver = createEvidenceFirstMemoryContextResolverV1({
      evidenceResolver,
    });

    const packet = await contextResolver.resolve(
      "How many items were there in total?",
      new AbortController().signal,
    );

    expect(packet.mode).toBe("deterministic_fallback");
    expect(packet.requirements[0]?.status).toBe("covered");
    expect(packet.stop).toBe("partial");
  });

  test("keeps an explicit challenge in the packet and blocks closure", async () => {
    const evidenceResolver = createMemoryEvidenceResolverV1({
      index: {
        indexVersion: "triaged-evidence.v1",
        async search() {
          const hits = [
            {
              sourceId: "session-a",
              evidenceRef: "session-a#turn-1",
              content: "I enjoy quiet evening walks.",
              authority: "user_asserted" as const,
              episodeOrder: 1,
            },
            {
              sourceId: "session-b",
              evidenceRef: "session-b#turn-1",
              content: "I explicitly do not want an evening walk tonight.",
              authority: "user_asserted" as const,
              episodeOrder: 2,
            },
          ];
          return {
            lists: [
              {
                channel: "l0" as const,
                retrieverId: "triaged",
                weight: 1,
                candidates: hits.map((hit) => ({
                  candidateId: hit.evidenceRef,
                  sourceId: hit.sourceId,
                  evidenceRef: hit.evidenceRef,
                  sourceKind: "user_input" as const,
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
          "paw.memory-evidence-query-planner.v8:shared-dialogue-candidates",
        async plan() {
          return {
            plannerVersion:
              "paw.memory-evidence-query-planner.v8:shared-dialogue-candidates",
            answerShape: "recommend",
            temporalMode: "any",
            roleConstraint: "user",
            needsPlanning: true,
            requirements: [
              {
                requirementId: "activity",
                label: "appropriate evening activity",
                searchText: "evening walk preference",
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
      supportSelector: {
        selectorVersion: "triage-selector.v1",
        async select() {
          return {
            selectorVersion: "triage-selector.v1",
            selectionRevision: "triage-revision",
            assessments: [
              {
                requirementId: "activity",
                supportingEvidenceRefs: ["session-a#turn-1"],
                contradictingEvidenceRefs: ["session-b#turn-1"],
                unknownEvidenceRefs: [],
              },
            ],
          };
        },
      },
    });
    const resolution = await evidenceResolver.resolve(
      "What should I do this evening?",
      new AbortController().signal,
    );
    const packet = projectEvidenceFirstMemoryContextPacketV1(resolution);

    expect(packet.requirements[0]?.status).toBe("partial");
    expect(packet.requirements[0]?.contradictingMemoryIds).toHaveLength(1);
    expect(packet.verification.contradictionCount).toBe(1);
    expect(packet.stop).toBe("partial");

    const unrenderedChallenge = projectEvidenceFirstMemoryContextPacketV1({
      ...resolution,
      packetSources: resolution.packetSources.filter(
        (source) => source.sourceId !== "session-b",
      ),
    });
    expect(
      unrenderedChallenge.requirements[0]?.contradictingMemoryIds,
    ).toHaveLength(0);
    expect(unrenderedChallenge.verification.contradictionCount).toBe(1);
    expect(unrenderedChallenge.stop).toBe("partial");
  });

  test("uses derived L1 cards for navigation but never renders them as L0", async () => {
    const provider: MemoryProviderV1 = {
      providerVersion: PAW_NEXT_MEMORY_V2_PROVIDER_VERSION_V1,
      async retrieve() {
        return {
          status: "completed",
          cards: [
            {
              id: "derived-only",
              revision: 1,
              kind: "semantic",
              statement: "A derived summary without available source text.",
              applicability: "applicable",
              scope: { repositoryId: "repository" },
              confidence: 0.9,
              sources: [
                {
                  kind: "memory_store_evidence",
                  ref: "runs/missing/trajectory#step-2",
                },
              ],
              contentHash: "derived-content-hash",
            },
          ],
        };
      },
    };
    const archive: MemoryRawEvidenceArchiveV1 = {
      scope: profile.scope,
      async put() {},
      async resolve() {
        return [];
      },
      async search() {
        return [];
      },
    };
    const resolution = await createMemoryEvidenceResolverV1({
      index: createProductMemoryEvidenceIndexV1({ profile, provider, archive }),
    }).resolve("Which city did I visit?", new AbortController().signal);

    expect(resolution.sources).toHaveLength(1);
    expect(resolution.primaryHits).toHaveLength(0);
    expect(resolution.packetSources).toHaveLength(0);
  });

  test("maps planned requirements only to their own selected evidence", async () => {
    const evidenceResolver = createMemoryEvidenceResolverV1({
      index: {
        indexVersion: "test-index.v1",
        async search(query) {
          const rows =
            query === "alpha clue"
              ? [["source-a", "ref-a"]]
              : query === "beta clue"
                ? [["source-b", "ref-b"]]
                : [
                    ["source-a", "ref-a"],
                    ["source-b", "ref-b"],
                  ];
          return {
            lists: [
              {
                channel: "l0" as const,
                retrieverId: "test",
                weight: 1,
                candidates: rows.map(([sourceId, evidenceRef]) => ({
                  candidateId: evidenceRef!,
                  sourceId: sourceId!,
                  evidenceRef: evidenceRef!,
                  sourceKind: "user_input" as const,
                  authority: "user_asserted" as const,
                })),
              },
            ],
            hits: rows.map(([sourceId, evidenceRef]) => ({
              sourceId: sourceId!,
              evidenceRef: evidenceRef!,
              content: `${sourceId === "source-a" ? "alpha" : "beta"} evidence`,
              authority: "user_asserted" as const,
            })),
          };
        },
      },
      planner: {
        plannerVersion:
          "paw.memory-evidence-query-planner.v8:shared-dialogue-candidates",
        async plan() {
          return {
            plannerVersion:
              "paw.memory-evidence-query-planner.v8:shared-dialogue-candidates",
            answerShape: "aggregate" as const,
            temporalMode: "any" as const,
            roleConstraint: "user" as const,
            needsPlanning: true,
            requirements: [
              {
                requirementId: "alpha",
                label: "alpha operand",
                searchText: "alpha clue",
                temporalMode: "any" as const,
                roleConstraint: "user" as const,
              },
              {
                requirementId: "beta",
                label: "beta operand",
                searchText: "beta clue",
                temporalMode: "any" as const,
                roleConstraint: "user" as const,
              },
            ],
          };
        },
      },
    });
    const contextResolver = createEvidenceFirstMemoryContextResolverV1({
      evidenceResolver,
    });

    const packet = await contextResolver.resolve(
      "How many alpha and beta items are there?",
      new AbortController().signal,
    );

    expect(packet.stop).toBe("partial");
    expect(packet.requirements).toHaveLength(2);
    expect(packet.requirements[0]?.supportingMemoryIds).toHaveLength(1);
    expect(packet.requirements[1]?.supportingMemoryIds).toHaveLength(1);
    expect(packet.requirements[0]?.supportingMemoryIds).not.toEqual(
      packet.requirements[1]?.supportingMemoryIds,
    );

    const contract = projectEvidenceFirstMemoryAnswerContractV1(
      await evidenceResolver.resolve(
        "How many alpha and beta items are there?",
        new AbortController().signal,
      ),
    );
    expect(contract).toMatchObject({
      answerShape: "aggregate",
      temporalMode: "any",
      roleConstraint: "user",
      evidenceStatus: "partial",
    });
    expect(contract.requirements).toEqual([
      expect.objectContaining({
        requirementId: "alpha",
        status: "covered",
        selectedEvidenceCount: 1,
      }),
      expect.objectContaining({
        requirementId: "beta",
        status: "covered",
        selectedEvidenceCount: 1,
      }),
    ]);
    expect(contract.guidance).toContain("covered requirement ID");
    expect(JSON.stringify(contract)).not.toContain("alpha evidence");
  });
});
