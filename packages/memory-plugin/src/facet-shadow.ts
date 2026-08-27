import type { MemoryEntry } from "@paw/memory/longterm";
import type { JsonValue } from "@paw/protocol";

import { hashCanonicalJsonV1 } from "./canonical.js";
import type {
  MemoryFacetReconcileCatalogItemV2,
  MemoryFacetReconcileObservationV2,
  MemoryFacetReconciliationV2,
} from "./facet-reconciler.js";
import {
  type MemoryFacetEvidenceStateV2,
  type MemoryFacetMembershipV2,
  type MemoryFacetStateProjectionV2,
  type MemoryFacetV2,
  projectMemoryFacetStateV2,
} from "./facet-state.js";
import {
  type PawNextMemoryScopeV1,
  memoryScopeFingerprintV1,
} from "./profile.js";

export const PAW_MEMORY_FACET_SHADOW_SNAPSHOT_VERSION_V2 =
  "paw.memory-facet-shadow-snapshot.v2" as const;

/**
 * Immutable in-memory reducer used for backfill/A-B work before Facet V2 owns a
 * durable product store. It is deliberately outside the live read path.
 */
export interface MemoryFacetShadowSnapshotV2 {
  readonly schemaVersion: typeof PAW_MEMORY_FACET_SHADOW_SNAPSHOT_VERSION_V2;
  readonly scopeFingerprint: string;
  readonly revision: string;
  readonly facets: readonly MemoryFacetV2[];
  readonly memberships: readonly MemoryFacetMembershipV2[];
  readonly entries: readonly MemoryEntry[];
  readonly projections: readonly MemoryFacetStateProjectionV2[];
  readonly unassignedMemoryIds: readonly string[];
}

export interface MemoryFacetShadowEventV2 {
  readonly schemaVersion: "paw.memory-facet-shadow-event.v2";
  readonly type: "applied" | "failed";
  readonly previousRevision: string;
  readonly nextRevision?: string;
  readonly observationCount: number;
  readonly facetCount?: number;
  readonly membershipCount?: number;
  readonly unassignedCount?: number;
  readonly reasonCode?: string;
  readonly durationMs: number;
}

export function createEmptyMemoryFacetShadowSnapshotV2(
  scope: PawNextMemoryScopeV1,
): MemoryFacetShadowSnapshotV2 {
  return settleSnapshot({
    scopeFingerprint: memoryScopeFingerprintV1(scope),
    facets: [],
    memberships: [],
    entries: [],
    projections: [],
    unassignedMemoryIds: [],
  });
}

export function applyMemoryFacetShadowReconciliationV2(
  input: Readonly<{
    scope: PawNextMemoryScopeV1;
    previous: MemoryFacetShadowSnapshotV2;
    observations: readonly MemoryEntry[];
    reconciliation: MemoryFacetReconciliationV2;
  }>,
  options: Readonly<{
    onEvent?: (event: MemoryFacetShadowEventV2) => void;
    now?: () => number;
  }> = {},
): MemoryFacetShadowSnapshotV2 {
  const now = options.now ?? Date.now;
  const started = now();
  try {
    const scopeFingerprint = memoryScopeFingerprintV1(input.scope);
    if (
      input.previous.schemaVersion !==
        PAW_MEMORY_FACET_SHADOW_SNAPSHOT_VERSION_V2 ||
      input.previous.scopeFingerprint !== scopeFingerprint
    ) {
      throw namedError("MemoryFacetShadowScopeInvalid");
    }
    const entries = new Map(
      input.previous.entries.map((entry) => [entry.id, entry]),
    );
    const priorMemberships = new Map(
      input.previous.memberships.map((membership) => [
        membership.memoryId,
        membership,
      ]),
    );
    const priorUnassigned = new Set(input.previous.unassignedMemoryIds);
    const observationIds = new Set<string>();
    for (const entry of input.observations) {
      assertObservationEntry(entry);
      if (observationIds.has(entry.id) || priorMemberships.has(entry.id)) {
        throw namedError("MemoryFacetShadowObservationDuplicate");
      }
      const existing = entries.get(entry.id);
      if (existing && !priorUnassigned.has(entry.id)) {
        throw namedError("MemoryFacetShadowObservationDuplicate");
      }
      if (existing && hashEntry(existing) !== hashEntry(entry)) {
        throw namedError("MemoryFacetShadowObservationChanged");
      }
      entries.set(entry.id, entry);
      observationIds.add(entry.id);
    }

    const reconciledIds = new Set([
      ...input.reconciliation.memberships.map((item) => item.memoryId),
      ...input.reconciliation.deferredMemoryIds,
    ]);
    if (
      reconciledIds.size !== observationIds.size ||
      [...observationIds].some((id) => !reconciledIds.has(id))
    ) {
      throw namedError("MemoryFacetShadowPartitionInvalid");
    }

    const facets = new Map(
      input.previous.facets.map((facet) => [facet.id, facet]),
    );
    for (const facet of input.reconciliation.facets) {
      if (facet.scopeFingerprint !== scopeFingerprint) {
        throw namedError("MemoryFacetShadowFacetScopeInvalid");
      }
      const existing = facets.get(facet.id);
      if (existing && hashFacet(existing) !== hashFacet(facet)) {
        throw namedError("MemoryFacetShadowFacetChanged");
      }
      facets.set(facet.id, facet);
    }

    const memberships = new Map(priorMemberships);
    const unassigned = new Set(priorUnassigned);
    for (const membership of input.reconciliation.memberships) {
      if (
        !observationIds.has(membership.memoryId) ||
        !facets.has(membership.facetId)
      ) {
        throw namedError("MemoryFacetShadowMembershipInvalid");
      }
      memberships.set(membership.memoryId, membership);
      unassigned.delete(membership.memoryId);
    }
    for (const memoryId of input.reconciliation.deferredMemoryIds) {
      if (!observationIds.has(memoryId)) {
        throw namedError("MemoryFacetShadowDeferredInvalid");
      }
      unassigned.add(memoryId);
    }

    const sortedFacets = [...facets.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
    const sortedMemberships = [...memberships.values()].sort((left, right) =>
      left.memoryId.localeCompare(right.memoryId),
    );
    const projections = sortedFacets.flatMap((facet) => {
      const facetMemberships = sortedMemberships.filter(
        (membership) => membership.facetId === facet.id,
      );
      if (facetMemberships.length === 0) return [];
      return [
        projectMemoryFacetStateV2({
          facet,
          memberships: facetMemberships,
          entries: facetMemberships.map((membership) =>
            requiredEntry(entries, membership.memoryId),
          ),
        }),
      ];
    });
    const next = settleSnapshot({
      scopeFingerprint,
      facets: sortedFacets,
      memberships: sortedMemberships,
      entries: [...entries.values()].sort((left, right) =>
        left.id.localeCompare(right.id),
      ),
      projections,
      unassignedMemoryIds: [...unassigned].sort(),
    });
    emit(options.onEvent, {
      schemaVersion: "paw.memory-facet-shadow-event.v2",
      type: "applied",
      previousRevision: input.previous.revision,
      nextRevision: next.revision,
      observationCount: input.observations.length,
      facetCount: next.facets.length,
      membershipCount: next.memberships.length,
      unassignedCount: next.unassignedMemoryIds.length,
      durationMs: Math.max(0, now() - started),
    });
    return next;
  } catch (error) {
    emit(options.onEvent, {
      schemaVersion: "paw.memory-facet-shadow-event.v2",
      type: "failed",
      previousRevision: input.previous.revision,
      observationCount: input.observations.length,
      reasonCode: stableReason(error),
      durationMs: Math.max(0, now() - started),
    });
    throw error;
  }
}

export function createMemoryFacetReconcileCatalogFromSnapshotV2(
  snapshot: MemoryFacetShadowSnapshotV2,
  maxMembersPerFacet = 64,
): readonly MemoryFacetReconcileCatalogItemV2[] {
  const limit = Math.max(1, Math.min(maxMembersPerFacet, 64));
  return Object.freeze(
    snapshot.projections.map((projection) =>
      Object.freeze({
        facet: projection.facet,
        members: Object.freeze(
          [
            ...catalogMembers(projection.currentStates, "current"),
            ...catalogMembers(projection.contextualStates, "contextual"),
            ...catalogMembers(projection.historicalStates, "historical"),
            ...catalogMembers(projection.supportingStates, "supporting"),
            ...catalogMembers(projection.events, "event"),
            ...catalogMembers(projection.causes, "cause"),
            ...catalogMembers(projection.conditions, "condition"),
            ...catalogMembers(projection.unresolved, "unresolved"),
          ].slice(0, limit),
        ),
      }),
    ),
  );
}

/**
 * Keeps the complete identity directory while attaching member evidence only
 * to the facets lexically nearest to the new observations. This prevents
 * catalog growth from repeatedly expanding every reconciliation prompt.
 */
export function compactMemoryFacetReconcileCatalogV2(
  input: Readonly<{
    observations: readonly MemoryFacetReconcileObservationV2[];
    catalog: readonly MemoryFacetReconcileCatalogItemV2[];
    maxFacetsWithMembers: number;
    maxMembersPerFacet: number;
  }>,
): readonly MemoryFacetReconcileCatalogItemV2[] {
  const maxFacetsWithMembers = boundedInteger(
    input.maxFacetsWithMembers,
    1,
    32,
    "MemoryFacetShadowCandidateLimitInvalid",
  );
  const maxMembersPerFacet = boundedInteger(
    input.maxMembersPerFacet,
    1,
    16,
    "MemoryFacetShadowMemberLimitInvalid",
  );
  if (input.catalog.length > 128 || input.observations.length > 32) {
    throw namedError("MemoryFacetShadowCatalogLimitInvalid");
  }
  const observationTerms = new Set(
    input.observations.flatMap((observation) => terms(observation.statement)),
  );
  const ranked = input.catalog
    .map((item) => ({ item, score: catalogScore(item, observationTerms) }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.item.facet.id.localeCompare(right.item.facet.id),
    );
  const hydrated = new Set(
    ranked
      .filter((item) => item.score > 0)
      .slice(0, maxFacetsWithMembers)
      .map((item) => item.item.facet.id),
  );
  return Object.freeze(
    input.catalog.map((item) =>
      Object.freeze({
        facet: item.facet,
        members: hydrated.has(item.facet.id)
          ? Object.freeze(item.members.slice(0, maxMembersPerFacet))
          : Object.freeze([]),
      }),
    ),
  );
}

export function memoryEntryToFacetObservationV2(
  entry: MemoryEntry,
): MemoryFacetReconcileObservationV2 {
  assertObservationEntry(entry);
  return Object.freeze({
    id: entry.id,
    kind: entry.kind,
    statement: renderEntry(entry),
    validFrom: entry.tValid,
    ...(entry.tInvalid === null ? {} : { validTo: entry.tInvalid }),
  });
}

/**
 * Reconciliation units follow provenance families, not arbitrary row counts.
 * Atoms extracted from one conversation/document stay together so event,
 * state, cause, and condition can be classified in one semantic decision.
 */
export function createMemoryFacetEvidenceBatchesV2(
  entries: readonly MemoryEntry[],
  maxBatchSize = 16,
): readonly (readonly MemoryEntry[])[] {
  const limit = boundedInteger(
    maxBatchSize,
    1,
    32,
    "MemoryFacetShadowBatchLimitInvalid",
  );
  const components: Array<{
    family: string;
    refs: Set<string>;
    entries: MemoryEntry[];
  }> = [];
  for (const entry of [...entries].sort(compareEntriesChronologically)) {
    assertObservationEntry(entry);
    const refs = evidenceRefs(entry);
    const family = evidenceFamily(refs[0] ?? `entry:${entry.id}`);
    const matching = components
      .map((component, index) => ({ component, index }))
      .filter(
        ({ component }) =>
          component.family === family &&
          refs.some((ref) => component.refs.has(ref)),
      );
    if (matching.length === 0) {
      components.push({ family, refs: new Set(refs), entries: [entry] });
      continue;
    }
    const primary = matching[0]?.component;
    if (!primary) throw namedError("MemoryFacetShadowComponentInvalid");
    primary.entries.push(entry);
    for (const ref of refs) primary.refs.add(ref);
    for (const match of matching
      .slice(1)
      .sort((left, right) => right.index - left.index)) {
      for (const member of match.component.entries)
        primary.entries.push(member);
      for (const ref of match.component.refs) primary.refs.add(ref);
      components.splice(match.index, 1);
    }
  }
  const orderedComponents = components
    .map((component) => ({
      family: component.family,
      entries: [...component.entries].sort(compareEntriesChronologically),
    }))
    .sort(
      (left, right) =>
        Date.parse(left.entries[0]?.tValid ?? "") -
          Date.parse(right.entries[0]?.tValid ?? "") ||
        left.family.localeCompare(right.family),
    );
  const batches: MemoryEntry[][] = [];
  let pending: MemoryEntry[] = [];
  let pendingFamily: string | undefined;
  const flush = () => {
    if (pending.length > 0) batches.push(pending);
    pending = [];
    pendingFamily = undefined;
  };
  for (const component of orderedComponents) {
    if (component.entries.length > limit) {
      flush();
      for (let offset = 0; offset < component.entries.length; offset += limit) {
        batches.push(component.entries.slice(offset, offset + limit));
      }
      continue;
    }
    if (
      pending.length > 0 &&
      (pendingFamily !== component.family ||
        pending.length + component.entries.length > limit)
    ) {
      flush();
    }
    pendingFamily = component.family;
    pending.push(...component.entries);
  }
  flush();
  return Object.freeze(batches.map((batch) => Object.freeze(batch)));
}

function settleSnapshot(
  input: Omit<MemoryFacetShadowSnapshotV2, "schemaVersion" | "revision">,
): MemoryFacetShadowSnapshotV2 {
  const body = {
    schemaVersion: PAW_MEMORY_FACET_SHADOW_SNAPSHOT_VERSION_V2,
    scopeFingerprint: input.scopeFingerprint,
    facets: Object.freeze([...input.facets]),
    memberships: Object.freeze([...input.memberships]),
    entries: Object.freeze([...input.entries]),
    projections: Object.freeze([...input.projections]),
    unassignedMemoryIds: Object.freeze([...input.unassignedMemoryIds]),
  };
  return Object.freeze({
    ...body,
    revision: hashCanonicalJsonV1(body as unknown as JsonValue),
  });
}

function catalogMembers(
  states: readonly MemoryFacetEvidenceStateV2[],
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
  return states.map((state) =>
    Object.freeze({
      memoryId: state.memoryId,
      role: state.role,
      status,
      statement: state.statement,
      validFrom: state.validFrom,
      ...(state.validTo === undefined ? {} : { validTo: state.validTo }),
    }),
  );
}

function catalogScore(
  item: MemoryFacetReconcileCatalogItemV2,
  observationTerms: ReadonlySet<string>,
): number {
  const identityTerms = new Set(
    terms(
      [
        item.facet.canonicalKey,
        item.facet.displayName,
        ...item.facet.aliases,
      ].join(" "),
    ),
  );
  const memberTerms = new Set(
    item.members.slice(0, 16).flatMap((member) => terms(member.statement)),
  );
  let score = 0;
  for (const term of observationTerms) {
    if (identityTerms.has(term)) score += 4;
    else if (memberTerms.has(term)) score += 1;
  }
  return score;
}

function terms(value: string): string[] {
  return [
    ...new Set(
      value
        .normalize("NFKC")
        .toLocaleLowerCase()
        .match(/[\p{L}\p{N}]{2,}/gu) ?? [],
    ),
  ];
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  errorName: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw namedError(errorName);
  }
  return value;
}

function assertObservationEntry(
  entry: MemoryEntry,
): asserts entry is Extract<
  MemoryEntry,
  { kind: "semantic" | "episodic" | "profile" }
> {
  if (
    !entry.id.trim() ||
    (entry.kind !== "semantic" &&
      entry.kind !== "episodic" &&
      entry.kind !== "profile")
  ) {
    throw namedError("MemoryFacetShadowEntryInvalid");
  }
}

function renderEntry(
  entry: Extract<MemoryEntry, { kind: "semantic" | "episodic" | "profile" }>,
): string {
  if (entry.kind === "semantic") return entry.fact;
  if (entry.kind === "profile") return entry.insight;
  return entry.perspective || entry.whenToUse;
}

function evidenceRefs(entry: MemoryEntry): string[] {
  const refs = [...new Set(entry.evidence)]
    .map((ref) => ref.trim())
    .filter(Boolean)
    .sort();
  return refs.length > 0 ? refs : [`entry:${entry.id}`];
}

function evidenceFamily(ref: string): string {
  const fragment = ref.indexOf("#");
  return fragment > 0 ? ref.slice(0, fragment) : ref;
}

function compareEntriesChronologically(
  left: MemoryEntry,
  right: MemoryEntry,
): number {
  return (
    Date.parse(left.tValid) - Date.parse(right.tValid) ||
    left.id.localeCompare(right.id)
  );
}

function hashEntry(entry: MemoryEntry): string {
  return hashCanonicalJsonV1(entry as unknown as JsonValue);
}

function requiredEntry(
  entries: ReadonlyMap<string, MemoryEntry>,
  memoryId: string,
): MemoryEntry {
  const entry = entries.get(memoryId);
  if (!entry) throw namedError("MemoryFacetShadowEntryMissing");
  return entry;
}

function hashFacet(facet: MemoryFacetV2): string {
  return hashCanonicalJsonV1(facet as unknown as JsonValue);
}

function stableReason(error: unknown): string {
  const name = error instanceof Error ? error.name : "Unknown";
  return (
    `MemoryFacetShadow_${name}`.replace(/[^A-Za-z0-9_.:-]/g, "_") ||
    "MemoryFacetShadow_Unknown"
  ).slice(0, 160);
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

function emit(
  observer: ((event: MemoryFacetShadowEventV2) => void) | undefined,
  event: MemoryFacetShadowEventV2,
): void {
  try {
    observer?.(Object.freeze(event));
  } catch {
    // Caller-owned observability never changes shadow state.
  }
}
