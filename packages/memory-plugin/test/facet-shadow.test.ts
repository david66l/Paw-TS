import { describe, expect, test } from "bun:test";

import type { MemoryEntry } from "@paw/memory/longterm";

import {
  type MemoryFacetReconciliationInputV2,
  type MemoryFacetShadowEventV2,
  type PawNextMemoryScopeV1,
  applyMemoryFacetShadowReconciliationV2,
  compactMemoryFacetReconcileCatalogV2,
  createEmptyMemoryFacetShadowSnapshotV2,
  createMemoryFacetEvidenceBatchesV2,
  createMemoryFacetReconcileCatalogFromSnapshotV2,
  createMemoryFacetV2,
  memoryEntryToFacetObservationV2,
  parseMemoryFacetReconciliationV2,
} from "../src/index.js";

const scope: PawNextMemoryScopeV1 = Object.freeze({
  tenantId: "tenant-1",
  userId: "user-1",
  workspaceId: "workspace-1",
  repositoryId: "repo-1",
});

describe("facet v2 shadow reducer", () => {
  test("backfills two batches and exposes the latest state in the next catalog", () => {
    const oldState = profile(
      "old-avoidance",
      "2025-01-01T00:00:00.000Z",
      "Malia avoided stressful investment communities.",
    );
    const rejected = episode(
      "rejected-forum",
      "2025-01-02T00:00:00.000Z",
      "Malia skipped a competitive forum with tense discussion and jargon.",
    );
    const firstEntries = [oldState, rejected];
    const firstInput = reconcileInput(firstEntries, []);
    const firstResult = parseMemoryFacetReconciliationV2(
      JSON.stringify({
        decisions: [
          newDecision(oldState.id, "state", "initial"),
          newDecision(rejected.id, "event", "initial"),
        ],
        deferredMemoryIds: [],
      }),
      firstInput,
    );
    const empty = createEmptyMemoryFacetShadowSnapshotV2(scope);
    const first = applyMemoryFacetShadowReconciliationV2({
      scope,
      previous: empty,
      observations: firstEntries,
      reconciliation: firstResult,
    });
    const catalog = createMemoryFacetReconcileCatalogFromSnapshotV2(first);
    expect(catalog).toHaveLength(1);
    expect(
      catalog[0]?.members.map((item) => [item.memoryId, item.status]),
    ).toEqual([
      ["old-avoidance", "current"],
      ["rejected-forum", "event"],
    ]);

    const joined = episode(
      "joined-community",
      "2025-02-01T00:00:00.000Z",
      "Malia joined a welcoming online investment community.",
    );
    const current = profile(
      "current-participation",
      "2025-02-02T00:00:00.000Z",
      "Malia now participates in supportive investment communities.",
    );
    const condition = semantic(
      "supportive-condition",
      "2025-02-02T00:00:00.000Z",
      "Participation works when discussion is welcoming and understandable.",
    );
    const secondEntries = [joined, current, condition];
    const secondInput = reconcileInput(secondEntries, catalog);
    const facetId = required(first.facets[0]).id;
    const secondResult = parseMemoryFacetReconciliationV2(
      JSON.stringify({
        decisions: [
          existingDecision(joined.id, facetId, "event", "initial"),
          existingDecision(current.id, facetId, "state", "state_change", [
            oldState.id,
          ]),
          existingDecision(condition.id, facetId, "condition", "supports", [
            current.id,
          ]),
        ],
        deferredMemoryIds: [],
      }),
      secondInput,
    );
    const events: MemoryFacetShadowEventV2[] = [];
    const second = applyMemoryFacetShadowReconciliationV2(
      {
        scope,
        previous: first,
        observations: secondEntries,
        reconciliation: secondResult,
      },
      { onEvent: (event) => events.push(event), now: () => 10 },
    );
    const projection = required(second.projections[0]);
    expect(projection.currentStates.map((item) => item.memoryId)).toEqual([
      current.id,
    ]);
    expect(projection.historicalStates.map((item) => item.memoryId)).toEqual([
      oldState.id,
    ]);
    expect(projection.events.map((item) => item.memoryId)).toEqual([
      joined.id,
      rejected.id,
    ]);
    expect(second.unassignedMemoryIds).toEqual([]);
    expect(events[0]).toMatchObject({
      type: "applied",
      previousRevision: first.revision,
      nextRevision: second.revision,
      observationCount: 3,
      facetCount: 1,
      membershipCount: 5,
      unassignedCount: 0,
    });
    expect(JSON.stringify(events)).not.toContain("Malia");
  });

  test("can safely retry a deferred observation without duplicating evidence", () => {
    const entry = profile(
      "deferred-state",
      "2025-03-01T00:00:00.000Z",
      "The user may prefer a new response style.",
    );
    const empty = createEmptyMemoryFacetShadowSnapshotV2(scope);
    const deferredInput = reconcileInput([entry], []);
    const deferredResult = parseMemoryFacetReconciliationV2(
      JSON.stringify({ decisions: [], deferredMemoryIds: [entry.id] }),
      deferredInput,
    );
    const deferred = applyMemoryFacetShadowReconciliationV2({
      scope,
      previous: empty,
      observations: [entry],
      reconciliation: deferredResult,
    });
    expect(deferred.entries).toHaveLength(1);
    expect(deferred.memberships).toHaveLength(0);
    expect(deferred.unassignedMemoryIds).toEqual([entry.id]);

    const retryResult = parseMemoryFacetReconciliationV2(
      JSON.stringify({
        decisions: [newDecision(entry.id, "state", "unresolved")],
        deferredMemoryIds: [],
      }),
      deferredInput,
    );
    const assigned = applyMemoryFacetShadowReconciliationV2({
      scope,
      previous: deferred,
      observations: [entry],
      reconciliation: retryResult,
    });
    expect(assigned.entries).toHaveLength(1);
    expect(assigned.memberships).toHaveLength(1);
    expect(assigned.unassignedMemoryIds).toEqual([]);
    expect(
      assigned.projections[0]?.unresolved.map((item) => item.memoryId),
    ).toEqual([entry.id]);
  });

  test("keeps every facet identity but hydrates members only near the batch", () => {
    const oldInvestmentState = profile(
      "old-investment-state",
      "2025-01-01T00:00:00.000Z",
      "Avoided a tense online investment forum",
    );
    const investmentFacet = createMemoryFacetV2({
      scope,
      canonicalKey: "investment.community_participation",
      displayName: "Investment community participation",
      aliases: ["investment forum"],
    });
    const musicFacet = createMemoryFacetV2({
      scope,
      canonicalKey: "music.production_interest",
      displayName: "Music production interest",
      aliases: ["creating tracks"],
    });
    const compact = compactMemoryFacetReconcileCatalogV2({
      observations: [
        {
          id: "new-investment-state",
          kind: "profile",
          statement: "Joined a supportive online investment community",
          validFrom: "2025-03-01T00:00:00.000Z",
        },
      ],
      catalog: [
        {
          facet: investmentFacet,
          members: [catalogMember(oldInvestmentState, "historical")],
        },
        {
          facet: musicFacet,
          members: [
            catalogMember(
              semantic(
                "music-state",
                "2025-01-01T00:00:00.000Z",
                "Enjoys creating original music tracks",
              ),
              "current",
            ),
          ],
        },
      ],
      maxFacetsWithMembers: 1,
      maxMembersPerFacet: 8,
    });

    expect(compact).toHaveLength(2);
    expect(
      compact.find((item) => item.facet.id === investmentFacet.id)?.members,
    ).toHaveLength(1);
    expect(
      compact.find((item) => item.facet.id === musicFacet.id)?.members,
    ).toHaveLength(0);
  });

  test("batches atoms by evidence family instead of row identity", () => {
    const firstEvent = episode(
      "first-event",
      "2025-01-01T00:00:00.000Z",
      "Skipped a tense forum",
    );
    const firstState = profile(
      "first-state",
      "2025-01-01T00:00:00.000Z",
      "Avoids tense forums",
    );
    const secondState = profile(
      "second-state",
      "2025-02-01T00:00:00.000Z",
      "Participates in supportive communities",
    );
    const withEvidence = (entry: MemoryEntry, evidence: string[]) =>
      Object.freeze({ ...entry, evidence }) as MemoryEntry;
    const batches = createMemoryFacetEvidenceBatchesV2(
      [
        withEvidence(firstState, ["conversation:one#atom-2"]),
        withEvidence(secondState, ["conversation:two#atom-1"]),
        withEvidence(firstEvent, [
          "conversation:one#atom-1",
          "conversation:one#atom-2",
        ]),
      ],
      16,
    );

    expect(batches.map((batch) => batch.map((entry) => entry.id))).toEqual([
      ["first-event", "first-state"],
      ["second-state"],
    ]);
  });
});

function reconcileInput(
  entries: readonly MemoryEntry[],
  catalog: MemoryFacetReconciliationInputV2["catalog"],
): MemoryFacetReconciliationInputV2 {
  return {
    scope,
    sourceRevision: `revision-${entries.map((entry) => entry.id).join("-")}`,
    observedAt: entries[0]?.tValid ?? "2025-01-01T00:00:00.000Z",
    observations: entries.map(memoryEntryToFacetObservationV2),
    catalog,
    maxNewFacets: 4,
  };
}

function newDecision(
  memoryId: string,
  role: "state" | "event" | "cause" | "condition",
  linkKind: "initial" | "unresolved",
) {
  return {
    memoryId,
    facetId: null,
    canonicalKey: "investment.community_participation",
    displayName: "Investment community participation",
    aliases: ["investment forums", "investment communities"],
    role,
    linkKind,
    targetMemoryIds: [],
    confidence: 0.95,
  };
}

function existingDecision(
  memoryId: string,
  facetId: string,
  role: "state" | "event" | "cause" | "condition",
  linkKind: "initial" | "state_change" | "supports",
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

function catalogMember(entry: MemoryEntry, status: "current" | "historical") {
  return {
    memoryId: entry.id,
    role: "state" as const,
    status,
    statement:
      entry.kind === "semantic"
        ? entry.fact
        : entry.kind === "profile"
          ? entry.insight
          : "fixture",
    validFrom: entry.tValid,
    ...(entry.tInvalid ? { validTo: entry.tInvalid } : {}),
  };
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Fixture value missing");
  return value;
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
