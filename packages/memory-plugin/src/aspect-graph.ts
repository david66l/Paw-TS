import type { JsonValue } from "@paw/protocol";

import { hashCanonicalJsonV1 } from "./canonical.js";
import {
  type PawNextMemoryScopeV1,
  memoryScopeFingerprintV1,
} from "./profile.js";

export const PAW_MEMORY_ASPECT_GRAPH_VERSION_V1 =
  "paw.memory-aspect-graph.v1" as const;
export const PAW_MEMORY_ASPECT_CLAIM_VERSION_V1 =
  "paw.memory-aspect-claim.v1" as const;
export const PAW_MEMORY_ASPECT_VERSION_V1 = "paw.memory-aspect.v1" as const;
export const PAW_MEMORY_ASPECT_MEMBERSHIP_VERSION_V1 =
  "paw.memory-aspect-membership.v1" as const;
export const PAW_MEMORY_EVIDENCE_EDGE_VERSION_V1 =
  "paw.memory-evidence-edge.v1" as const;
export const PAW_MEMORY_ASPECT_TRANSITION_VERSION_V1 =
  "paw.memory-aspect-transition.v1" as const;
export const PAW_MEMORY_ASPECT_LIFECYCLE_EVENT_VERSION_V1 =
  "paw.memory-aspect-lifecycle-event.v1" as const;
export const PAW_MEMORY_ASPECT_STATE_PROJECTION_VERSION_V1 =
  "paw.memory-aspect-state-projection.v1" as const;
export const DEFAULT_MEMORY_ASPECT_CONTEXT_KEY_V1 = "global" as const;

export type MemoryAspectClaimKindV1 = "assertion" | "episode";

export type MemoryAspectClaimRoleV1 =
  | "state"
  | "fact"
  | "event"
  | "cause"
  | "condition";

export type MemoryEvidenceEdgeTypeV1 =
  | "same_state"
  | "supersedes"
  | "contradicts"
  | "supports"
  | "qualifies"
  | "caused_by"
  | "derived_from";

export type MemoryAspectTransitionKindV1 = "merge" | "split";
export type MemoryAspectStatusV1 = "active" | "redirected" | "split";
export type MemoryAspectLifecycleTargetKindV1 = "membership" | "edge";
export type MemoryAspectLifecycleActionV1 = "retract";

export interface MemoryAspectStateScopeV1 {
  readonly subjectKey: string;
  readonly aspectId: string;
  readonly contextKey: string;
}

/**
 * A content-free reference to an immutable L1 claim or event. Exact text stays
 * in L1/L0; this graph stores only identity, provenance, role, and two times.
 */
export interface MemoryAspectClaimV1 {
  readonly schemaVersion: typeof PAW_MEMORY_ASPECT_CLAIM_VERSION_V1;
  readonly id: string;
  readonly kind: MemoryAspectClaimKindV1;
  readonly validFrom: string;
  readonly validTo?: string;
  readonly ingestedAt: string;
  readonly evidenceRefs: readonly string[];
}

/** The ID is derived from an opaque seed, never from an LLM-authored label. */
export interface MemoryAspectV1 {
  readonly schemaVersion: typeof PAW_MEMORY_ASPECT_VERSION_V1;
  readonly id: string;
  readonly scopeFingerprint: string;
  readonly displayName: string;
  readonly aliases: readonly string[];
  readonly status: MemoryAspectStatusV1;
  readonly redirectToAspectIds: readonly string[];
}

/** Claims may have zero, one, or many aspect memberships. */
export interface MemoryClaimAspectMembershipV1 {
  readonly schemaVersion: typeof PAW_MEMORY_ASPECT_MEMBERSHIP_VERSION_V1;
  readonly id: string;
  readonly claimId: string;
  readonly aspectId: string;
  readonly subjectKey: string;
  readonly contextKey: string;
  readonly stateKeyId: string;
  /** Role is contextual: one claim may play different roles in two aspects. */
  readonly role: MemoryAspectClaimRoleV1;
  readonly confidence: number;
  readonly createdAt: string;
}

/** Typed adjacency is authoritative and is never flattened into buckets. */
export interface MemoryEvidenceEdgeV1 {
  readonly schemaVersion: typeof PAW_MEMORY_EVIDENCE_EDGE_VERSION_V1;
  readonly id: string;
  readonly fromClaimId: string;
  readonly toClaimId: string;
  readonly edgeType: MemoryEvidenceEdgeTypeV1;
  /** Required for state-changing relations; absent for cross-context evidence. */
  readonly stateScope?: MemoryAspectStateScopeV1;
  readonly stateKeyId?: string;
  readonly confidence: number;
  readonly evidenceRefs: readonly string[];
  /** Valid-time boundary; distinct from when the relation was recorded. */
  readonly effectiveFrom: string;
  readonly createdAt: string;
}

/** Append-only lifecycle history. Retraction never mutates the target record. */
export interface MemoryAspectLifecycleEventV1 {
  readonly schemaVersion: typeof PAW_MEMORY_ASPECT_LIFECYCLE_EVENT_VERSION_V1;
  readonly id: string;
  readonly targetKind: MemoryAspectLifecycleTargetKindV1;
  readonly targetId: string;
  readonly action: MemoryAspectLifecycleActionV1;
  readonly reasonCode: string;
  readonly evidenceRefs: readonly string[];
  readonly occurredAt: string;
}

/** Merge/split is append-only history; source aspects become redirects. */
export interface MemoryAspectTransitionV1 {
  readonly schemaVersion: typeof PAW_MEMORY_ASPECT_TRANSITION_VERSION_V1;
  readonly id: string;
  readonly kind: MemoryAspectTransitionKindV1;
  readonly fromAspectId: string;
  readonly toAspectIds: readonly string[];
  readonly reasonCode: string;
  readonly createdAt: string;
}

export interface MemoryAspectGraphSnapshotV1 {
  readonly schemaVersion: typeof PAW_MEMORY_ASPECT_GRAPH_VERSION_V1;
  readonly scopeFingerprint: string;
  readonly revision: string;
  readonly claims: readonly MemoryAspectClaimV1[];
  readonly aspects: readonly MemoryAspectV1[];
  readonly memberships: readonly MemoryClaimAspectMembershipV1[];
  readonly edges: readonly MemoryEvidenceEdgeV1[];
  readonly transitions: readonly MemoryAspectTransitionV1[];
  readonly lifecycleEvents: readonly MemoryAspectLifecycleEventV1[];
}

export interface MemoryAspectStateProjectionV1 {
  readonly schemaVersion: typeof PAW_MEMORY_ASPECT_STATE_PROJECTION_VERSION_V1;
  readonly requestedAspectId: string;
  readonly resolvedAspectIds: readonly string[];
  readonly subjectKey?: string;
  readonly contextKey?: string;
  readonly projectionRevision: string;
  readonly currentClaimIds: readonly string[];
  readonly historicalClaimIds: readonly string[];
  readonly futureClaimIds: readonly string[];
  readonly eventClaimIds: readonly string[];
  readonly causeClaimIds: readonly string[];
  readonly conditionClaimIds: readonly string[];
  /** Evidence left on a split source until it is explicitly reassigned. */
  readonly unresolvedClaimIds: readonly string[];
  /** Full typed adjacency for selected claims, including external neighbors. */
  readonly edges: readonly MemoryEvidenceEdgeV1[];
  readonly neighborClaimIds: readonly string[];
}

export interface MemoryAspectGraphMetricsV1 {
  readonly claimCount: number;
  readonly aspectCount: number;
  readonly activeAspectCount: number;
  readonly membershipCount: number;
  readonly activeMembershipCount: number;
  readonly edgeCount: number;
  readonly lifecycleEventCount: number;
  readonly multiAspectClaimCount: number;
  readonly averageAspectsPerClaim: number;
  readonly largestAspectClaimCount: number;
  readonly largestAspectClaimShare: number;
}

/** Telemetry intentionally contains counts and error names only. */
export interface MemoryAspectGraphEventV1 {
  readonly schemaVersion: "paw.memory-aspect-graph-event.v1";
  readonly type: "applied" | "projected" | "failed";
  readonly scopeFingerprint: string;
  readonly revision?: string;
  readonly claimCount: number;
  readonly aspectCount: number;
  readonly membershipCount: number;
  readonly edgeCount: number;
  readonly transitionCount: number;
  readonly lifecycleEventCount: number;
  readonly reasonCode?: string;
  readonly durationMs: number;
}

export function deriveMemoryAspectIdV1(
  input: Readonly<{ scope: PawNextMemoryScopeV1; identitySeed: string }>,
): string {
  return hashCanonicalJsonV1({
    schemaVersion: PAW_MEMORY_ASPECT_VERSION_V1,
    scopeFingerprint: memoryScopeFingerprintV1(input.scope),
    identitySeed: identity(
      input.identitySeed,
      "MemoryAspectIdentitySeedInvalid",
    ),
  });
}

export function createMemoryAspectV1(
  input: Readonly<{
    scope: PawNextMemoryScopeV1;
    identitySeed: string;
    displayName: string;
    aliases?: readonly string[];
  }>,
): MemoryAspectV1 {
  const displayName = text(
    input.displayName,
    "MemoryAspectDisplayNameInvalid",
    160,
  );
  return Object.freeze({
    schemaVersion: PAW_MEMORY_ASPECT_VERSION_V1,
    id: deriveMemoryAspectIdV1(input),
    scopeFingerprint: memoryScopeFingerprintV1(input.scope),
    displayName,
    aliases: stableLabels(input.aliases ?? [], displayName),
    status: "active",
    redirectToAspectIds: Object.freeze([]),
  });
}

export function createMemoryAspectClaimV1(
  input: Readonly<{
    id: string;
    kind: MemoryAspectClaimKindV1;
    validFrom: string;
    validTo?: string;
    ingestedAt: string;
    evidenceRefs: readonly string[];
  }>,
): MemoryAspectClaimV1 {
  const validFrom = isoTime(
    input.validFrom,
    "MemoryAspectClaimValidFromInvalid",
  );
  const validTo =
    input.validTo === undefined
      ? undefined
      : isoTime(input.validTo, "MemoryAspectClaimValidToInvalid");
  if (validTo !== undefined && Date.parse(validTo) < Date.parse(validFrom)) {
    throw namedError("MemoryAspectClaimTimeRangeInvalid");
  }
  assertClaimKind(input.kind);
  const evidenceRefs = stableIdentities(
    input.evidenceRefs,
    "MemoryAspectClaimEvidenceInvalid",
  );
  if (evidenceRefs.length === 0) {
    throw namedError("MemoryAspectClaimEvidenceMissing");
  }
  return Object.freeze({
    schemaVersion: PAW_MEMORY_ASPECT_CLAIM_VERSION_V1,
    id: identity(input.id, "MemoryAspectClaimIdentityInvalid"),
    kind: input.kind,
    validFrom,
    ...(validTo === undefined ? {} : { validTo }),
    ingestedAt: isoTime(input.ingestedAt, "MemoryAspectClaimIngestedAtInvalid"),
    evidenceRefs,
  });
}

export function createMemoryClaimAspectMembershipV1(
  input: Readonly<{
    scope: PawNextMemoryScopeV1;
    claimId: string;
    aspectId: string;
    subjectKey?: string;
    contextKey?: string;
    role: MemoryAspectClaimRoleV1;
    confidence: number;
    createdAt: string;
  }>,
): MemoryClaimAspectMembershipV1 {
  const claimId = identity(input.claimId, "MemoryAspectMembershipClaimInvalid");
  const aspectId = identity(
    input.aspectId,
    "MemoryAspectMembershipAspectInvalid",
  );
  const subjectKey = stateDimension(
    input.subjectKey ?? defaultMemoryAspectSubjectKeyV1(input.scope),
    "MemoryAspectMembershipSubjectInvalid",
  );
  const contextKey = stateDimension(
    input.contextKey ?? DEFAULT_MEMORY_ASPECT_CONTEXT_KEY_V1,
    "MemoryAspectMembershipContextInvalid",
  );
  const stateKeyId = deriveMemoryAspectStateKeyIdV1({
    scope: input.scope,
    subjectKey,
    aspectId,
    contextKey,
  });
  assertClaimRole(input.role);
  const createdAt = isoTime(
    input.createdAt,
    "MemoryAspectMembershipCreatedAtInvalid",
  );
  return Object.freeze({
    schemaVersion: PAW_MEMORY_ASPECT_MEMBERSHIP_VERSION_V1,
    id: hashCanonicalJsonV1({
      schemaVersion: PAW_MEMORY_ASPECT_MEMBERSHIP_VERSION_V1,
      scopeFingerprint: memoryScopeFingerprintV1(input.scope),
      claimId,
      aspectId,
      subjectKey,
      contextKey,
      role: input.role,
    }),
    claimId,
    aspectId,
    subjectKey,
    contextKey,
    stateKeyId,
    role: input.role,
    confidence: confidence(
      input.confidence,
      "MemoryAspectMembershipConfidenceInvalid",
    ),
    createdAt,
  });
}

export function defaultMemoryAspectSubjectKeyV1(
  scope: PawNextMemoryScopeV1,
): string {
  return `user:${identity(scope.userId, "MemoryAspectScopeUserInvalid")}`;
}

export function deriveMemoryAspectStateKeyIdV1(
  input: Readonly<{
    scope: PawNextMemoryScopeV1;
    subjectKey: string;
    aspectId: string;
    contextKey: string;
  }>,
): string {
  return hashCanonicalJsonV1({
    schemaVersion: "paw.memory-aspect-state-key.v1",
    scopeFingerprint: memoryScopeFingerprintV1(input.scope),
    subjectKey: stateDimension(
      input.subjectKey,
      "MemoryAspectStateSubjectInvalid",
    ),
    aspectId: identity(input.aspectId, "MemoryAspectStateAspectInvalid"),
    contextKey: stateDimension(
      input.contextKey,
      "MemoryAspectStateContextInvalid",
    ),
  });
}

export function createMemoryEvidenceEdgeV1(
  input: Readonly<{
    scope: PawNextMemoryScopeV1;
    fromClaimId: string;
    toClaimId: string;
    edgeType: MemoryEvidenceEdgeTypeV1;
    stateScope?: Readonly<{
      subjectKey?: string;
      aspectId: string;
      contextKey?: string;
    }>;
    confidence: number;
    evidenceRefs?: readonly string[];
    effectiveFrom?: string;
    createdAt: string;
  }>,
): MemoryEvidenceEdgeV1 {
  let fromClaimId = identity(
    input.fromClaimId,
    "MemoryEvidenceEdgeSourceInvalid",
  );
  let toClaimId = identity(input.toClaimId, "MemoryEvidenceEdgeTargetInvalid");
  if (fromClaimId === toClaimId)
    throw namedError("MemoryEvidenceEdgeSelfReference");
  assertEdgeType(input.edgeType);
  if (
    input.edgeType === "same_state" &&
    fromClaimId.localeCompare(toClaimId) > 0
  ) {
    [fromClaimId, toClaimId] = [toClaimId, fromClaimId];
  }
  if (isStateScopedEdgeType(input.edgeType) && input.stateScope === undefined) {
    throw namedError("MemoryEvidenceEdgeStateScopeMissing");
  }
  const stateScope =
    input.stateScope === undefined
      ? undefined
      : freezeStateScope({
          subjectKey:
            input.stateScope.subjectKey ??
            defaultMemoryAspectSubjectKeyV1(input.scope),
          aspectId: input.stateScope.aspectId,
          contextKey:
            input.stateScope.contextKey ?? DEFAULT_MEMORY_ASPECT_CONTEXT_KEY_V1,
        });
  const stateKeyId =
    stateScope === undefined
      ? undefined
      : deriveMemoryAspectStateKeyIdV1({ scope: input.scope, ...stateScope });
  const createdAt = isoTime(
    input.createdAt,
    "MemoryEvidenceEdgeCreatedAtInvalid",
  );
  const effectiveFrom = isoTime(
    input.effectiveFrom ?? createdAt,
    "MemoryEvidenceEdgeEffectiveFromInvalid",
  );
  return Object.freeze({
    schemaVersion: PAW_MEMORY_EVIDENCE_EDGE_VERSION_V1,
    id: hashCanonicalJsonV1({
      schemaVersion: PAW_MEMORY_EVIDENCE_EDGE_VERSION_V1,
      scopeFingerprint: memoryScopeFingerprintV1(input.scope),
      fromClaimId,
      toClaimId,
      edgeType: input.edgeType,
      stateKeyId: stateKeyId ?? null,
      effectiveFrom,
    }),
    fromClaimId,
    toClaimId,
    edgeType: input.edgeType,
    ...(stateScope === undefined ? {} : { stateScope, stateKeyId }),
    confidence: confidence(
      input.confidence,
      "MemoryEvidenceEdgeConfidenceInvalid",
    ),
    evidenceRefs: stableIdentities(
      input.evidenceRefs ?? [],
      "MemoryEvidenceEdgeEvidenceInvalid",
    ),
    effectiveFrom,
    createdAt,
  });
}

export function createMemoryAspectLifecycleEventV1(
  input: Readonly<{
    scope: PawNextMemoryScopeV1;
    targetKind: MemoryAspectLifecycleTargetKindV1;
    targetId: string;
    action?: MemoryAspectLifecycleActionV1;
    reasonCode: string;
    evidenceRefs?: readonly string[];
    occurredAt: string;
  }>,
): MemoryAspectLifecycleEventV1 {
  assertLifecycleTargetKind(input.targetKind);
  const action = input.action ?? "retract";
  if (action !== "retract")
    throw namedError("MemoryAspectLifecycleActionInvalid");
  const targetId = identity(
    input.targetId,
    "MemoryAspectLifecycleTargetInvalid",
  );
  return Object.freeze({
    schemaVersion: PAW_MEMORY_ASPECT_LIFECYCLE_EVENT_VERSION_V1,
    id: hashCanonicalJsonV1({
      schemaVersion: PAW_MEMORY_ASPECT_LIFECYCLE_EVENT_VERSION_V1,
      scopeFingerprint: memoryScopeFingerprintV1(input.scope),
      targetKind: input.targetKind,
      targetId,
      action,
    }),
    targetKind: input.targetKind,
    targetId,
    action,
    reasonCode: text(
      input.reasonCode,
      "MemoryAspectLifecycleReasonInvalid",
      120,
    ),
    evidenceRefs: Object.freeze(
      stableIdentities(
        input.evidenceRefs ?? [],
        "MemoryAspectLifecycleEvidenceInvalid",
      ),
    ),
    occurredAt: isoTime(
      input.occurredAt,
      "MemoryAspectLifecycleOccurredAtInvalid",
    ),
  });
}

export function createMemoryAspectTransitionV1(
  input: Readonly<{
    scope: PawNextMemoryScopeV1;
    kind: MemoryAspectTransitionKindV1;
    fromAspectId: string;
    toAspectIds: readonly string[];
    reasonCode: string;
    createdAt: string;
  }>,
): MemoryAspectTransitionV1 {
  const fromAspectId = identity(
    input.fromAspectId,
    "MemoryAspectTransitionSourceInvalid",
  );
  const toAspectIds = stableIdentities(
    input.toAspectIds,
    "MemoryAspectTransitionTargetInvalid",
  ).filter((id) => id !== fromAspectId);
  if (
    (input.kind === "merge" && toAspectIds.length !== 1) ||
    (input.kind === "split" && toAspectIds.length < 2)
  ) {
    throw namedError("MemoryAspectTransitionCardinalityInvalid");
  }
  if (input.kind !== "merge" && input.kind !== "split") {
    throw namedError("MemoryAspectTransitionKindInvalid");
  }
  const reasonCode = text(
    input.reasonCode,
    "MemoryAspectTransitionReasonInvalid",
    120,
  );
  return Object.freeze({
    schemaVersion: PAW_MEMORY_ASPECT_TRANSITION_VERSION_V1,
    id: hashCanonicalJsonV1({
      schemaVersion: PAW_MEMORY_ASPECT_TRANSITION_VERSION_V1,
      scopeFingerprint: memoryScopeFingerprintV1(input.scope),
      kind: input.kind,
      fromAspectId,
      toAspectIds,
    }),
    kind: input.kind,
    fromAspectId,
    toAspectIds: Object.freeze(toAspectIds),
    reasonCode,
    createdAt: isoTime(
      input.createdAt,
      "MemoryAspectTransitionCreatedAtInvalid",
    ),
  });
}

export function createEmptyMemoryAspectGraphSnapshotV1(
  scope: PawNextMemoryScopeV1,
): MemoryAspectGraphSnapshotV1 {
  return freezeSnapshot({
    scopeFingerprint: memoryScopeFingerprintV1(scope),
    claims: [],
    aspects: [],
    memberships: [],
    edges: [],
    transitions: [],
    lifecycleEvents: [],
  });
}

/**
 * Applies an immutable shadow mutation. All references, redirects, temporal
 * ordering and supersedes DAG constraints are checked before publication.
 */
export function applyMemoryAspectGraphMutationV1(
  input: Readonly<{
    snapshot: MemoryAspectGraphSnapshotV1;
    claims?: readonly MemoryAspectClaimV1[];
    aspects?: readonly MemoryAspectV1[];
    memberships?: readonly MemoryClaimAspectMembershipV1[];
    edges?: readonly MemoryEvidenceEdgeV1[];
    transitions?: readonly MemoryAspectTransitionV1[];
    lifecycleEvents?: readonly MemoryAspectLifecycleEventV1[];
    /** Optional compare-and-swap guard for storage adapters. */
    expectedRevision?: string;
  }>,
  options: Readonly<{
    onEvent?: (event: MemoryAspectGraphEventV1) => void;
    now?: () => number;
  }> = {},
): MemoryAspectGraphSnapshotV1 {
  const startedAt = (options.now ?? Date.now)();
  try {
    const existing = validateSnapshot(input.snapshot);
    validateGraph(existing);
    if (
      input.expectedRevision !== undefined &&
      input.expectedRevision !== existing.revision
    ) {
      throw namedError("MemoryAspectGraphRevisionConflict");
    }
    const claims = appendImmutableById(
      existing.claims,
      input.claims ?? [],
      "MemoryAspectClaimImmutableConflict",
    );
    let aspects = upsertAspects(
      existing.aspects,
      input.aspects ?? [],
      existing.scopeFingerprint,
    );
    const memberships = appendImmutableById(
      existing.memberships,
      input.memberships ?? [],
      "MemoryAspectMembershipImmutableConflict",
    );
    const edges = appendImmutableById(
      existing.edges,
      input.edges ?? [],
      "MemoryEvidenceEdgeImmutableConflict",
    );
    const transitions = appendImmutableById(
      existing.transitions,
      input.transitions ?? [],
      "MemoryAspectTransitionImmutableConflict",
    );
    const lifecycleEvents = appendImmutableById(
      existing.lifecycleEvents,
      input.lifecycleEvents ?? [],
      "MemoryAspectLifecycleImmutableConflict",
    );

    aspects = applyAspectTransitions(aspects, transitions);
    const snapshot = freezeSnapshot({
      scopeFingerprint: existing.scopeFingerprint,
      claims,
      aspects,
      memberships,
      edges,
      transitions,
      lifecycleEvents,
    });
    validateGraph(snapshot);
    emit(
      options.onEvent,
      eventFor(snapshot, "applied", startedAt, options.now),
    );
    return snapshot;
  } catch (error) {
    const snapshot = input.snapshot;
    emit(options.onEvent, {
      schemaVersion: "paw.memory-aspect-graph-event.v1",
      type: "failed",
      scopeFingerprint: snapshot.scopeFingerprint,
      claimCount: snapshot.claims.length,
      aspectCount: snapshot.aspects.length,
      membershipCount: snapshot.memberships.length,
      edgeCount: snapshot.edges.length,
      transitionCount: snapshot.transitions.length,
      lifecycleEventCount: snapshot.lifecycleEvents.length,
      reasonCode: errorName(error),
      durationMs: Math.max(0, (options.now ?? Date.now)() - startedAt),
    });
    throw error;
  }
}

export function resolveMemoryAspectIdsV1(
  snapshot: MemoryAspectGraphSnapshotV1,
  aspectId: string,
): readonly string[] {
  const aspects = new Map(
    snapshot.aspects.map((aspect) => [aspect.id, aspect]),
  );
  if (!aspects.has(aspectId)) throw namedError("MemoryAspectMissing");
  const resolved = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw namedError("MemoryAspectRedirectCycleDetected");
    const aspect = aspects.get(id);
    if (!aspect) throw namedError("MemoryAspectRedirectTargetMissing");
    if (aspect.status === "active") {
      resolved.add(id);
      return;
    }
    visiting.add(id);
    for (const target of aspect.redirectToAspectIds) visit(target);
    visiting.delete(id);
  };
  visit(aspectId);
  return Object.freeze([...resolved].sort());
}

export function projectMemoryAspectStateV1(
  input: Readonly<{
    snapshot: MemoryAspectGraphSnapshotV1;
    aspectId: string;
    asOf: string;
    subjectKey?: string;
    contextKey?: string;
  }>,
  options: Readonly<{
    onEvent?: (event: MemoryAspectGraphEventV1) => void;
    now?: () => number;
  }> = {},
): MemoryAspectStateProjectionV1 {
  const startedAt = (options.now ?? Date.now)();
  try {
    const snapshot = validateSnapshot(input.snapshot);
    validateGraph(snapshot);
    const asOf = isoTime(input.asOf, "MemoryAspectProjectionAsOfInvalid");
    const resolvedAspectIds = resolveMemoryAspectIdsV1(
      snapshot,
      input.aspectId,
    );
    const requestedAspect = requiredAspect(snapshot, input.aspectId);
    const membershipAspectIds = collectMembershipAspectIds(
      snapshot,
      input.aspectId,
      resolvedAspectIds,
    );
    const retracted = retractedTargetIds(snapshot.lifecycleEvents, asOf);
    const candidateMemberships = snapshot.memberships.filter(
      (membership) =>
        !retracted.memberships.has(membership.id) &&
        membershipAspectIds.has(membership.aspectId),
    );
    const dimensions = selectProjectionStateDimensions(
      candidateMemberships,
      input.subjectKey,
      input.contextKey,
    );
    const memberships = candidateMemberships.filter(
      (membership) =>
        dimensions === undefined ||
        (membership.subjectKey === dimensions.subjectKey &&
          membership.contextKey === dimensions.contextKey),
    );
    const claimIds = new Set(
      memberships.map((membership) => membership.claimId),
    );
    const claims = new Map(snapshot.claims.map((claim) => [claim.id, claim]));
    const activeEdges = snapshot.edges.filter(
      (edge) =>
        !retracted.edges.has(edge.id) &&
        Date.parse(edge.createdAt) <= Date.parse(asOf) &&
        Date.parse(edge.effectiveFrom) <= Date.parse(asOf) &&
        (edge.stateScope === undefined ||
          (dimensions !== undefined &&
            edge.stateScope.subjectKey === dimensions.subjectKey &&
            edge.stateScope.contextKey === dimensions.contextKey &&
            membershipAspectIds.has(edge.stateScope.aspectId))),
    );
    const superseded = new Set(
      activeEdges
        .filter(
          (edge) =>
            edge.edgeType === "supersedes" && edge.stateScope !== undefined,
        )
        .map((edge) => edge.toClaimId),
    );
    const currentClaimIds: string[] = [];
    const historicalClaimIds: string[] = [];
    const futureClaimIds: string[] = [];
    const eventClaimIds: string[] = [];
    const causeClaimIds: string[] = [];
    const conditionClaimIds: string[] = [];
    const unresolvedClaimIds: string[] = [];
    const rolesByClaim = new Map<string, Set<MemoryAspectClaimRoleV1>>();
    for (const membership of memberships) {
      const roles = rolesByClaim.get(membership.claimId) ?? new Set();
      roles.add(membership.role);
      rolesByClaim.set(membership.claimId, roles);
    }
    for (const claimId of [...claimIds].sort((left, right) =>
      compareClaims(required(claims, left), required(claims, right)),
    )) {
      const claim = required(claims, claimId);
      const roles = rolesByClaim.get(claimId) ?? new Set();
      if (requestedAspect.status === "split") {
        unresolvedClaimIds.push(claimId);
        continue;
      }
      if (roles.has("event")) eventClaimIds.push(claimId);
      if (roles.has("cause")) causeClaimIds.push(claimId);
      if (roles.has("condition")) conditionClaimIds.push(claimId);
      if (!roles.has("state") && !roles.has("fact")) continue;
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
    const edges = Object.freeze(
      activeEdges
        .filter(
          (edge) =>
            claimIds.has(edge.fromClaimId) || claimIds.has(edge.toClaimId),
        )
        .sort(compareEdges),
    );
    const neighborClaimIds = Object.freeze(
      [...new Set(edges.flatMap((edge) => [edge.fromClaimId, edge.toClaimId]))]
        .filter((id) => !claimIds.has(id))
        .sort(),
    );
    const projection = Object.freeze({
      schemaVersion: PAW_MEMORY_ASPECT_STATE_PROJECTION_VERSION_V1,
      requestedAspectId: input.aspectId,
      resolvedAspectIds,
      ...(dimensions === undefined ? {} : dimensions),
      projectionRevision: hashCanonicalJsonV1({
        version: PAW_MEMORY_ASPECT_STATE_PROJECTION_VERSION_V1,
        snapshotRevision: snapshot.revision,
        aspectId: input.aspectId,
        asOf,
        subjectKey: dimensions?.subjectKey ?? null,
        contextKey: dimensions?.contextKey ?? null,
      }),
      currentClaimIds: Object.freeze(currentClaimIds),
      historicalClaimIds: Object.freeze(historicalClaimIds),
      futureClaimIds: Object.freeze(futureClaimIds),
      eventClaimIds: Object.freeze(eventClaimIds),
      causeClaimIds: Object.freeze(causeClaimIds),
      conditionClaimIds: Object.freeze(conditionClaimIds),
      unresolvedClaimIds: Object.freeze(unresolvedClaimIds),
      edges,
      neighborClaimIds,
    }) satisfies MemoryAspectStateProjectionV1;
    emit(
      options.onEvent,
      eventFor(snapshot, "projected", startedAt, options.now),
    );
    return projection;
  } catch (error) {
    emit(options.onEvent, {
      schemaVersion: "paw.memory-aspect-graph-event.v1",
      type: "failed",
      scopeFingerprint: input.snapshot.scopeFingerprint,
      claimCount: input.snapshot.claims.length,
      aspectCount: input.snapshot.aspects.length,
      membershipCount: input.snapshot.memberships.length,
      edgeCount: input.snapshot.edges.length,
      transitionCount: input.snapshot.transitions.length,
      lifecycleEventCount: input.snapshot.lifecycleEvents.length,
      reasonCode: errorName(error),
      durationMs: Math.max(0, (options.now ?? Date.now)() - startedAt),
    });
    throw error;
  }
}

export function measureMemoryAspectGraphV1(
  snapshot: MemoryAspectGraphSnapshotV1,
): MemoryAspectGraphMetricsV1 {
  validateGraph(validateSnapshot(snapshot));
  const retracted = retractedTargetIds(snapshot.lifecycleEvents);
  const activeMemberships = snapshot.memberships.filter(
    (membership) => !retracted.memberships.has(membership.id),
  );
  const aspectsByClaim = groupUnique(
    activeMemberships,
    (item) => item.claimId,
    (item) => item.aspectId,
  );
  const claimsByAspect = groupUnique(
    activeMemberships,
    (item) => item.aspectId,
    (item) => item.claimId,
  );
  const uniqueMembershipCount = [...aspectsByClaim.values()].reduce(
    (total, values) => total + values.size,
    0,
  );
  const largestAspectClaimCount = Math.max(
    0,
    ...[...claimsByAspect.values()].map((values) => values.size),
  );
  return Object.freeze({
    claimCount: snapshot.claims.length,
    aspectCount: snapshot.aspects.length,
    activeAspectCount: snapshot.aspects.filter(
      (aspect) => aspect.status === "active",
    ).length,
    membershipCount: snapshot.memberships.length,
    activeMembershipCount: activeMemberships.length,
    edgeCount: snapshot.edges.length,
    lifecycleEventCount: snapshot.lifecycleEvents.length,
    multiAspectClaimCount: [...aspectsByClaim.values()].filter(
      (values) => values.size > 1,
    ).length,
    averageAspectsPerClaim:
      snapshot.claims.length === 0
        ? 0
        : uniqueMembershipCount / snapshot.claims.length,
    largestAspectClaimCount,
    largestAspectClaimShare:
      snapshot.claims.length === 0
        ? 0
        : largestAspectClaimCount / snapshot.claims.length,
  });
}

function validateGraph(snapshot: MemoryAspectGraphSnapshotV1): void {
  const claims = uniqueMap(snapshot.claims, "MemoryAspectClaimDuplicate");
  const aspects = uniqueMap(snapshot.aspects, "MemoryAspectDuplicate");
  uniqueMap(snapshot.memberships, "MemoryAspectMembershipDuplicate");
  uniqueMap(snapshot.edges, "MemoryEvidenceEdgeDuplicate");
  uniqueMap(snapshot.transitions, "MemoryAspectTransitionDuplicate");
  uniqueMap(snapshot.lifecycleEvents, "MemoryAspectLifecycleDuplicate");

  for (const claim of claims.values()) {
    if (
      claim.schemaVersion !== PAW_MEMORY_ASPECT_CLAIM_VERSION_V1 ||
      identity(claim.id, "MemoryAspectClaimIdentityInvalid") !== claim.id
    ) {
      throw namedError("MemoryAspectClaimInvalid");
    }
    assertClaimKind(claim.kind);
    const validFrom = isoTime(
      claim.validFrom,
      "MemoryAspectClaimValidFromInvalid",
    );
    const ingestedAt = isoTime(
      claim.ingestedAt,
      "MemoryAspectClaimIngestedAtInvalid",
    );
    if (validFrom !== claim.validFrom || ingestedAt !== claim.ingestedAt) {
      throw namedError("MemoryAspectClaimTimeNotCanonical");
    }
    if (claim.validTo !== undefined) {
      const validTo = isoTime(claim.validTo, "MemoryAspectClaimValidToInvalid");
      if (
        validTo !== claim.validTo ||
        Date.parse(validTo) < Date.parse(validFrom)
      ) {
        throw namedError("MemoryAspectClaimTimeRangeInvalid");
      }
    }
    assertStableIdentityList(
      claim.evidenceRefs,
      "MemoryAspectClaimEvidenceInvalid",
      true,
    );
  }

  for (const aspect of aspects.values()) {
    if (
      aspect.schemaVersion !== PAW_MEMORY_ASPECT_VERSION_V1 ||
      identity(aspect.id, "MemoryAspectIdentityInvalid") !== aspect.id ||
      aspect.scopeFingerprint !== snapshot.scopeFingerprint
    ) {
      throw namedError("MemoryAspectScopeMismatch");
    }
    const displayName = text(
      aspect.displayName,
      "MemoryAspectDisplayNameInvalid",
      160,
    );
    if (
      displayName !== aspect.displayName ||
      !sameStrings(
        aspect.aliases,
        stableLabels(aspect.aliases, aspect.displayName),
      )
    ) {
      throw namedError("MemoryAspectLabelsNotCanonical");
    }
    if (
      aspect.status !== "active" &&
      aspect.status !== "redirected" &&
      aspect.status !== "split"
    ) {
      throw namedError("MemoryAspectStatusInvalid");
    }
    assertStableIdentityList(
      aspect.redirectToAspectIds,
      "MemoryAspectRedirectTargetInvalid",
    );
    if (
      (aspect.status === "active" && aspect.redirectToAspectIds.length !== 0) ||
      (aspect.status === "redirected" &&
        aspect.redirectToAspectIds.length !== 1) ||
      (aspect.status === "split" && aspect.redirectToAspectIds.length < 2)
    ) {
      throw namedError("MemoryAspectRedirectStateInvalid");
    }
    for (const target of aspect.redirectToAspectIds) {
      if (!aspects.has(target))
        throw namedError("MemoryAspectRedirectTargetMissing");
    }
  }
  for (const aspect of aspects.values())
    resolveMemoryAspectIdsV1(snapshot, aspect.id);

  for (const membership of snapshot.memberships) {
    assertClaimRole(membership.role);
    if (
      membership.schemaVersion !== PAW_MEMORY_ASPECT_MEMBERSHIP_VERSION_V1 ||
      stateDimension(
        membership.subjectKey,
        "MemoryAspectMembershipSubjectInvalid",
      ) !== membership.subjectKey ||
      stateDimension(
        membership.contextKey,
        "MemoryAspectMembershipContextInvalid",
      ) !== membership.contextKey ||
      confidence(
        membership.confidence,
        "MemoryAspectMembershipConfidenceInvalid",
      ) !== membership.confidence ||
      isoTime(
        membership.createdAt,
        "MemoryAspectMembershipCreatedAtInvalid",
      ) !== membership.createdAt ||
      membership.stateKeyId !==
        deriveStateKeyIdFromFingerprint({
          scopeFingerprint: snapshot.scopeFingerprint,
          subjectKey: membership.subjectKey,
          aspectId: membership.aspectId,
          contextKey: membership.contextKey,
        }) ||
      membership.id !==
        hashCanonicalJsonV1({
          schemaVersion: PAW_MEMORY_ASPECT_MEMBERSHIP_VERSION_V1,
          scopeFingerprint: snapshot.scopeFingerprint,
          claimId: membership.claimId,
          aspectId: membership.aspectId,
          subjectKey: membership.subjectKey,
          contextKey: membership.contextKey,
          role: membership.role,
        })
    ) {
      throw namedError("MemoryAspectMembershipInvalid");
    }
    if (!claims.has(membership.claimId)) {
      throw namedError("MemoryAspectMembershipClaimMissing");
    }
    if (!aspects.has(membership.aspectId)) {
      throw namedError("MemoryAspectMembershipAspectMissing");
    }
  }

  const membershipsByStateKey = groupUnique(
    snapshot.memberships,
    (membership) => membership.stateKeyId,
    (membership) => membership.claimId,
  );
  const supersedesByStateKey = new Map<string, Map<string, Set<string>>>();
  const retractedEdgeIds = new Set(
    snapshot.lifecycleEvents
      .filter((event) => event.targetKind === "edge")
      .map((event) => event.targetId),
  );
  const activeSemanticEdgeKeys = new Set<string>();
  for (const edge of snapshot.edges) {
    assertEdgeType(edge.edgeType);
    const stateScope = edge.stateScope;
    const stateKeyId =
      stateScope === undefined
        ? undefined
        : deriveStateKeyIdFromFingerprint({
            scopeFingerprint: snapshot.scopeFingerprint,
            ...stateScope,
          });
    if (
      edge.schemaVersion !== PAW_MEMORY_EVIDENCE_EDGE_VERSION_V1 ||
      edge.fromClaimId === edge.toClaimId ||
      confidence(edge.confidence, "MemoryEvidenceEdgeConfidenceInvalid") !==
        edge.confidence ||
      isoTime(edge.createdAt, "MemoryEvidenceEdgeCreatedAtInvalid") !==
        edge.createdAt ||
      isoTime(edge.effectiveFrom, "MemoryEvidenceEdgeEffectiveFromInvalid") !==
        edge.effectiveFrom ||
      edge.id !==
        hashCanonicalJsonV1({
          schemaVersion: PAW_MEMORY_EVIDENCE_EDGE_VERSION_V1,
          scopeFingerprint: snapshot.scopeFingerprint,
          fromClaimId: edge.fromClaimId,
          toClaimId: edge.toClaimId,
          edgeType: edge.edgeType,
          stateKeyId: edge.stateKeyId ?? null,
          effectiveFrom: edge.effectiveFrom,
        })
    ) {
      throw namedError("MemoryEvidenceEdgeInvalid");
    }
    assertStableIdentityList(
      edge.evidenceRefs,
      "MemoryEvidenceEdgeEvidenceInvalid",
    );
    const from = claims.get(edge.fromClaimId);
    const to = claims.get(edge.toClaimId);
    if (!from || !to) throw namedError("MemoryEvidenceEdgeClaimMissing");
    if (!retractedEdgeIds.has(edge.id)) {
      const semanticKey = semanticEdgeKey(edge);
      if (activeSemanticEdgeKeys.has(semanticKey)) {
        throw namedError("MemoryEvidenceEdgeSemanticDuplicate");
      }
      activeSemanticEdgeKeys.add(semanticKey);
    }
    if (isStateScopedEdgeType(edge.edgeType)) {
      if (
        stateScope === undefined ||
        !sameJson(stateScope, freezeStateScope(stateScope)) ||
        edge.stateKeyId !== stateKeyId ||
        !aspects.has(stateScope.aspectId)
      ) {
        throw namedError("MemoryEvidenceEdgeStateScopeInvalid");
      }
      const stateClaims = membershipsByStateKey.get(stateKeyId as string);
      if (
        !stateClaims?.has(edge.fromClaimId) ||
        !stateClaims.has(edge.toClaimId)
      ) {
        throw namedError("MemoryEvidenceEdgeStateMembershipMissing");
      }
    } else if (
      (stateScope === undefined) !== (edge.stateKeyId === undefined) ||
      (stateScope !== undefined && edge.stateKeyId !== stateKeyId)
    ) {
      throw namedError("MemoryEvidenceEdgeStateScopeInvalid");
    }
    if (edge.edgeType !== "supersedes") continue;
    if (Date.parse(from.validFrom) < Date.parse(to.validFrom)) {
      throw namedError("MemoryEvidenceSupersedesTimeOrderInvalid");
    }
    if (Date.parse(edge.effectiveFrom) < Date.parse(from.validFrom)) {
      throw namedError("MemoryEvidenceSupersedesEffectiveTimeInvalid");
    }
    const stateGraph =
      supersedesByStateKey.get(edge.stateKeyId as string) ??
      new Map<string, Set<string>>();
    add(stateGraph, edge.fromClaimId, edge.toClaimId);
    supersedesByStateKey.set(edge.stateKeyId as string, stateGraph);
  }
  for (const [stateKeyId, supersedes] of supersedesByStateKey) {
    assertAcyclic(
      supersedes,
      membershipsByStateKey.get(stateKeyId) ?? [],
      "MemoryEvidenceSupersedesCycleDetected",
    );
  }

  const transitionBySource = new Map<string, MemoryAspectTransitionV1>();
  for (const transition of snapshot.transitions) {
    if (
      transition.schemaVersion !== PAW_MEMORY_ASPECT_TRANSITION_VERSION_V1 ||
      (transition.kind !== "merge" && transition.kind !== "split") ||
      isoTime(
        transition.createdAt,
        "MemoryAspectTransitionCreatedAtInvalid",
      ) !== transition.createdAt ||
      text(
        transition.reasonCode,
        "MemoryAspectTransitionReasonInvalid",
        120,
      ) !== transition.reasonCode ||
      transition.id !==
        hashCanonicalJsonV1({
          schemaVersion: PAW_MEMORY_ASPECT_TRANSITION_VERSION_V1,
          scopeFingerprint: snapshot.scopeFingerprint,
          kind: transition.kind,
          fromAspectId: transition.fromAspectId,
          toAspectIds: transition.toAspectIds,
        })
    ) {
      throw namedError("MemoryAspectTransitionInvalid");
    }
    assertStableIdentityList(
      transition.toAspectIds,
      "MemoryAspectTransitionTargetInvalid",
      true,
    );
    if (
      transition.toAspectIds.includes(transition.fromAspectId) ||
      (transition.kind === "merge" && transition.toAspectIds.length !== 1) ||
      (transition.kind === "split" && transition.toAspectIds.length < 2)
    ) {
      throw namedError("MemoryAspectTransitionCardinalityInvalid");
    }
    if (transitionBySource.has(transition.fromAspectId)) {
      throw namedError("MemoryAspectTransitionSourceDuplicate");
    }
    transitionBySource.set(transition.fromAspectId, transition);
    const source = aspects.get(transition.fromAspectId);
    if (!source) throw namedError("MemoryAspectTransitionSourceMissing");
    for (const target of transition.toAspectIds) {
      if (!aspects.has(target))
        throw namedError("MemoryAspectTransitionTargetMissing");
    }
    if (
      source.status !==
        (transition.kind === "merge" ? "redirected" : "split") ||
      !sameStrings(source.redirectToAspectIds, transition.toAspectIds)
    ) {
      throw namedError("MemoryAspectTransitionProjectionMismatch");
    }
  }
  for (const aspect of aspects.values()) {
    if (aspect.status !== "active" && !transitionBySource.has(aspect.id)) {
      throw namedError("MemoryAspectTransitionHistoryMissing");
    }
  }

  const memberships = new Map(
    snapshot.memberships.map((membership) => [membership.id, membership]),
  );
  const edges = new Map(snapshot.edges.map((edge) => [edge.id, edge]));
  const lifecycleTargets = new Set<string>();
  for (const event of snapshot.lifecycleEvents) {
    assertLifecycleTargetKind(event.targetKind);
    if (
      event.schemaVersion !== PAW_MEMORY_ASPECT_LIFECYCLE_EVENT_VERSION_V1 ||
      event.action !== "retract" ||
      isoTime(event.occurredAt, "MemoryAspectLifecycleOccurredAtInvalid") !==
        event.occurredAt ||
      text(event.reasonCode, "MemoryAspectLifecycleReasonInvalid", 120) !==
        event.reasonCode ||
      event.id !==
        hashCanonicalJsonV1({
          schemaVersion: PAW_MEMORY_ASPECT_LIFECYCLE_EVENT_VERSION_V1,
          scopeFingerprint: snapshot.scopeFingerprint,
          targetKind: event.targetKind,
          targetId: event.targetId,
          action: event.action,
        })
    ) {
      throw namedError("MemoryAspectLifecycleEventInvalid");
    }
    assertStableIdentityList(
      event.evidenceRefs,
      "MemoryAspectLifecycleEvidenceInvalid",
    );
    const target =
      event.targetKind === "membership"
        ? memberships.get(event.targetId)
        : edges.get(event.targetId);
    if (!target) throw namedError("MemoryAspectLifecycleTargetMissing");
    if (Date.parse(event.occurredAt) < Date.parse(target.createdAt)) {
      throw namedError("MemoryAspectLifecycleTimeOrderInvalid");
    }
    const targetKey = `${event.targetKind}\n${event.targetId}`;
    if (lifecycleTargets.has(targetKey)) {
      throw namedError("MemoryAspectLifecycleTargetAlreadyRetracted");
    }
    lifecycleTargets.add(targetKey);
  }
}

function validateSnapshot(
  snapshot: MemoryAspectGraphSnapshotV1,
): MemoryAspectGraphSnapshotV1 {
  if (
    snapshot.schemaVersion !== PAW_MEMORY_ASPECT_GRAPH_VERSION_V1 ||
    !snapshot.scopeFingerprint.trim() ||
    !snapshot.revision.trim()
  ) {
    throw namedError("MemoryAspectGraphSnapshotInvalid");
  }
  if (
    snapshot.revision !==
    deriveSnapshotRevision({
      scopeFingerprint: snapshot.scopeFingerprint,
      claims: snapshot.claims,
      aspects: snapshot.aspects,
      memberships: snapshot.memberships,
      edges: snapshot.edges,
      transitions: snapshot.transitions,
      lifecycleEvents: snapshot.lifecycleEvents,
    })
  ) {
    throw namedError("MemoryAspectGraphRevisionMismatch");
  }
  return snapshot;
}

function applyAspectTransitions(
  aspects: readonly MemoryAspectV1[],
  transitions: readonly MemoryAspectTransitionV1[],
): readonly MemoryAspectV1[] {
  const result = new Map(aspects.map((aspect) => [aspect.id, aspect]));
  for (const transition of [...transitions].sort((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    const source = result.get(transition.fromAspectId);
    if (!source) throw namedError("MemoryAspectTransitionSourceMissing");
    for (const target of transition.toAspectIds) {
      if (!result.has(target))
        throw namedError("MemoryAspectTransitionTargetMissing");
    }
    const expectedStatus = transition.kind === "merge" ? "redirected" : "split";
    if (
      source.status !== "active" &&
      (source.status !== expectedStatus ||
        !sameStrings(source.redirectToAspectIds, transition.toAspectIds))
    ) {
      throw namedError("MemoryAspectTransitionSourceAlreadyRedirected");
    }
    result.set(
      source.id,
      Object.freeze({
        ...source,
        status: expectedStatus,
        redirectToAspectIds: Object.freeze([...transition.toAspectIds]),
      }),
    );
  }
  return Object.freeze(
    [...result.values()].sort((left, right) => left.id.localeCompare(right.id)),
  );
}

function collectMembershipAspectIds(
  snapshot: MemoryAspectGraphSnapshotV1,
  requestedAspectId: string,
  resolvedAspectIds: readonly string[],
): ReadonlySet<string> {
  const requested = requiredAspect(snapshot, requestedAspectId);
  if (requested.status === "split") {
    return new Set([requestedAspectId]);
  }
  const selected = new Set<string>([requestedAspectId, ...resolvedAspectIds]);
  const resolvedTargets = new Set(resolvedAspectIds);
  for (const aspect of snapshot.aspects) {
    if (aspect.status !== "redirected") continue;
    const targets = resolveMemoryAspectIdsV1(snapshot, aspect.id);
    if (targets.length === 1 && resolvedTargets.has(targets[0] as string)) {
      selected.add(aspect.id);
    }
  }
  return selected;
}

function freezeSnapshot(
  input: Readonly<{
    scopeFingerprint: string;
    claims: readonly MemoryAspectClaimV1[];
    aspects: readonly MemoryAspectV1[];
    memberships: readonly MemoryClaimAspectMembershipV1[];
    edges: readonly MemoryEvidenceEdgeV1[];
    transitions: readonly MemoryAspectTransitionV1[];
    lifecycleEvents: readonly MemoryAspectLifecycleEventV1[];
  }>,
): MemoryAspectGraphSnapshotV1 {
  const claims = Object.freeze(
    input.claims.map(freezeClaim).sort((a, b) => a.id.localeCompare(b.id)),
  );
  const aspects = Object.freeze(
    input.aspects.map(freezeAspect).sort((a, b) => a.id.localeCompare(b.id)),
  );
  const memberships = Object.freeze(
    input.memberships
      .map((membership) => Object.freeze({ ...membership }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  );
  const edges = Object.freeze(input.edges.map(freezeEdge).sort(compareEdges));
  const transitions = Object.freeze(
    input.transitions
      .map(freezeTransition)
      .sort((a, b) => a.id.localeCompare(b.id)),
  );
  const lifecycleEvents = Object.freeze(
    input.lifecycleEvents
      .map(freezeLifecycleEvent)
      .sort((a, b) => a.id.localeCompare(b.id)),
  );
  const revision = deriveSnapshotRevision({
    scopeFingerprint: input.scopeFingerprint,
    claims,
    aspects,
    memberships,
    edges,
    transitions,
    lifecycleEvents,
  });
  return Object.freeze({
    schemaVersion: PAW_MEMORY_ASPECT_GRAPH_VERSION_V1,
    scopeFingerprint: input.scopeFingerprint,
    revision,
    claims,
    aspects,
    memberships,
    edges,
    transitions,
    lifecycleEvents,
  });
}

function deriveSnapshotRevision(
  input: Readonly<{
    scopeFingerprint: string;
    claims: readonly MemoryAspectClaimV1[];
    aspects: readonly MemoryAspectV1[];
    memberships: readonly MemoryClaimAspectMembershipV1[];
    edges: readonly MemoryEvidenceEdgeV1[];
    transitions: readonly MemoryAspectTransitionV1[];
    lifecycleEvents: readonly MemoryAspectLifecycleEventV1[];
  }>,
): string {
  return hashCanonicalJsonV1({
    version: PAW_MEMORY_ASPECT_GRAPH_VERSION_V1,
    scopeFingerprint: input.scopeFingerprint,
    claims: input.claims as unknown as JsonValue,
    aspects: input.aspects as unknown as JsonValue,
    memberships: input.memberships as unknown as JsonValue,
    edges: input.edges as unknown as JsonValue,
    transitions: input.transitions as unknown as JsonValue,
    lifecycleEvents: input.lifecycleEvents as unknown as JsonValue,
  });
}

function freezeClaim(claim: MemoryAspectClaimV1): MemoryAspectClaimV1 {
  return Object.freeze({
    ...claim,
    evidenceRefs: Object.freeze([...claim.evidenceRefs]),
  });
}

function freezeAspect(aspect: MemoryAspectV1): MemoryAspectV1 {
  return Object.freeze({
    ...aspect,
    aliases: Object.freeze([...aspect.aliases]),
    redirectToAspectIds: Object.freeze([...aspect.redirectToAspectIds]),
  });
}

function freezeEdge(edge: MemoryEvidenceEdgeV1): MemoryEvidenceEdgeV1 {
  return Object.freeze({
    ...edge,
    ...(edge.stateScope === undefined
      ? {}
      : { stateScope: freezeStateScope(edge.stateScope) }),
    evidenceRefs: Object.freeze([...edge.evidenceRefs]),
  });
}

function freezeLifecycleEvent(
  event: MemoryAspectLifecycleEventV1,
): MemoryAspectLifecycleEventV1 {
  return Object.freeze({
    ...event,
    evidenceRefs: Object.freeze([...event.evidenceRefs]),
  });
}

function freezeTransition(
  transition: MemoryAspectTransitionV1,
): MemoryAspectTransitionV1 {
  return Object.freeze({
    ...transition,
    toAspectIds: Object.freeze([...transition.toAspectIds]),
  });
}

function upsertAspects(
  existing: readonly MemoryAspectV1[],
  incoming: readonly MemoryAspectV1[],
  scopeFingerprint: string,
): readonly MemoryAspectV1[] {
  const result = new Map(existing.map((item) => [item.id, item]));
  uniqueMap(incoming, "MemoryAspectIncomingDuplicate");
  for (const aspect of incoming) {
    if (aspect.scopeFingerprint !== scopeFingerprint) {
      throw namedError("MemoryAspectScopeMismatch");
    }
    const previous = result.get(aspect.id);
    if (previous && previous.status !== "active") {
      throw namedError("MemoryAspectRedirectMutationInvalid");
    }
    if (aspect.status !== "active" || aspect.redirectToAspectIds.length !== 0) {
      throw namedError("MemoryAspectUpsertStateInvalid");
    }
    result.set(aspect.id, aspect);
  }
  return Object.freeze(
    [...result.values()].sort((a, b) => a.id.localeCompare(b.id)),
  );
}

function appendImmutableById<T extends { readonly id: string }>(
  existing: readonly T[],
  incoming: readonly T[],
  conflictName: string,
): readonly T[] {
  const result = new Map(existing.map((item) => [item.id, item]));
  uniqueMap(incoming, conflictName);
  for (const item of incoming) {
    const previous = result.get(item.id);
    if (previous && !sameJson(previous, item)) throw namedError(conflictName);
    result.set(item.id, item);
  }
  return Object.freeze(
    [...result.values()].sort((a, b) => a.id.localeCompare(b.id)),
  );
}

function uniqueMap<T extends { readonly id: string }>(
  items: readonly T[],
  errorName: string,
): ReadonlyMap<string, T> {
  const result = new Map<string, T>();
  for (const item of items) {
    if (result.has(item.id)) throw namedError(errorName);
    result.set(item.id, item);
  }
  return result;
}

function sameJson(left: unknown, right: unknown): boolean {
  return (
    hashCanonicalJsonV1(left as JsonValue) ===
    hashCanonicalJsonV1(right as JsonValue)
  );
}

function groupUnique<T>(
  items: readonly T[],
  key: (item: T) => string,
  value: (item: T) => string,
): ReadonlyMap<string, ReadonlySet<string>> {
  const result = new Map<string, Set<string>>();
  for (const item of items) {
    const values = result.get(key(item)) ?? new Set<string>();
    values.add(value(item));
    result.set(key(item), values);
  }
  return result;
}

function compareClaims(
  left: MemoryAspectClaimV1,
  right: MemoryAspectClaimV1,
): number {
  return (
    Date.parse(left.validFrom) - Date.parse(right.validFrom) ||
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

function semanticEdgeKey(edge: MemoryEvidenceEdgeV1): string {
  const [fromClaimId, toClaimId] =
    edge.edgeType === "same_state" &&
    edge.fromClaimId.localeCompare(edge.toClaimId) > 0
      ? [edge.toClaimId, edge.fromClaimId]
      : [edge.fromClaimId, edge.toClaimId];
  return `${edge.edgeType}\n${edge.stateKeyId ?? "unscoped"}\n${fromClaimId}\n${toClaimId}`;
}

function required<T>(map: ReadonlyMap<string, T>, id: string): T {
  const value = map.get(id);
  if (!value) throw namedError("MemoryAspectClaimMissing");
  return value;
}

function requiredAspect(
  snapshot: MemoryAspectGraphSnapshotV1,
  id: string,
): MemoryAspectV1 {
  const aspect = snapshot.aspects.find((item) => item.id === id);
  if (!aspect) throw namedError("MemoryAspectMissing");
  return aspect;
}

function selectProjectionStateDimensions(
  memberships: readonly MemoryClaimAspectMembershipV1[],
  requestedSubjectKey: string | undefined,
  requestedContextKey: string | undefined,
): Readonly<{ subjectKey: string; contextKey: string }> | undefined {
  if (
    (requestedSubjectKey === undefined) !==
    (requestedContextKey === undefined)
  ) {
    throw namedError("MemoryAspectProjectionStateScopeIncomplete");
  }
  if (requestedSubjectKey !== undefined && requestedContextKey !== undefined) {
    return Object.freeze({
      subjectKey: stateDimension(
        requestedSubjectKey,
        "MemoryAspectProjectionSubjectInvalid",
      ),
      contextKey: stateDimension(
        requestedContextKey,
        "MemoryAspectProjectionContextInvalid",
      ),
    });
  }
  const pairs = new Map<string, { subjectKey: string; contextKey: string }>();
  for (const membership of memberships) {
    pairs.set(`${membership.subjectKey}\n${membership.contextKey}`, {
      subjectKey: membership.subjectKey,
      contextKey: membership.contextKey,
    });
  }
  if (pairs.size > 1)
    throw namedError("MemoryAspectProjectionStateScopeAmbiguous");
  const selected = pairs.values().next().value;
  return selected === undefined ? undefined : Object.freeze(selected);
}

function retractedTargetIds(
  events: readonly MemoryAspectLifecycleEventV1[],
  asOf?: string,
): Readonly<{
  memberships: ReadonlySet<string>;
  edges: ReadonlySet<string>;
}> {
  const memberships = new Set<string>();
  const edges = new Set<string>();
  for (const event of events) {
    if (
      event.action !== "retract" ||
      (asOf !== undefined && Date.parse(event.occurredAt) > Date.parse(asOf))
    ) {
      continue;
    }
    (event.targetKind === "membership" ? memberships : edges).add(
      event.targetId,
    );
  }
  return { memberships, edges };
}

function freezeStateScope(
  value: Readonly<MemoryAspectStateScopeV1>,
): MemoryAspectStateScopeV1 {
  return Object.freeze({
    subjectKey: stateDimension(
      value.subjectKey,
      "MemoryAspectStateSubjectInvalid",
    ),
    aspectId: identity(value.aspectId, "MemoryAspectStateAspectInvalid"),
    contextKey: stateDimension(
      value.contextKey,
      "MemoryAspectStateContextInvalid",
    ),
  });
}

function deriveStateKeyIdFromFingerprint(
  input: Readonly<{
    scopeFingerprint: string;
    subjectKey: string;
    aspectId: string;
    contextKey: string;
  }>,
): string {
  return hashCanonicalJsonV1({
    schemaVersion: "paw.memory-aspect-state-key.v1",
    scopeFingerprint: identity(
      input.scopeFingerprint,
      "MemoryAspectStateScopeFingerprintInvalid",
    ),
    subjectKey: stateDimension(
      input.subjectKey,
      "MemoryAspectStateSubjectInvalid",
    ),
    aspectId: identity(input.aspectId, "MemoryAspectStateAspectInvalid"),
    contextKey: stateDimension(
      input.contextKey,
      "MemoryAspectStateContextInvalid",
    ),
  });
}

function isStateScopedEdgeType(edgeType: MemoryEvidenceEdgeTypeV1): boolean {
  return (
    edgeType === "same_state" ||
    edgeType === "supersedes" ||
    edgeType === "contradicts" ||
    edgeType === "qualifies"
  );
}

function add(map: Map<string, Set<string>>, key: string, value: string): void {
  const values = map.get(key) ?? new Set<string>();
  values.add(value);
  map.set(key, values);
}

function assertAcyclic(
  graph: ReadonlyMap<string, ReadonlySet<string>>,
  ids: Iterable<string>,
  errorName: string,
): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw namedError(errorName);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const target of graph.get(id) ?? []) visit(target);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);
}

function stableLabels(
  values: readonly string[],
  displayName: string,
): readonly string[] {
  const display = normalizeLabel(displayName);
  return Object.freeze(
    [
      ...new Set(
        values.map((value) => text(value, "MemoryAspectAliasInvalid", 160)),
      ),
    ]
      .filter((value) => normalizeLabel(value) !== display)
      .sort((a, b) => a.localeCompare(b)),
  );
}

function stableIdentities(
  values: readonly string[],
  errorName: string,
): string[] {
  return [...new Set(values.map((value) => identity(value, errorName)))].sort();
}

function assertStableIdentityList(
  values: readonly string[],
  errorName: string,
  requireNonEmpty = false,
): void {
  const stable = stableIdentities(values, errorName);
  if (
    (requireNonEmpty && stable.length === 0) ||
    !sameStrings(values, stable)
  ) {
    throw namedError(errorName);
  }
}

function identity(value: string, errorName: string): string {
  return text(value, errorName, 512);
}

function text(value: string, errorName: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw namedError(errorName);
  }
  return value.trim().normalize("NFKC");
}

function stateDimension(value: string, errorName: string): string {
  return text(value, errorName, 160);
}

function normalizeLabel(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}

function isoTime(value: string, errorName: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw namedError(errorName);
  }
  return new Date(value).toISOString();
}

function confidence(value: number, errorName: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1)
    throw namedError(errorName);
  return value;
}

function assertClaimRole(
  value: string,
): asserts value is MemoryAspectClaimRoleV1 {
  if (
    !(["state", "fact", "event", "cause", "condition"] as const).includes(
      value as MemoryAspectClaimRoleV1,
    )
  ) {
    throw namedError("MemoryAspectClaimRoleInvalid");
  }
}

function assertClaimKind(
  value: string,
): asserts value is MemoryAspectClaimKindV1 {
  if (value !== "assertion" && value !== "episode") {
    throw namedError("MemoryAspectClaimKindInvalid");
  }
}

function assertLifecycleTargetKind(
  value: string,
): asserts value is MemoryAspectLifecycleTargetKindV1 {
  if (value !== "membership" && value !== "edge") {
    throw namedError("MemoryAspectLifecycleTargetKindInvalid");
  }
}

function assertEdgeType(
  value: string,
): asserts value is MemoryEvidenceEdgeTypeV1 {
  if (
    !(
      [
        "same_state",
        "supersedes",
        "contradicts",
        "supports",
        "qualifies",
        "caused_by",
        "derived_from",
      ] as const
    ).includes(value as MemoryEvidenceEdgeTypeV1)
  ) {
    throw namedError("MemoryEvidenceEdgeTypeInvalid");
  }
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function eventFor(
  snapshot: MemoryAspectGraphSnapshotV1,
  type: "applied" | "projected",
  startedAt: number,
  now: (() => number) | undefined,
): MemoryAspectGraphEventV1 {
  return Object.freeze({
    schemaVersion: "paw.memory-aspect-graph-event.v1",
    type,
    scopeFingerprint: snapshot.scopeFingerprint,
    revision: snapshot.revision,
    claimCount: snapshot.claims.length,
    aspectCount: snapshot.aspects.length,
    membershipCount: snapshot.memberships.length,
    edgeCount: snapshot.edges.length,
    transitionCount: snapshot.transitions.length,
    lifecycleEventCount: snapshot.lifecycleEvents.length,
    durationMs: Math.max(0, (now ?? Date.now)() - startedAt),
  });
}

function emit(
  observer: ((event: MemoryAspectGraphEventV1) => void) | undefined,
  event: MemoryAspectGraphEventV1,
): void {
  try {
    observer?.(Object.freeze(event));
  } catch {
    // Observability is best effort and must not change graph semantics.
  }
}

function errorName(error: unknown): string {
  return error instanceof Error && error.name
    ? error.name
    : "MemoryAspectGraphUnknownFailure";
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
