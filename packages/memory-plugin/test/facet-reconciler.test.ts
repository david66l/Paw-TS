import { describe, expect, test } from "bun:test";

import type { MemoryEntry } from "@paw/memory/longterm";

import {
  type MemoryFacetReconcilerEventV2,
  type MemoryFacetReconciliationInputV2,
  type PawNextMemoryScopeV1,
  buildMemoryFacetReconciliationRequestV2,
  createJsonMemoryFacetReconcilerV2,
  createMemoryFacetMembershipV2,
  createMemoryFacetV2,
  parseMemoryFacetReconciliationV2,
  projectMemoryFacetStateV2,
} from "../src/index.js";

const scope: PawNextMemoryScopeV1 = Object.freeze({
  tenantId: "tenant-1",
  userId: "user-1",
  workspaceId: "workspace-1",
  repositoryId: "repo-1",
});

describe("facet v2 ID-only reconciler", () => {
  test("links events, a changed state, and its condition into one existing facet", () => {
    const setup = investmentSetup();
    const result = parseMemoryFacetReconciliationV2(
      JSON.stringify({
        decisions: [
          existingDecision(
            required(setup.observations[0]).id,
            setup.facet.id,
            "event",
            "initial",
          ),
          existingDecision(
            required(setup.observations[1]).id,
            setup.facet.id,
            "state",
            "state_change",
            ["old-avoidance"],
          ),
          existingDecision(
            required(setup.observations[2]).id,
            setup.facet.id,
            "condition",
            "supports",
            ["current-participation"],
          ),
        ],
        deferredMemoryIds: [],
      }),
      setup.input,
    );

    expect(result.facets).toEqual([setup.facet]);
    expect(result.memberships).toHaveLength(3);
    const projection = projectMemoryFacetStateV2({
      facet: setup.facet,
      memberships: [
        createMemoryFacetMembershipV2({
          facetId: setup.facet.id,
          memoryId: "old-avoidance",
          role: "state",
          linkKind: "initial",
          confidence: 0.95,
        }),
        createMemoryFacetMembershipV2({
          facetId: setup.facet.id,
          memoryId: "rejected-forum",
          role: "event",
          linkKind: "initial",
          confidence: 0.95,
        }),
        ...result.memberships,
      ],
      entries: [...setup.existingEntries, ...setup.newEntries],
    });
    expect(projection.currentStates.map((item) => item.memoryId)).toEqual([
      "current-participation",
    ]);
    expect(projection.historicalStates.map((item) => item.memoryId)).toEqual([
      "old-avoidance",
    ]);
    expect(projection.events.map((item) => item.memoryId)).toEqual([
      "joined-community",
      "rejected-forum",
    ]);
    expect(projection.conditions.map((item) => item.memoryId)).toEqual([
      "supportive-condition",
    ]);
  });

  test("keeps the instruction prefix stable and materializes new facet IDs in code", () => {
    const firstInput = newFacetInput(
      "Prefers detailed architecture explanations",
    );
    const secondInput = newFacetInput("Prefers concise status updates");
    const firstRequest = buildMemoryFacetReconciliationRequestV2(firstInput);
    const secondRequest = buildMemoryFacetReconciliationRequestV2(secondInput);
    expect(firstRequest.system).toBe(secondRequest.system);

    const response = JSON.stringify({
      decisions: [
        newDecision(
          "new-observation",
          "response.detail_preference",
          "Response detail preference",
        ),
      ],
      deferredMemoryIds: [],
    });
    const first = parseMemoryFacetReconciliationV2(response, firstInput);
    const second = parseMemoryFacetReconciliationV2(response, firstInput);
    expect(first.reconciliationRevision).toBe(second.reconciliationRevision);
    expect(first.facets[0]?.canonicalKey).toBe("response.detail.preference");
    expect(first.memberships[0]?.facetId).toBe(first.facets[0]?.id);
    expect(JSON.parse(firstRequest.user)).toMatchObject({
      maxNewFacets: 2,
      observations: [{ id: "new-observation" }],
    });
  });

  test("deterministically merges display metadata for one new canonical identity", () => {
    const input: MemoryFacetReconciliationInputV2 = {
      ...newFacetInput("Avoided a tense investment forum"),
      observations: [
        {
          id: "old-state",
          kind: "profile",
          statement: "Avoided a tense investment forum",
          validFrom: "2025-01-01T00:00:00.000Z",
        },
        {
          id: "new-state",
          kind: "profile",
          statement: "Now participates in a supportive investment community",
          validFrom: "2025-02-01T00:00:00.000Z",
        },
      ],
    };
    const result = parseMemoryFacetReconciliationV2(
      JSON.stringify({
        decisions: [
          {
            ...newDecision(
              "new-state",
              "investment.community_participation",
              "Investment community participation",
              "state_change",
              ["old-state"],
            ),
            aliases: ["investment community"],
          },
          {
            ...newDecision(
              "old-state",
              "investment.community_participation",
              "Community participation in investing",
            ),
            aliases: ["investment forum"],
          },
        ],
        deferredMemoryIds: [],
      }),
      input,
    );

    expect(result.facets).toHaveLength(1);
    expect(result.facets[0]).toMatchObject({
      displayName: "Investment community participation",
      aliases: [
        "community participation in investing",
        "investment community",
        "investment forum",
      ],
    });
    expect(new Set(result.memberships.map((item) => item.facetId)).size).toBe(
      1,
    );
  });

  test("repairs one invented facet ID without weakening target validation", async () => {
    const setup = investmentSetup();
    const calls: Array<Readonly<{ system: string; user: string }>> = [];
    const events: MemoryFacetReconcilerEventV2[] = [];
    const responses = [
      JSON.stringify({
        decisions: [
          existingDecision(
            "joined-community",
            "invented-facet-id",
            "event",
            "initial",
          ),
        ],
        deferredMemoryIds: ["current-participation", "supportive-condition"],
      }),
      JSON.stringify({
        decisions: [
          existingDecision(
            "joined-community",
            setup.facet.id,
            "event",
            "initial",
          ),
        ],
        deferredMemoryIds: ["current-participation", "supportive-condition"],
      }),
    ];
    const reconciler = createJsonMemoryFacetReconcilerV2({
      model: {
        async complete(request) {
          calls.push(request);
          return {
            status: "completed" as const,
            text: required(responses.shift()),
          };
        },
      },
      onEvent: (event) => events.push(event),
      now: () => 10,
    });
    const result = await reconciler.reconcile(
      setup.input,
      new AbortController().signal,
    );

    expect(calls).toHaveLength(2);
    expect(calls[1]?.system).toContain("failed strict validation");
    expect(result.memberships.map((item) => item.memoryId)).toEqual([
      "joined-community",
    ]);
    expect(result.deferredMemoryIds).toEqual([
      "current-participation",
      "supportive-condition",
    ]);
    expect(events).toEqual([
      expect.objectContaining({
        type: "completed",
        repaired: true,
        observationCount: 3,
        membershipCount: 1,
        deferredCount: 2,
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain("community");
  });

  test("drops a non-state relation target without changing facet identity", () => {
    const facet = createMemoryFacetV2({
      scope,
      canonicalKey: "finance.blogging",
      displayName: "Finance blogging",
    });
    const input: MemoryFacetReconciliationInputV2 = {
      scope,
      sourceRevision: "source-revision-non-state-target",
      observedAt: "2025-03-01T00:00:00.000Z",
      observations: [
        {
          id: "blog-profile",
          kind: "profile",
          statement: "Maintains a personal finance blog",
          validFrom: "2025-03-01T00:00:00.000Z",
        },
      ],
      catalog: [
        {
          facet,
          members: [
            {
              memoryId: "blog-event",
              role: "event",
              status: "event",
              statement: "Restarted a personal finance blog",
              validFrom: "2025-02-01T00:00:00.000Z",
            },
          ],
        },
      ],
      maxNewFacets: 2,
    };
    const result = parseMemoryFacetReconciliationV2(
      JSON.stringify({
        decisions: [
          existingDecision("blog-profile", facet.id, "state", "same_state", [
            "blog-event",
          ]),
        ],
        deferredMemoryIds: [],
      }),
      input,
    );

    expect(result.normalizedRelationCount).toBe(1);
    expect(result.memberships).toEqual([
      expect.objectContaining({
        facetId: facet.id,
        memoryId: "blog-profile",
        linkKind: "initial",
        targetMemoryIds: [],
      }),
    ]);
  });

  test("salvages valid decisions and defers an invented facet after repair", async () => {
    const input: MemoryFacetReconciliationInputV2 = {
      ...newFacetInput("Prefers concise responses"),
      observations: [
        {
          id: "valid-observation",
          kind: "profile",
          statement: "Prefers concise responses",
          validFrom: "2025-03-01T00:00:00.000Z",
        },
        {
          id: "invalid-observation",
          kind: "profile",
          statement: "Uses a physical budget ledger",
          validFrom: "2025-03-01T00:00:00.000Z",
        },
      ],
    };
    const invalidPacket = JSON.stringify({
      decisions: [
        newDecision(
          "valid-observation",
          "response.conciseness",
          "Response conciseness",
        ),
        existingDecision(
          "invalid-observation",
          "invented-facet-id",
          "state",
          "initial",
        ),
      ],
      deferredMemoryIds: [],
    });
    const events: MemoryFacetReconcilerEventV2[] = [];
    const reconciler = createJsonMemoryFacetReconcilerV2({
      model: {
        async complete() {
          return { status: "completed" as const, text: invalidPacket };
        },
      },
      onEvent: (event) => events.push(event),
      now: () => 10,
    });
    const result = await reconciler.reconcile(
      input,
      new AbortController().signal,
    );

    expect(result.memberships.map((item) => item.memoryId)).toEqual([
      "valid-observation",
    ]);
    expect(result.deferredMemoryIds).toEqual(["invalid-observation"]);
    expect(result.salvagedDecisionCount).toBe(1);
    expect(events).toEqual([
      expect.objectContaining({
        type: "completed",
        repaired: true,
        salvaged: true,
        salvagedDecisionCount: 1,
      }),
    ]);
  });

  test("rejects cross-facet targets and incomplete partitions", () => {
    const setup = investmentSetup();
    expect(() =>
      parseMemoryFacetReconciliationV2(
        JSON.stringify({
          decisions: [
            newDecision(
              "current-participation",
              "response.detail_preference",
              "Response detail preference",
              "state_change",
              ["old-avoidance"],
            ),
          ],
          deferredMemoryIds: ["joined-community", "supportive-condition"],
        }),
        setup.input,
      ),
    ).toThrow("MemoryFacetReconcileCrossFacetTarget");

    expect(() =>
      parseMemoryFacetReconciliationV2(
        JSON.stringify({
          decisions: [
            existingDecision(
              "joined-community",
              setup.facet.id,
              "event",
              "initial",
            ),
          ],
          deferredMemoryIds: ["supportive-condition"],
        }),
        setup.input,
      ),
    ).toThrow("MemoryFacetReconcilePartitionIncomplete");
  });
});

function investmentSetup() {
  const facet = createMemoryFacetV2({
    scope,
    canonicalKey: "investment.community_participation",
    displayName: "Investment community participation",
    aliases: ["investment forums", "investment communities"],
  });
  const existingEntries = [
    profile(
      "old-avoidance",
      "2025-01-01T00:00:00.000Z",
      "Malia avoided stressful investment communities.",
    ),
    episode(
      "rejected-forum",
      "2025-01-02T00:00:00.000Z",
      "Malia skipped a competitive forum with tense discussion and heavy jargon.",
    ),
  ];
  const newEntries = [
    episode(
      "joined-community",
      "2025-02-01T00:00:00.000Z",
      "Malia joined a welcoming online investment community and participated actively.",
    ),
    profile(
      "current-participation",
      "2025-02-02T00:00:00.000Z",
      "Malia now participates in supportive investment communities.",
    ),
    semantic(
      "supportive-condition",
      "2025-02-02T00:00:00.000Z",
      "Participation works when discussion is welcoming and understandable.",
    ),
  ];
  const observations = newEntries.map(observation);
  const input: MemoryFacetReconciliationInputV2 = {
    scope,
    sourceRevision: "source-revision-1",
    observedAt: "2025-02-02T00:00:00.000Z",
    observations,
    catalog: [
      {
        facet,
        members: [
          candidate(required(existingEntries[0]), "state", "current"),
          candidate(required(existingEntries[1]), "event", "event"),
        ],
      },
    ],
    maxNewFacets: 4,
  };
  return { facet, existingEntries, newEntries, observations, input };
}

function newFacetInput(statement: string): MemoryFacetReconciliationInputV2 {
  return {
    scope,
    sourceRevision: "new-source-revision",
    observedAt: "2025-03-01T00:00:00.000Z",
    observations: [
      {
        id: "new-observation",
        kind: "profile",
        statement,
        validFrom: "2025-03-01T00:00:00.000Z",
      },
    ],
    catalog: [],
    maxNewFacets: 2,
  };
}

function existingDecision(
  memoryId: string,
  facetId: string,
  role: "state" | "event" | "cause" | "condition",
  linkKind:
    | "initial"
    | "same_state"
    | "state_change"
    | "context_variant"
    | "supports"
    | "unresolved",
  targetMemoryIds: readonly string[] = [],
) {
  return {
    memoryId,
    facetId,
    canonicalKey: null,
    displayName: null,
    aliases: [],
    role,
    linkKind,
    targetMemoryIds,
    confidence: 0.95,
  };
}

function newDecision(
  memoryId: string,
  canonicalKey: string,
  displayName: string,
  linkKind:
    | "initial"
    | "same_state"
    | "state_change"
    | "context_variant"
    | "supports"
    | "unresolved" = "initial",
  targetMemoryIds: readonly string[] = [],
) {
  return {
    memoryId,
    facetId: null,
    canonicalKey,
    displayName,
    aliases: [],
    role: "state",
    linkKind,
    targetMemoryIds,
    confidence: 0.9,
  };
}

function observation(entry: MemoryEntry) {
  return {
    id: entry.id,
    kind: entry.kind as "semantic" | "episodic" | "profile",
    statement:
      entry.kind === "semantic"
        ? entry.fact
        : entry.kind === "profile"
          ? entry.insight
          : entry.kind === "episodic"
            ? entry.perspective
            : entry.refDescription,
    validFrom: entry.tValid,
    ...(entry.tInvalid ? { validTo: entry.tInvalid } : {}),
  };
}

function candidate(
  entry: MemoryEntry,
  role: "state" | "event" | "cause" | "condition",
  status:
    | "current"
    | "historical"
    | "contextual"
    | "supporting"
    | "event"
    | "cause"
    | "condition"
    | "unresolved",
) {
  return {
    memoryId: entry.id,
    role,
    status,
    statement: observation(entry).statement,
    validFrom: entry.tValid,
    ...(entry.tInvalid ? { validTo: entry.tInvalid } : {}),
  };
}

function common(id: string, tValid: string) {
  return {
    id,
    repo: scope.repositoryId,
    created: tValid,
    tValid,
    tInvalid: null,
    source: "user_statement" as const,
    confidence: 0.95,
    evidence: [`journal:run-1#${id}`],
    freq: 0,
    utility: 0,
  };
}

function profile(id: string, tValid: string, insight: string): MemoryEntry {
  return Object.freeze({
    ...common(id, tValid),
    kind: "profile",
    insight,
    supportCount: 1,
  });
}

function semantic(id: string, tValid: string, fact: string): MemoryEntry {
  return Object.freeze({
    ...common(id, tValid),
    kind: "semantic",
    fact,
    keywords: [],
    embeddingKey: fact,
  });
}

function episode(id: string, tValid: string, perspective: string): MemoryEntry {
  return Object.freeze({
    ...common(id, tValid),
    kind: "episodic",
    whenToUse: "When recalling investment community participation",
    perspective,
    modification: [],
    issueType: "memory_atom",
    taskId: "run-1",
  });
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Fixture value missing");
  return value;
}
