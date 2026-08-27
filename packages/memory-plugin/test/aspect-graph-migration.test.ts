import { describe, expect, test } from "bun:test";

import type { MemoryEntry } from "@paw/memory/longterm";

import {
  type MemoryFacetAspectMigrationEventV1,
  PAW_MEMORY_FACET_RECONCILER_VERSION_V2,
  type PawNextMemoryScopeV1,
  applyMemoryFacetShadowReconciliationV2,
  createEmptyMemoryFacetShadowSnapshotV2,
  createMemoryFacetMembershipV2,
  createMemoryFacetV2,
  migrateMemoryFacetShadowToAspectGraphV1,
  projectMemoryAspectStateV1,
} from "../src/index.js";

const scope: PawNextMemoryScopeV1 = Object.freeze({
  tenantId: "tenant-migration",
  userId: "user-migration",
  workspaceId: "workspace-migration",
  repositoryId: "repo-migration",
});
const jan = "2025-01-01T00:00:00.000Z";
const feb = "2025-02-01T00:00:00.000Z";
const mar = "2025-03-01T00:00:00.000Z";

describe("facet shadow to aspect graph migration", () => {
  test("preserves claims, state transitions, support adjacency, and telemetry", () => {
    const facet = createMemoryFacetV2({
      scope,
      canonicalKey: "community.participation",
      displayName: "Community participation",
      aliases: ["online community"],
    });
    const old = profile("old", jan);
    const joined = episode("joined", feb);
    const current = profile("current", mar);
    const cause = episode("welcoming", mar);
    const source = applyMemoryFacetShadowReconciliationV2({
      scope,
      previous: createEmptyMemoryFacetShadowSnapshotV2(scope),
      observations: [old, joined, current, cause],
      reconciliation: {
        reconcilerVersion: PAW_MEMORY_FACET_RECONCILER_VERSION_V2,
        reconciliationRevision: "fixture-reconciliation",
        facets: [facet],
        memberships: [
          member(facet.id, old.id, "state", "initial"),
          member(facet.id, joined.id, "event", "initial"),
          member(facet.id, current.id, "state", "state_change", [old.id]),
          member(facet.id, cause.id, "cause", "supports", [current.id]),
        ],
        deferredMemoryIds: [],
        normalizedRelationCount: 0,
        salvagedDecisionCount: 0,
      },
    });
    const events: MemoryFacetAspectMigrationEventV1[] = [];
    const migrated = migrateMemoryFacetShadowToAspectGraphV1(
      { scope, source },
      { onEvent: (event) => events.push(event), now: () => 10 },
    );
    const aspectId = migrated.identities[0]?.aspectId;
    expect(aspectId).toBeString();
    const projection = projectMemoryAspectStateV1({
      snapshot: migrated.snapshot,
      aspectId: aspectId as string,
      asOf: mar,
    });

    expect(migrated.snapshot.claims).toHaveLength(4);
    expect(migrated.snapshot.memberships).toHaveLength(4);
    expect(projection.currentClaimIds).toEqual([current.id]);
    expect(projection.historicalClaimIds).toEqual([old.id]);
    expect(projection.eventClaimIds).toEqual([joined.id]);
    expect(projection.causeClaimIds).toEqual([cause.id]);
    expect(projection.edges.map((edge) => edge.edgeType).sort()).toEqual([
      "supersedes",
      "supports",
    ]);
    expect(events).toEqual([
      expect.objectContaining({
        type: "completed",
        claimCount: 4,
        aspectCount: 1,
        membershipCount: 4,
        edgeCount: 2,
        durationMs: 0,
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain("Community participation");
    expect(JSON.stringify(events)).not.toContain("welcoming");
  });

  test("keeps deferred atoms as zero-membership claims", () => {
    const deferred = profile("deferred", jan);
    const source = applyMemoryFacetShadowReconciliationV2({
      scope,
      previous: createEmptyMemoryFacetShadowSnapshotV2(scope),
      observations: [deferred],
      reconciliation: {
        reconcilerVersion: PAW_MEMORY_FACET_RECONCILER_VERSION_V2,
        reconciliationRevision: "deferred-reconciliation",
        facets: [],
        memberships: [],
        deferredMemoryIds: [deferred.id],
        normalizedRelationCount: 0,
        salvagedDecisionCount: 0,
      },
    });
    const migrated = migrateMemoryFacetShadowToAspectGraphV1({ scope, source });

    expect(migrated.snapshot.claims.map((claim) => claim.id)).toEqual([
      deferred.id,
    ]);
    expect(migrated.snapshot.memberships).toHaveLength(0);
    expect(migrated.unassignedClaimIds).toEqual([deferred.id]);
  });
});

function member(
  facetId: string,
  memoryId: string,
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
  return createMemoryFacetMembershipV2({
    facetId,
    memoryId,
    role,
    linkKind,
    targetMemoryIds,
    confidence: 0.9,
  });
}

function profile(id: string, tValid: string): MemoryEntry {
  return {
    id,
    kind: "profile",
    repo: "repo",
    created: tValid,
    tValid,
    tInvalid: null,
    source: "user_statement",
    confidence: 0.9,
    evidence: [`l0:${id}`],
    freq: 0,
    utility: 0,
    insight: `${id} profile evidence`,
    supportCount: 3,
  };
}

function episode(id: string, tValid: string): MemoryEntry {
  return {
    id,
    kind: "episodic",
    repo: "repo",
    created: tValid,
    tValid,
    tInvalid: null,
    source: "user_statement",
    confidence: 0.9,
    evidence: [`l0:${id}`],
    freq: 0,
    utility: 0,
    whenToUse: `${id} context`,
    perspective: `${id} episode evidence`,
    modification: [],
    issueType: "persona_memory",
    taskId: "fixture",
  };
}
