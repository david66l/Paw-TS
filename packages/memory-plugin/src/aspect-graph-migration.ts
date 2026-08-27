import type { MemoryEntry } from "@paw/memory/longterm";

import {
  type MemoryAspectGraphSnapshotV1,
  applyMemoryAspectGraphMutationV1,
  createEmptyMemoryAspectGraphSnapshotV1,
  createMemoryAspectClaimV1,
  createMemoryAspectV1,
  createMemoryClaimAspectMembershipV1,
  createMemoryEvidenceEdgeV1,
} from "./aspect-graph.js";
import type { MemoryFacetShadowSnapshotV2 } from "./facet-shadow.js";
import type { MemoryFacetLinkKindV2 } from "./facet-state.js";
import {
  type PawNextMemoryScopeV1,
  memoryScopeFingerprintV1,
} from "./profile.js";

export const PAW_MEMORY_FACET_ASPECT_MIGRATION_VERSION_V1 =
  "paw.memory-facet-aspect-migration.v1" as const;

export interface MemoryFacetAspectIdentityMapV1 {
  readonly facetId: string;
  readonly aspectId: string;
}

export interface MemoryFacetAspectMigrationResultV1 {
  readonly schemaVersion: typeof PAW_MEMORY_FACET_ASPECT_MIGRATION_VERSION_V1;
  readonly sourceRevision: string;
  readonly snapshot: MemoryAspectGraphSnapshotV1;
  readonly identities: readonly MemoryFacetAspectIdentityMapV1[];
  /** Existing deferred atoms remain claims with zero aspect membership. */
  readonly unassignedClaimIds: readonly string[];
}

export interface MemoryFacetAspectMigrationEventV1 {
  readonly schemaVersion: "paw.memory-facet-aspect-migration-event.v1";
  readonly type: "completed" | "failed";
  readonly sourceRevision: string;
  readonly targetRevision?: string;
  readonly claimCount: number;
  readonly aspectCount: number;
  readonly membershipCount: number;
  readonly edgeCount: number;
  readonly unassignedCount: number;
  readonly reasonCode?: string;
  readonly durationMs: number;
}

/**
 * Losslessly projects the old Facet shadow into AspectGraph for A/B baselines.
 * It does not infer extra memberships, merge aliases, or repair old decisions.
 */
export function migrateMemoryFacetShadowToAspectGraphV1(
  input: Readonly<{
    scope: PawNextMemoryScopeV1;
    source: MemoryFacetShadowSnapshotV2;
  }>,
  options: Readonly<{
    onEvent?: (event: MemoryFacetAspectMigrationEventV1) => void;
    now?: () => number;
  }> = {},
): MemoryFacetAspectMigrationResultV1 {
  const now = options.now ?? Date.now;
  const startedAt = now();
  try {
    const scopeFingerprint = memoryScopeFingerprintV1(input.scope);
    if (
      input.source.schemaVersion !== "paw.memory-facet-shadow-snapshot.v2" ||
      input.source.scopeFingerprint !== scopeFingerprint ||
      !input.source.revision.trim()
    ) {
      throw namedError("MemoryFacetAspectMigrationSourceInvalid");
    }
    const entries = uniqueEntries(input.source.entries);
    const identities = input.source.facets
      .map((facet) => {
        if (facet.scopeFingerprint !== scopeFingerprint) {
          throw namedError("MemoryFacetAspectMigrationScopeMismatch");
        }
        const aspect = createMemoryAspectV1({
          scope: input.scope,
          identitySeed: `facet-v2:${facet.id}`,
          displayName: facet.displayName,
          aliases: [facet.canonicalKey, ...facet.aliases],
        });
        return Object.freeze({ facetId: facet.id, aspect });
      })
      .sort((left, right) => left.facetId.localeCompare(right.facetId));
    const aspectByFacet = new Map(
      identities.map((identity) => [identity.facetId, identity.aspect]),
    );

    const claims = [...entries.values()].map((entry) =>
      createMemoryAspectClaimV1({
        id: entry.id,
        kind: entry.kind === "episodic" ? "episode" : "assertion",
        validFrom: entry.tValid,
        ...(entry.tInvalid === null ? {} : { validTo: entry.tInvalid }),
        ingestedAt: entry.created,
        evidenceRefs: entry.evidence,
      }),
    );
    const memberships = input.source.memberships.map((membership) => {
      const aspect = aspectByFacet.get(membership.facetId);
      if (!aspect || !entries.has(membership.memoryId)) {
        throw namedError("MemoryFacetAspectMigrationMembershipDangling");
      }
      return createMemoryClaimAspectMembershipV1({
        scope: input.scope,
        claimId: membership.memoryId,
        aspectId: aspect.id,
        role: membership.role,
        confidence: membership.confidence,
        createdAt: requiredEntry(entries, membership.memoryId).created,
      });
    });
    const edges = input.source.memberships.flatMap((membership) => {
      const edgeType = migratedEdgeType(membership.linkKind);
      if (edgeType === undefined) return [];
      const aspect = aspectByFacet.get(membership.facetId);
      if (aspect === undefined) {
        throw namedError("MemoryFacetAspectMigrationMembershipDangling");
      }
      const source = requiredEntry(entries, membership.memoryId);
      return membership.targetMemoryIds.map((targetMemoryId) => {
        requiredEntry(entries, targetMemoryId);
        return createMemoryEvidenceEdgeV1({
          scope: input.scope,
          fromClaimId: membership.memoryId,
          toClaimId: targetMemoryId,
          edgeType,
          ...(edgeType === "supports"
            ? {}
            : { stateScope: { aspectId: aspect.id } }),
          confidence: membership.confidence,
          evidenceRefs: source.evidence,
          createdAt: source.created,
        });
      });
    });
    const snapshot = applyMemoryAspectGraphMutationV1(
      {
        snapshot: createEmptyMemoryAspectGraphSnapshotV1(input.scope),
        claims,
        aspects: identities.map((identity) => identity.aspect),
        memberships,
        edges,
      },
      { now },
    );
    const unassignedClaimIds = Object.freeze(
      [...new Set(input.source.unassignedMemoryIds)].sort(),
    );
    for (const id of unassignedClaimIds) requiredEntry(entries, id);
    const result = Object.freeze({
      schemaVersion: PAW_MEMORY_FACET_ASPECT_MIGRATION_VERSION_V1,
      sourceRevision: input.source.revision,
      snapshot,
      identities: Object.freeze(
        identities.map(({ facetId, aspect }) =>
          Object.freeze({ facetId, aspectId: aspect.id }),
        ),
      ),
      unassignedClaimIds,
    }) satisfies MemoryFacetAspectMigrationResultV1;
    emit(options.onEvent, {
      schemaVersion: "paw.memory-facet-aspect-migration-event.v1",
      type: "completed",
      sourceRevision: input.source.revision,
      targetRevision: snapshot.revision,
      claimCount: snapshot.claims.length,
      aspectCount: snapshot.aspects.length,
      membershipCount: snapshot.memberships.length,
      edgeCount: snapshot.edges.length,
      unassignedCount: unassignedClaimIds.length,
      durationMs: Math.max(0, now() - startedAt),
    });
    return result;
  } catch (error) {
    emit(options.onEvent, {
      schemaVersion: "paw.memory-facet-aspect-migration-event.v1",
      type: "failed",
      sourceRevision: input.source.revision,
      claimCount: input.source.entries.length,
      aspectCount: input.source.facets.length,
      membershipCount: input.source.memberships.length,
      edgeCount: 0,
      unassignedCount: input.source.unassignedMemoryIds.length,
      reasonCode: error instanceof Error ? error.name : "UnknownFailure",
      durationMs: Math.max(0, now() - startedAt),
    });
    throw error;
  }
}

function migratedEdgeType(
  linkKind: MemoryFacetLinkKindV2,
): "same_state" | "supersedes" | "qualifies" | "supports" | undefined {
  if (linkKind === "same_state") return "same_state";
  if (linkKind === "state_change") return "supersedes";
  if (linkKind === "context_variant") return "qualifies";
  if (linkKind === "supports") return "supports";
  return undefined;
}

function uniqueEntries(
  entries: readonly MemoryEntry[],
): ReadonlyMap<string, MemoryEntry> {
  const result = new Map<string, MemoryEntry>();
  for (const entry of entries) {
    if (entry.kind === "vault_ref") {
      throw namedError("MemoryFacetAspectMigrationEntryKindInvalid");
    }
    if (result.has(entry.id)) {
      throw namedError("MemoryFacetAspectMigrationEntryDuplicate");
    }
    result.set(entry.id, entry);
  }
  return result;
}

function requiredEntry(
  entries: ReadonlyMap<string, MemoryEntry>,
  id: string,
): MemoryEntry {
  const entry = entries.get(id);
  if (!entry) throw namedError("MemoryFacetAspectMigrationEntryMissing");
  return entry;
}

function emit(
  observer: ((event: MemoryFacetAspectMigrationEventV1) => void) | undefined,
  event: MemoryFacetAspectMigrationEventV1,
): void {
  try {
    observer?.(Object.freeze(event));
  } catch {
    // Diagnostic observers cannot alter migration semantics.
  }
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
