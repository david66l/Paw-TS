import type { MemoryEntry } from "@paw/memory/longterm";
import type { JsonValue } from "@paw/protocol";

import { hashCanonicalJsonV1 } from "./canonical.js";
import {
  type PawNextMemoryScopeV1,
  memoryScopeFingerprintV1,
} from "./profile.js";

export const PAW_MEMORY_FACET_VERSION_V2 = "paw.memory-facet.v2" as const;
export const PAW_MEMORY_FACET_MEMBERSHIP_VERSION_V2 =
  "paw.memory-facet-membership.v2" as const;
export const PAW_MEMORY_FACET_STATE_PROJECTOR_VERSION_V2 =
  "paw.memory-facet-state-projector.v2" as const;
export const PAW_MEMORY_FACET_PROFILE_BRIDGE_MAX_CHARS_V2 = 320 as const;

export type MemoryFacetMemberRoleV2 = "state" | "event" | "cause" | "condition";

export type MemoryFacetLinkKindV2 =
  | "initial"
  | "same_state"
  | "state_change"
  | "context_variant"
  | "supports"
  | "unresolved";

/**
 * A facet is the stable identity of one user aspect. Topics and persona are
 * derived navigation views and must not be used as state identity.
 */
export interface MemoryFacetV2 {
  readonly schemaVersion: typeof PAW_MEMORY_FACET_VERSION_V2;
  readonly id: string;
  readonly scopeFingerprint: string;
  readonly canonicalKey: string;
  readonly displayName: string;
  readonly aliases: readonly string[];
}

/** Model-selected IDs are proposals; this validated record is authoritative. */
export interface MemoryFacetMembershipV2 {
  readonly schemaVersion: typeof PAW_MEMORY_FACET_MEMBERSHIP_VERSION_V2;
  readonly facetId: string;
  readonly memoryId: string;
  readonly role: MemoryFacetMemberRoleV2;
  readonly linkKind: MemoryFacetLinkKindV2;
  readonly targetMemoryIds: readonly string[];
  readonly confidence: number;
}

export interface MemoryFacetEvidenceStateV2 {
  readonly memoryId: string;
  readonly kind: MemoryEntry["kind"];
  readonly role: MemoryFacetMemberRoleV2;
  /** Exact L1 content. The projector never rewrites source evidence. */
  readonly statement: string;
  readonly validFrom: string;
  readonly validTo?: string;
  readonly confidence: number;
  readonly evidenceRefs: readonly string[];
}

export interface MemoryFacetStateProjectionV2 {
  readonly schemaVersion: typeof PAW_MEMORY_FACET_STATE_PROJECTOR_VERSION_V2;
  readonly facet: MemoryFacetV2;
  readonly membershipRevision: string;
  readonly projectionRevision: string;
  readonly currentStates: readonly MemoryFacetEvidenceStateV2[];
  readonly historicalStates: readonly MemoryFacetEvidenceStateV2[];
  readonly contextualStates: readonly MemoryFacetEvidenceStateV2[];
  readonly supportingStates: readonly MemoryFacetEvidenceStateV2[];
  readonly events: readonly MemoryFacetEvidenceStateV2[];
  readonly causes: readonly MemoryFacetEvidenceStateV2[];
  readonly conditions: readonly MemoryFacetEvidenceStateV2[];
  readonly unresolved: readonly MemoryFacetEvidenceStateV2[];
}

/** Content-free telemetry: no statement, alias, or evidence content is emitted. */
export interface MemoryFacetStateProjectorEventV2 {
  readonly schemaVersion: "paw.memory-facet-state-projector-event.v2";
  readonly type: "projected" | "failed";
  readonly facetId: string;
  readonly membershipRevision?: string;
  readonly projectionRevision?: string;
  readonly membershipCount: number;
  readonly currentStateCount?: number;
  readonly historicalStateCount?: number;
  readonly contextualStateCount?: number;
  readonly unresolvedCount?: number;
  readonly reasonCode?: string;
  readonly durationMs: number;
}

/**
 * Facet consumes atomic L1 evidence. Existing short profile claims are admitted
 * only as a migration bridge; long L3 rollups must never feed a derived view
 * back into its own source layer.
 */
export function isMemoryFacetSourceEntryV2(
  entry: MemoryEntry,
): entry is Extract<
  MemoryEntry,
  { kind: "semantic" | "episodic" | "profile" }
> {
  if (entry.kind === "semantic" || entry.kind === "episodic") return true;
  return (
    entry.kind === "profile" &&
    entry.insight.trim().length > 0 &&
    entry.insight.length <= PAW_MEMORY_FACET_PROFILE_BRIDGE_MAX_CHARS_V2
  );
}

export function normalizeMemoryFacetKeyV2(value: string): string {
  const normalized = displayText(value, "MemoryFacetKeyInvalid", 160)
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ".")
    .replace(/^\.+|\.+$/g, "")
    .replace(/\.{2,}/g, ".");
  if (normalized.length < 3) throw namedError("MemoryFacetKeyInvalid");
  return normalized;
}

export function deriveMemoryFacetIdV2(
  input: Readonly<{
    scope: PawNextMemoryScopeV1;
    canonicalKey: string;
  }>,
): string {
  return hashCanonicalJsonV1({
    schemaVersion: PAW_MEMORY_FACET_VERSION_V2,
    scopeFingerprint: memoryScopeFingerprintV1(input.scope),
    canonicalKey: normalizeMemoryFacetKeyV2(input.canonicalKey),
  });
}

export function createMemoryFacetV2(
  input: Readonly<{
    scope: PawNextMemoryScopeV1;
    canonicalKey: string;
    displayName: string;
    aliases?: readonly string[];
  }>,
): MemoryFacetV2 {
  const canonicalKey = normalizeMemoryFacetKeyV2(input.canonicalKey);
  const displayName = displayText(
    input.displayName,
    "MemoryFacetDisplayNameInvalid",
    160,
  );
  const aliases = Object.freeze(
    [...new Set((input.aliases ?? []).map((item) => alias(item)))]
      .filter((item) => item !== alias(displayName))
      .sort((left, right) => left.localeCompare(right)),
  );
  return Object.freeze({
    schemaVersion: PAW_MEMORY_FACET_VERSION_V2,
    id: deriveMemoryFacetIdV2({ scope: input.scope, canonicalKey }),
    scopeFingerprint: memoryScopeFingerprintV1(input.scope),
    canonicalKey,
    displayName,
    aliases,
  });
}

export function createMemoryFacetMembershipV2(
  input: Readonly<{
    facetId: string;
    memoryId: string;
    role: MemoryFacetMemberRoleV2;
    linkKind: MemoryFacetLinkKindV2;
    targetMemoryIds?: readonly string[];
    confidence: number;
  }>,
): MemoryFacetMembershipV2 {
  const facetId = identity(input.facetId, "MemoryFacetMembershipFacetInvalid");
  const memoryId = identity(
    input.memoryId,
    "MemoryFacetMembershipMemoryInvalid",
  );
  assertRoleAndLink(input.role, input.linkKind);
  const targetMemoryIds = Object.freeze(
    [
      ...new Set(
        (input.targetMemoryIds ?? []).map((item) =>
          identity(item, "MemoryFacetMembershipTargetInvalid"),
        ),
      ),
    ]
      .filter((item) => item !== memoryId)
      .sort((left, right) => left.localeCompare(right)),
  );
  if (input.linkKind === "initial" && targetMemoryIds.length > 0) {
    throw namedError("MemoryFacetInitialTargetsInvalid");
  }
  if (
    input.linkKind !== "initial" &&
    input.linkKind !== "unresolved" &&
    targetMemoryIds.length === 0
  ) {
    throw namedError("MemoryFacetLinkTargetsMissing");
  }
  if (
    typeof input.confidence !== "number" ||
    !Number.isFinite(input.confidence) ||
    input.confidence < 0 ||
    input.confidence > 1
  ) {
    throw namedError("MemoryFacetMembershipConfidenceInvalid");
  }
  return Object.freeze({
    schemaVersion: PAW_MEMORY_FACET_MEMBERSHIP_VERSION_V2,
    facetId,
    memoryId,
    role: input.role,
    linkKind: input.linkKind,
    targetMemoryIds,
    confidence: input.confidence,
  });
}

/**
 * Deterministically materializes current/history/conditional buckets from
 * validated memberships. It never infers similarity and never rewrites L1.
 */
export function projectMemoryFacetStateV2(
  input: Readonly<{
    facet: MemoryFacetV2;
    memberships: readonly MemoryFacetMembershipV2[];
    entries: readonly MemoryEntry[];
  }>,
  options: Readonly<{
    onEvent?: (event: MemoryFacetStateProjectorEventV2) => void;
    now?: () => number;
  }> = {},
): MemoryFacetStateProjectionV2 {
  const now = options.now ?? Date.now;
  const started = now();
  let membershipRevision: string | undefined;
  try {
    const facet = assertFacet(input.facet);
    const entries = uniqueEntries(input.entries);
    const memberships = validatedMemberships(facet, input.memberships, entries);
    membershipRevision = hashCanonicalJsonV1(
      memberships.map(projectMembership) as unknown as JsonValue,
    );

    const historicalIds = new Set<string>();
    const supportingIds = new Set<string>();
    const contextualIds = new Set<string>();
    const unresolvedIds = new Set<string>();
    for (const membership of memberships) {
      const entry = requiredEntry(entries, membership.memoryId);
      if (entry.tInvalid !== null) historicalIds.add(membership.memoryId);
      if (membership.linkKind === "state_change") {
        for (const id of membership.targetMemoryIds) historicalIds.add(id);
      } else if (membership.linkKind === "same_state") {
        for (const id of membership.targetMemoryIds) supportingIds.add(id);
      } else if (membership.linkKind === "context_variant") {
        contextualIds.add(membership.memoryId);
      } else if (membership.linkKind === "unresolved") {
        unresolvedIds.add(membership.memoryId);
      }
    }

    const buckets = {
      currentStates: [] as MemoryFacetEvidenceStateV2[],
      historicalStates: [] as MemoryFacetEvidenceStateV2[],
      contextualStates: [] as MemoryFacetEvidenceStateV2[],
      supportingStates: [] as MemoryFacetEvidenceStateV2[],
      events: [] as MemoryFacetEvidenceStateV2[],
      causes: [] as MemoryFacetEvidenceStateV2[],
      conditions: [] as MemoryFacetEvidenceStateV2[],
      unresolved: [] as MemoryFacetEvidenceStateV2[],
    };
    for (const membership of memberships) {
      const state = evidenceState(
        requiredEntry(entries, membership.memoryId),
        membership.role,
      );
      if (unresolvedIds.has(membership.memoryId)) {
        buckets.unresolved.push(state);
        continue;
      }
      if (membership.role === "event") {
        buckets.events.push(state);
        continue;
      }
      if (membership.role === "cause") {
        buckets.causes.push(state);
        continue;
      }
      if (membership.role === "condition") {
        buckets.conditions.push(state);
        continue;
      }
      if (historicalIds.has(membership.memoryId)) {
        buckets.historicalStates.push(state);
      } else if (contextualIds.has(membership.memoryId)) {
        buckets.contextualStates.push(state);
      } else if (supportingIds.has(membership.memoryId)) {
        buckets.supportingStates.push(state);
      } else {
        buckets.currentStates.push(state);
      }
    }
    for (const values of Object.values(buckets)) values.sort(compareEvidence);
    const frozenBuckets = Object.fromEntries(
      Object.entries(buckets).map(([key, value]) => [
        key,
        Object.freeze(value),
      ]),
    ) as unknown as Omit<
      MemoryFacetStateProjectionV2,
      "schemaVersion" | "facet" | "membershipRevision" | "projectionRevision"
    >;
    const body = {
      schemaVersion: PAW_MEMORY_FACET_STATE_PROJECTOR_VERSION_V2,
      facet,
      membershipRevision,
      ...frozenBuckets,
    };
    const projectionRevision = hashCanonicalJsonV1(
      body as unknown as JsonValue,
    );
    const projection = Object.freeze({
      ...body,
      projectionRevision,
    });
    emit(options.onEvent, {
      schemaVersion: "paw.memory-facet-state-projector-event.v2",
      type: "projected",
      facetId: facet.id,
      membershipRevision,
      projectionRevision,
      membershipCount: memberships.length,
      currentStateCount: projection.currentStates.length,
      historicalStateCount: projection.historicalStates.length,
      contextualStateCount: projection.contextualStates.length,
      unresolvedCount: projection.unresolved.length,
      durationMs: Math.max(0, now() - started),
    });
    return projection;
  } catch (error) {
    emit(options.onEvent, {
      schemaVersion: "paw.memory-facet-state-projector-event.v2",
      type: "failed",
      facetId: safeEventFacetId(input.facet),
      ...(membershipRevision ? { membershipRevision } : {}),
      membershipCount: input.memberships.length,
      reasonCode: stableReason(error),
      durationMs: Math.max(0, now() - started),
    });
    throw error;
  }
}

function assertFacet(facet: MemoryFacetV2): MemoryFacetV2 {
  if (
    facet.schemaVersion !== PAW_MEMORY_FACET_VERSION_V2 ||
    !facet.id.trim() ||
    !facet.scopeFingerprint.trim() ||
    facet.canonicalKey !== normalizeMemoryFacetKeyV2(facet.canonicalKey) ||
    !facet.displayName.trim()
  ) {
    throw namedError("MemoryFacetInvalid");
  }
  return facet;
}

function uniqueEntries(
  entries: readonly MemoryEntry[],
): Map<string, MemoryEntry> {
  const byId = new Map<string, MemoryEntry>();
  for (const entry of entries) {
    if (!entry.id.trim() || byId.has(entry.id)) {
      throw namedError("MemoryFacetEntryInvalid");
    }
    if (
      !validIso(entry.tValid) ||
      (entry.tInvalid !== null && !validIso(entry.tInvalid))
    ) {
      throw namedError("MemoryFacetEntryTimeInvalid");
    }
    byId.set(entry.id, entry);
  }
  return byId;
}

function validatedMemberships(
  facet: MemoryFacetV2,
  values: readonly MemoryFacetMembershipV2[],
  entries: ReadonlyMap<string, MemoryEntry>,
): readonly MemoryFacetMembershipV2[] {
  const byMemoryId = new Map<string, MemoryFacetMembershipV2>();
  for (const value of values) {
    const membership = createMemoryFacetMembershipV2(value);
    if (
      membership.schemaVersion !== PAW_MEMORY_FACET_MEMBERSHIP_VERSION_V2 ||
      membership.facetId !== facet.id ||
      !entries.has(membership.memoryId) ||
      byMemoryId.has(membership.memoryId)
    ) {
      throw namedError("MemoryFacetMembershipInvalid");
    }
    byMemoryId.set(membership.memoryId, membership);
  }
  for (const membership of byMemoryId.values()) {
    for (const targetId of membership.targetMemoryIds) {
      const target = byMemoryId.get(targetId);
      if (!target) throw namedError("MemoryFacetMembershipTargetMissing");
      if (
        (membership.linkKind === "same_state" ||
          membership.linkKind === "state_change" ||
          membership.linkKind === "context_variant") &&
        target.role !== "state"
      ) {
        throw namedError("MemoryFacetStateTargetInvalid");
      }
    }
  }
  return Object.freeze(
    [...byMemoryId.values()].sort((left, right) =>
      left.memoryId.localeCompare(right.memoryId),
    ),
  );
}

function projectMembership(value: MemoryFacetMembershipV2) {
  return {
    facetId: value.facetId,
    memoryId: value.memoryId,
    role: value.role,
    linkKind: value.linkKind,
    targetMemoryIds: value.targetMemoryIds,
    confidence: value.confidence,
  };
}

function evidenceState(
  entry: MemoryEntry,
  role: MemoryFacetMemberRoleV2,
): MemoryFacetEvidenceStateV2 {
  return Object.freeze({
    memoryId: entry.id,
    kind: entry.kind,
    role,
    statement: renderEntry(entry),
    validFrom: entry.tValid,
    ...(entry.tInvalid === null ? {} : { validTo: entry.tInvalid }),
    confidence: boundedConfidence(entry.confidence),
    evidenceRefs: Object.freeze([...new Set(entry.evidence)].sort()),
  });
}

function renderEntry(entry: MemoryEntry): string {
  if (entry.kind === "semantic") return entry.fact;
  if (entry.kind === "profile") return entry.insight;
  if (entry.kind === "vault_ref") return entry.refDescription;
  return entry.perspective || entry.whenToUse;
}

function compareEvidence(
  left: MemoryFacetEvidenceStateV2,
  right: MemoryFacetEvidenceStateV2,
): number {
  return (
    Date.parse(right.validFrom) - Date.parse(left.validFrom) ||
    left.memoryId.localeCompare(right.memoryId)
  );
}

function requiredEntry(
  entries: ReadonlyMap<string, MemoryEntry>,
  memoryId: string,
): MemoryEntry {
  const entry = entries.get(memoryId);
  if (!entry) throw namedError("MemoryFacetEntryMissing");
  return entry;
}

function assertRoleAndLink(
  role: MemoryFacetMemberRoleV2,
  linkKind: MemoryFacetLinkKindV2,
): void {
  const roles: readonly MemoryFacetMemberRoleV2[] = [
    "state",
    "event",
    "cause",
    "condition",
  ];
  const links: readonly MemoryFacetLinkKindV2[] = [
    "initial",
    "same_state",
    "state_change",
    "context_variant",
    "supports",
    "unresolved",
  ];
  if (!roles.includes(role) || !links.includes(linkKind)) {
    throw namedError("MemoryFacetMembershipKindInvalid");
  }
  if (
    role === "state" &&
    linkKind !== "initial" &&
    linkKind !== "same_state" &&
    linkKind !== "state_change" &&
    linkKind !== "context_variant" &&
    linkKind !== "unresolved"
  ) {
    throw namedError("MemoryFacetStateLinkInvalid");
  }
  if (
    role !== "state" &&
    linkKind !== "initial" &&
    linkKind !== "supports" &&
    linkKind !== "unresolved"
  ) {
    throw namedError("MemoryFacetNonStateLinkInvalid");
  }
}

function displayText(
  value: string,
  errorName: string,
  maxChars: number,
): string {
  if (typeof value !== "string") throw namedError(errorName);
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > maxChars || hasControl(normalized)) {
    throw namedError(errorName);
  }
  return normalized;
}

function alias(value: string): string {
  return displayText(value, "MemoryFacetAliasInvalid", 160)
    .normalize("NFKC")
    .toLocaleLowerCase();
}

function identity(value: string, errorName: string): string {
  if (typeof value !== "string") throw namedError(errorName);
  const normalized = value.trim();
  if (!normalized || normalized.length > 256 || hasControl(normalized)) {
    throw namedError(errorName);
  }
  return normalized;
}

function boundedConfidence(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function validIso(value: string): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function hasControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
}

function safeEventFacetId(value: unknown): string {
  if (value && typeof value === "object" && "id" in value) {
    const id = (value as { id?: unknown }).id;
    if (typeof id === "string" && id.trim()) return id.slice(0, 256);
  }
  return "invalid";
}

function stableReason(error: unknown): string {
  const name = error instanceof Error ? error.name : "Unknown";
  return (
    `MemoryFacetProjector_${name}`.replace(/[^A-Za-z0-9_.:-]/g, "_") ||
    "MemoryFacetProjector_Unknown"
  ).slice(0, 160);
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

function emit(
  observer: ((event: MemoryFacetStateProjectorEventV2) => void) | undefined,
  event: MemoryFacetStateProjectorEventV2,
): void {
  try {
    observer?.(Object.freeze(event));
  } catch {
    // Caller-owned observability never changes projection correctness.
  }
}
