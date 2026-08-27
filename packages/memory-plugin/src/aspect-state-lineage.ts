import type { JsonValue } from "@paw/protocol";

import {
  type MemoryAspectClaimRoleV1,
  type MemoryAspectGraphSnapshotV1,
  type MemoryAspectStateScopeV1,
  type MemoryEvidenceEdgeV1,
  measureMemoryAspectGraphV1,
} from "./aspect-graph.js";
import { hashCanonicalJsonV1 } from "./canonical.js";

export const PAW_MEMORY_ASPECT_STATE_LINEAGE_VERSION_V1 =
  "paw.memory-aspect-state-lineage.v1" as const;

export interface MemoryAspectStateLineageProjectionV1 {
  readonly schemaVersion: typeof PAW_MEMORY_ASPECT_STATE_LINEAGE_VERSION_V1;
  readonly stateScope: MemoryAspectStateScopeV1;
  readonly anchorClaimIds: readonly string[];
  readonly lineageClaimIds: readonly string[];
  readonly projectionRevision: string;
  readonly currentClaimIds: readonly string[];
  readonly historicalClaimIds: readonly string[];
  readonly futureClaimIds: readonly string[];
  readonly eventClaimIds: readonly string[];
  readonly causeClaimIds: readonly string[];
  readonly conditionClaimIds: readonly string[];
  readonly edges: readonly MemoryEvidenceEdgeV1[];
  readonly neighborClaimIds: readonly string[];
}

/**
 * Resolves one state lineage inside a potentially broad Aspect. Topic-wide
 * browsing remains the responsibility of projectMemoryAspectStateV1.
 */
export function projectMemoryAspectStateLineageV1(
  input: Readonly<{
    snapshot: MemoryAspectGraphSnapshotV1;
    asOf: string;
    anchorClaimIds: readonly string[];
    aspectId?: string;
    subjectKey?: string;
    contextKey?: string;
  }>,
): MemoryAspectStateLineageProjectionV1 {
  measureMemoryAspectGraphV1(input.snapshot);
  const asOf = canonicalIso(input.asOf);
  const anchorClaimIds = stableIds(
    input.anchorClaimIds,
    "MemoryAspectStateLineageAnchorInvalid",
  );
  if (anchorClaimIds.length === 0) {
    throw namedError("MemoryAspectStateLineageAnchorInvalid");
  }
  const claims = new Map(
    input.snapshot.claims.map((claim) => [claim.id, claim]),
  );
  for (const anchorClaimId of anchorClaimIds) {
    if (!claims.has(anchorClaimId)) {
      throw namedError("MemoryAspectStateLineageAnchorUnknown");
    }
  }
  const activeAspectIds = new Set(
    input.snapshot.aspects
      .filter((aspect) => aspect.status === "active")
      .map((aspect) => aspect.id),
  );
  const memberships = activeMemberships(input.snapshot, asOf).filter(
    (membership) =>
      activeAspectIds.has(membership.aspectId) &&
      (input.aspectId === undefined ||
        membership.aspectId === input.aspectId) &&
      (input.subjectKey === undefined ||
        membership.subjectKey === input.subjectKey) &&
      (input.contextKey === undefined ||
        membership.contextKey === input.contextKey),
  );
  const scopeByKey = new Map<string, MemoryAspectStateScopeV1>();
  const scopesByAnchor = new Map<string, Set<string>>();
  for (const membership of memberships) {
    if (!anchorClaimIds.includes(membership.claimId)) continue;
    const scope = Object.freeze({
      subjectKey: membership.subjectKey,
      aspectId: membership.aspectId,
      contextKey: membership.contextKey,
    });
    const key = scopeKey(scope);
    scopeByKey.set(key, scope);
    const scopes = scopesByAnchor.get(membership.claimId) ?? new Set<string>();
    scopes.add(key);
    scopesByAnchor.set(membership.claimId, scopes);
  }
  let sharedScopes: Set<string> | null = null;
  for (const anchorClaimId of anchorClaimIds) {
    const scopes = scopesByAnchor.get(anchorClaimId) ?? new Set<string>();
    if (sharedScopes === null) {
      sharedScopes = new Set<string>(scopes);
    } else {
      const intersection = new Set<string>();
      for (const key of sharedScopes) {
        if (scopes.has(key)) intersection.add(key);
      }
      sharedScopes = intersection;
    }
  }
  if (sharedScopes?.size !== 1) {
    throw namedError("MemoryAspectStateLineageAmbiguous");
  }
  const stateScope = scopeByKey.get([...sharedScopes][0] as string);
  if (stateScope === undefined) {
    throw namedError("MemoryAspectStateLineageAmbiguous");
  }
  const scopedMemberships = memberships.filter(
    (membership) => scopeKey(membership) === scopeKey(stateScope),
  );
  const rolesByClaim = new Map<string, Set<MemoryAspectClaimRoleV1>>();
  for (const membership of scopedMemberships) {
    const roles = rolesByClaim.get(membership.claimId) ?? new Set();
    roles.add(membership.role);
    rolesByClaim.set(membership.claimId, roles);
  }
  const scopedClaimIds = new Set(scopedMemberships.map((item) => item.claimId));
  const activeEdges = activeEdgesAt(input.snapshot, asOf).filter(
    (edge) =>
      edge.stateScope !== undefined &&
      scopeKey(edge.stateScope) === scopeKey(stateScope) &&
      scopedClaimIds.has(edge.fromClaimId) &&
      scopedClaimIds.has(edge.toClaimId),
  );
  const stateClaimIds = new Set(
    [...rolesByClaim]
      .filter(([, roles]) => hasStateRole(roles))
      .map(([claimId]) => claimId),
  );
  const adjacency = new Map<string, Set<string>>();
  for (const edge of activeEdges) {
    if (
      edge.edgeType !== "same_state" &&
      edge.edgeType !== "supersedes" &&
      edge.edgeType !== "qualifies" &&
      edge.edgeType !== "contradicts"
    ) {
      continue;
    }
    if (
      !stateClaimIds.has(edge.fromClaimId) ||
      !stateClaimIds.has(edge.toClaimId)
    ) {
      continue;
    }
    addUndirected(adjacency, edge.fromClaimId, edge.toClaimId);
  }
  const seeds = new Set<string>();
  for (const anchorClaimId of anchorClaimIds) {
    if (stateClaimIds.has(anchorClaimId)) {
      seeds.add(anchorClaimId);
      continue;
    }
    for (const edge of activeEdges) {
      if (edge.edgeType !== "supports" && edge.edgeType !== "caused_by")
        continue;
      if (
        edge.fromClaimId === anchorClaimId &&
        stateClaimIds.has(edge.toClaimId)
      ) {
        seeds.add(edge.toClaimId);
      }
      if (
        edge.toClaimId === anchorClaimId &&
        stateClaimIds.has(edge.fromClaimId)
      ) {
        seeds.add(edge.fromClaimId);
      }
    }
  }
  if (seeds.size === 0) {
    throw namedError("MemoryAspectStateLineageAmbiguous");
  }
  const components = [...seeds].map((seed) => component(adjacency, seed));
  const firstComponent = components[0] as ReadonlySet<string>;
  if (components.some((candidate) => !sameSet(firstComponent, candidate))) {
    throw namedError("MemoryAspectStateLineageAmbiguous");
  }
  const lineageClaimIds = new Set(firstComponent);
  const superseded = new Set(
    activeEdges
      .filter(
        (edge) =>
          edge.edgeType === "supersedes" &&
          lineageClaimIds.has(edge.fromClaimId) &&
          lineageClaimIds.has(edge.toClaimId),
      )
      .map((edge) => edge.toClaimId),
  );
  const currentClaimIds: string[] = [];
  const historicalClaimIds: string[] = [];
  const futureClaimIds: string[] = [];
  for (const claimId of [...lineageClaimIds].sort((left, right) =>
    compareClaims(required(claims, left), required(claims, right)),
  )) {
    const claim = required(claims, claimId);
    if (Date.parse(claim.validFrom) > Date.parse(asOf)) {
      futureClaimIds.push(claimId);
    } else if (
      superseded.has(claimId) ||
      (claim.validTo !== undefined &&
        Date.parse(claim.validTo) <= Date.parse(asOf))
    ) {
      historicalClaimIds.push(claimId);
    } else {
      currentClaimIds.push(claimId);
    }
  }
  const relatedEvidenceIds = new Set<string>();
  for (const edge of activeEdges) {
    if (
      lineageClaimIds.has(edge.fromClaimId) &&
      !lineageClaimIds.has(edge.toClaimId)
    )
      relatedEvidenceIds.add(edge.toClaimId);
    if (
      lineageClaimIds.has(edge.toClaimId) &&
      !lineageClaimIds.has(edge.fromClaimId)
    )
      relatedEvidenceIds.add(edge.fromClaimId);
  }
  const eventClaimIds: string[] = [];
  const causeClaimIds: string[] = [];
  const conditionClaimIds: string[] = [];
  for (const claimId of [...relatedEvidenceIds].sort()) {
    const roles = rolesByClaim.get(claimId);
    if (roles?.has("event")) eventClaimIds.push(claimId);
    if (roles?.has("cause")) causeClaimIds.push(claimId);
    if (roles?.has("condition")) conditionClaimIds.push(claimId);
  }
  const selectedClaimIds = new Set([
    ...lineageClaimIds,
    ...eventClaimIds,
    ...causeClaimIds,
    ...conditionClaimIds,
  ]);
  const selectedEdges = Object.freeze(
    activeEdges
      .filter(
        (edge) =>
          selectedClaimIds.has(edge.fromClaimId) ||
          selectedClaimIds.has(edge.toClaimId),
      )
      .sort(compareEdges),
  );
  const neighborClaimIds = Object.freeze(
    [
      ...new Set(
        selectedEdges.flatMap((edge) => [edge.fromClaimId, edge.toClaimId]),
      ),
    ]
      .filter((claimId) => !selectedClaimIds.has(claimId))
      .sort(),
  );
  const revisionInput = {
    schemaVersion: PAW_MEMORY_ASPECT_STATE_LINEAGE_VERSION_V1,
    snapshotRevision: input.snapshot.revision,
    asOf,
    anchorClaimIds,
    stateScope,
  };
  return Object.freeze({
    schemaVersion: PAW_MEMORY_ASPECT_STATE_LINEAGE_VERSION_V1,
    stateScope,
    anchorClaimIds: Object.freeze(anchorClaimIds),
    lineageClaimIds: Object.freeze([...lineageClaimIds].sort()),
    projectionRevision: hashCanonicalJsonV1(
      revisionInput as unknown as JsonValue,
    ),
    currentClaimIds: Object.freeze(currentClaimIds),
    historicalClaimIds: Object.freeze(historicalClaimIds),
    futureClaimIds: Object.freeze(futureClaimIds),
    eventClaimIds: Object.freeze(eventClaimIds),
    causeClaimIds: Object.freeze(causeClaimIds),
    conditionClaimIds: Object.freeze(conditionClaimIds),
    edges: selectedEdges,
    neighborClaimIds,
  });
}

function activeMemberships(
  snapshot: MemoryAspectGraphSnapshotV1,
  asOf: string,
) {
  const retracted = new Set(
    snapshot.lifecycleEvents
      .filter(
        (event) =>
          event.targetKind === "membership" &&
          Date.parse(event.occurredAt) <= Date.parse(asOf),
      )
      .map((event) => event.targetId),
  );
  return snapshot.memberships.filter(
    (membership) =>
      Date.parse(membership.createdAt) <= Date.parse(asOf) &&
      !retracted.has(membership.id),
  );
}

function activeEdgesAt(
  snapshot: MemoryAspectGraphSnapshotV1,
  asOf: string,
): readonly MemoryEvidenceEdgeV1[] {
  const retracted = new Set(
    snapshot.lifecycleEvents
      .filter(
        (event) =>
          event.targetKind === "edge" &&
          Date.parse(event.occurredAt) <= Date.parse(asOf),
      )
      .map((event) => event.targetId),
  );
  return snapshot.edges.filter(
    (edge) =>
      !retracted.has(edge.id) &&
      Date.parse(edge.createdAt) <= Date.parse(asOf) &&
      Date.parse(edge.effectiveFrom) <= Date.parse(asOf),
  );
}

function component(
  adjacency: ReadonlyMap<string, ReadonlySet<string>>,
  seed: string,
): ReadonlySet<string> {
  const visited = new Set([seed]);
  const pending = [seed];
  while (pending.length > 0) {
    const current = pending.pop() as string;
    for (const neighbor of adjacency.get(current) ?? []) {
      if (visited.has(neighbor)) continue;
      visited.add(neighbor);
      pending.push(neighbor);
    }
  }
  return visited;
}

function addUndirected(
  adjacency: Map<string, Set<string>>,
  left: string,
  right: string,
): void {
  const leftNeighbors = adjacency.get(left) ?? new Set<string>();
  leftNeighbors.add(right);
  adjacency.set(left, leftNeighbors);
  const rightNeighbors = adjacency.get(right) ?? new Set<string>();
  rightNeighbors.add(left);
  adjacency.set(right, rightNeighbors);
}

function hasStateRole(roles: ReadonlySet<MemoryAspectClaimRoleV1>): boolean {
  return roles.has("state") || roles.has("fact");
}

function sameSet(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean {
  return left.size === right.size && [...left].every((item) => right.has(item));
}

function scopeKey(scope: MemoryAspectStateScopeV1): string {
  return `${scope.subjectKey}\n${scope.aspectId}\n${scope.contextKey}`;
}

function stableIds(values: readonly string[], errorName: string): string[] {
  if (
    values.some(
      (value) =>
        typeof value !== "string" ||
        value.length < 1 ||
        value.length > 512 ||
        value.trim() !== value,
    ) ||
    new Set(values).size !== values.length
  ) {
    throw namedError(errorName);
  }
  return [...values].sort();
}

function canonicalIso(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw namedError("MemoryAspectStateLineageTimeInvalid");
  }
  return value;
}

function compareClaims(
  left: Readonly<{ id: string; validFrom: string; ingestedAt: string }>,
  right: Readonly<{ id: string; validFrom: string; ingestedAt: string }>,
): number {
  return (
    Date.parse(left.validFrom) - Date.parse(right.validFrom) ||
    Date.parse(left.ingestedAt) - Date.parse(right.ingestedAt) ||
    left.id.localeCompare(right.id)
  );
}

function compareEdges(
  left: MemoryEvidenceEdgeV1,
  right: MemoryEvidenceEdgeV1,
): number {
  return (
    left.edgeType.localeCompare(right.edgeType) ||
    left.fromClaimId.localeCompare(right.fromClaimId) ||
    left.toClaimId.localeCompare(right.toClaimId) ||
    left.id.localeCompare(right.id)
  );
}

function required<T>(map: ReadonlyMap<string, T>, id: string): T {
  const value = map.get(id);
  if (value === undefined)
    throw namedError("MemoryAspectStateLineageClaimUnknown");
  return value;
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
