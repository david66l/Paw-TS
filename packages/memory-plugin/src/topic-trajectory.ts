import { createHash } from "node:crypto";

import type { MemoryEntry } from "@paw/memory/longterm";
import {
  type JsonValue,
  MEMORY_TOPIC_PROPOSAL_SCHEMA_VERSION_V1,
  type MemoryTopicFamilyV1,
  type MemoryTopicMemberProposalV1,
  type MemoryTopicProposalV1,
} from "@paw/protocol";

export type {
  MemoryTopicFamilyV1,
  MemoryTopicMemberProposalV1,
  MemoryTopicProposalV1,
} from "@paw/protocol";

import { hashCanonicalJsonV1 } from "./canonical.js";
import {
  type PawNextMemoryScopeV1,
  memoryScopeFingerprintV1,
} from "./profile.js";
import type { MemoryTemporalRelationV1 } from "./temporal-graph.js";
import {
  type MemoryTrajectoryV1,
  projectMemoryTrajectoriesV1,
} from "./trajectory-projector.js";

export const PAW_MEMORY_TOPIC_PROPOSAL_VERSION_V1 =
  MEMORY_TOPIC_PROPOSAL_SCHEMA_VERSION_V1;
export const PAW_MEMORY_TOPIC_VERSION_V1 = "paw.memory-topic.v1" as const;
export const PAW_MEMORY_TOPIC_TRAJECTORY_SNAPSHOT_VERSION_V1 =
  "paw.memory-topic-trajectory-snapshot.v1" as const;

export interface MemoryTopicV1 {
  readonly schemaVersion: typeof PAW_MEMORY_TOPIC_VERSION_V1;
  readonly id: string;
  readonly scope: PawNextMemoryScopeV1;
  readonly family: MemoryTopicFamilyV1;
  readonly canonicalName: string;
  readonly normalizedName: string;
  readonly status: "active" | "archived";
  readonly projectionHash: string;
  readonly createdAt: string;
}

export interface MemoryTopicMembershipV1 extends MemoryTopicMemberProposalV1 {
  readonly topicId: string;
  readonly evidenceRefs: readonly string[];
}

export interface MemoryTopicRelationRefV1 {
  readonly relationId: string;
  readonly relationType: MemoryTemporalRelationV1["relationType"];
  readonly fromMemoryId: string;
  readonly toMemoryId: string;
  readonly evidenceRefs: readonly string[];
}

export interface MemoryTopicTrajectorySnapshotV1 {
  readonly schemaVersion: typeof PAW_MEMORY_TOPIC_TRAJECTORY_SNAPSHOT_VERSION_V1;
  readonly id: string;
  readonly topicId: string;
  readonly scopeFingerprint: string;
  readonly projectionHash: string;
  readonly graphRevision: string;
  readonly memberMemoryIds: readonly string[];
  readonly memberships: readonly MemoryTopicMembershipV1[];
  readonly relationRefs: readonly MemoryTopicRelationRefV1[];
  readonly trajectories: readonly MemoryTrajectoryV1[];
  readonly createdAt: string;
}

export interface MemoryTopicProjectionV1 {
  readonly topic: MemoryTopicV1;
  readonly snapshot: MemoryTopicTrajectorySnapshotV1;
}

export function createMemoryTopicProposalV1(
  input: Readonly<{
    scope: PawNextMemoryScopeV1;
    family: MemoryTopicFamilyV1;
    canonicalName: string;
    targetTopicId?: string;
    members: readonly MemoryTopicMemberProposalV1[];
    confidence: number;
  }>,
): MemoryTopicProposalV1 {
  assertFamily(input.family);
  const canonicalName = displayName(input.canonicalName);
  const normalizedName = normalizeMemoryTopicNameV1(canonicalName);
  const members = normalizeMemberProposals(input.members);
  if (members.length === 0) throw namedError("MemoryTopicMembersEmpty");
  const confidence = unitInterval(
    input.confidence,
    "MemoryTopicConfidenceInvalid",
  );
  const scopeFingerprint = memoryScopeFingerprintV1(input.scope);
  const targetTopicId = input.targetTopicId
    ? stableIdentity(input.targetTopicId, "MemoryTopicTargetInvalid")
    : undefined;
  const body = {
    schemaVersion: PAW_MEMORY_TOPIC_PROPOSAL_VERSION_V1,
    scopeFingerprint,
    family: input.family,
    canonicalName,
    normalizedName,
    ...(targetTopicId ? { targetTopicId } : {}),
    members: members.map((member) => ({ ...member })),
    confidence,
  } satisfies JsonValue;
  return Object.freeze({
    ...body,
    members,
    proposalId: hashCanonicalJsonV1(body),
  });
}

export function normalizeMemoryTopicNameV1(value: string): string {
  const normalized = displayName(value)
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
  if (normalized.length < 2) throw namedError("MemoryTopicNameInvalid");
  return normalized;
}

export function deriveMemoryTopicIdV1(
  input: Readonly<{
    scope: PawNextMemoryScopeV1;
    family: MemoryTopicFamilyV1;
    normalizedName: string;
  }>,
): string {
  assertFamily(input.family);
  const normalizedName = normalizeMemoryTopicNameV1(input.normalizedName);
  return createHash("sha256")
    .update(PAW_MEMORY_TOPIC_VERSION_V1)
    .update("\n")
    .update(memoryScopeFingerprintV1(input.scope))
    .update("\n")
    .update(input.family)
    .update("\n")
    .update(normalizedName)
    .digest("hex");
}

/**
 * Deterministically verifies a topic proposal against caller-owned L1 entries
 * and projects an immutable, content-addressed trajectory snapshot.
 */
export function materializeMemoryTopicProjectionV1(
  input: Readonly<{
    scope: PawNextMemoryScopeV1;
    proposal: MemoryTopicProposalV1;
    entries: readonly MemoryEntry[];
    relations: readonly MemoryTemporalRelationV1[];
    graphRevision: string;
    createdAt: string;
    maxStatesPerTrajectory?: number;
  }>,
): MemoryTopicProjectionV1 {
  const scopeFingerprint = memoryScopeFingerprintV1(input.scope);
  if (input.proposal.scopeFingerprint !== scopeFingerprint) {
    throw namedError("MemoryTopicProposalScopeMismatch");
  }
  const createdAt = isoTime(input.createdAt, "MemoryTopicCreatedAtInvalid");
  const graphRevision = stableIdentity(
    input.graphRevision,
    "MemoryTopicGraphRevisionInvalid",
  );
  const entries = new Map<string, MemoryEntry>();
  for (const entry of input.entries) {
    if (!entry.id.trim() || entries.has(entry.id)) {
      throw namedError("MemoryTopicEntryInvalid");
    }
    entries.set(entry.id, entry);
  }
  const memberIds = new Set(
    input.proposal.members.map((item) => item.memoryId),
  );
  if (
    entries.size !== memberIds.size ||
    [...memberIds].some((id) => !entries.has(id))
  ) {
    throw namedError("MemoryTopicEntrySetMismatch");
  }
  const topicId = deriveMemoryTopicIdV1({
    scope: input.scope,
    family: input.proposal.family,
    normalizedName: input.proposal.normalizedName,
  });
  if (
    input.proposal.targetTopicId !== undefined &&
    input.proposal.targetTopicId !== topicId
  ) {
    throw namedError("MemoryTopicTargetIdentityMismatch");
  }
  const memberships = Object.freeze(
    input.proposal.members.map((member) => {
      const entry = entries.get(member.memoryId);
      if (!entry) throw namedError("MemoryTopicEntrySetMismatch");
      return Object.freeze({
        ...member,
        topicId,
        evidenceRefs: Object.freeze(stableStrings(entry.evidence, 128)),
      });
    }),
  );
  const relationRefs = Object.freeze(
    input.relations
      .filter(
        (relation) =>
          relation.status === "active" &&
          memberIds.has(relation.fromMemoryId) &&
          memberIds.has(relation.toMemoryId),
      )
      .map((relation) =>
        Object.freeze({
          relationId: relation.id,
          relationType: relation.relationType,
          fromMemoryId: relation.fromMemoryId,
          toMemoryId: relation.toMemoryId,
          evidenceRefs: Object.freeze(
            stableStrings(relation.evidenceRefs, 128),
          ),
        }),
      )
      .sort((left, right) => left.relationId.localeCompare(right.relationId)),
  );
  const relevantRelations = input.relations.filter((relation) =>
    relationRefs.some((item) => item.relationId === relation.id),
  );
  const trajectories = projectMemoryTrajectoriesV1({
    entries: [...entries.values()],
    relations: relevantRelations,
    includeSingletons: true,
    maxTrajectories: Math.min(512, Math.max(1, entries.size)),
    maxStatesPerTrajectory: input.maxStatesPerTrajectory ?? 64,
  });
  const projectionHash = deriveProjectionHash({
    topicId,
    scopeFingerprint,
    graphRevision,
    memberships,
    relationRefs,
    trajectories,
  });
  const snapshotId = deriveSnapshotId(topicId, projectionHash);
  const topic = Object.freeze({
    schemaVersion: PAW_MEMORY_TOPIC_VERSION_V1,
    id: topicId,
    scope: Object.freeze({ ...input.scope }),
    family: input.proposal.family,
    canonicalName: input.proposal.canonicalName,
    normalizedName: input.proposal.normalizedName,
    status: "active" as const,
    projectionHash,
    createdAt,
  });
  const snapshot = Object.freeze({
    schemaVersion: PAW_MEMORY_TOPIC_TRAJECTORY_SNAPSHOT_VERSION_V1,
    id: snapshotId,
    topicId,
    scopeFingerprint,
    projectionHash,
    graphRevision,
    memberMemoryIds: Object.freeze([...memberIds].sort()),
    memberships,
    relationRefs,
    trajectories,
    createdAt,
  });
  return Object.freeze({ topic, snapshot });
}

/** Recomputes every durable identity before a projection crosses a store boundary. */
export function assertMemoryTopicProjectionIntegrityV1(
  projection: MemoryTopicProjectionV1,
): void {
  const { topic, snapshot } = projection;
  if (
    topic.schemaVersion !== PAW_MEMORY_TOPIC_VERSION_V1 ||
    snapshot.schemaVersion !==
      PAW_MEMORY_TOPIC_TRAJECTORY_SNAPSHOT_VERSION_V1 ||
    topic.id !== snapshot.topicId ||
    topic.projectionHash !== snapshot.projectionHash ||
    memoryScopeFingerprintV1(topic.scope) !== snapshot.scopeFingerprint ||
    topic.id !==
      deriveMemoryTopicIdV1({
        scope: topic.scope,
        family: topic.family,
        normalizedName: topic.normalizedName,
      })
  ) {
    throw namedError("MemoryTopicProjectionIdentityMismatch");
  }
  const memberMemoryIds = stableStrings(
    snapshot.memberships.map((membership) => membership.memoryId),
    256,
  );
  const declaredMemberIds = stableStrings(snapshot.memberMemoryIds, 256);
  const trajectoryStateIds = snapshot.trajectories.flatMap((trajectory) =>
    trajectory.states.map((state) => state.memoryId),
  );
  const stableTrajectoryStateIds = stableStrings(trajectoryStateIds, 256);
  if (
    memberMemoryIds.length !== snapshot.memberships.length ||
    declaredMemberIds.length !== snapshot.memberMemoryIds.length ||
    memberMemoryIds.join("\n") !== declaredMemberIds.join("\n") ||
    trajectoryStateIds.length !== stableTrajectoryStateIds.length ||
    stableTrajectoryStateIds.some((id) => !memberMemoryIds.includes(id)) ||
    (snapshot.trajectories.every((trajectory) => !trajectory.truncated) &&
      memberMemoryIds.join("\n") !== stableTrajectoryStateIds.join("\n")) ||
    snapshot.memberships.some(
      (membership) => membership.topicId !== topic.id,
    ) ||
    snapshot.relationRefs.some(
      (relation) =>
        !memberMemoryIds.includes(relation.fromMemoryId) ||
        !memberMemoryIds.includes(relation.toMemoryId),
    )
  ) {
    throw namedError("MemoryTopicProjectionMembersMismatch");
  }
  const expectedProjectionHash = deriveProjectionHash({
    topicId: topic.id,
    scopeFingerprint: snapshot.scopeFingerprint,
    graphRevision: snapshot.graphRevision,
    memberships: snapshot.memberships,
    relationRefs: snapshot.relationRefs,
    trajectories: snapshot.trajectories,
  });
  if (
    expectedProjectionHash !== snapshot.projectionHash ||
    deriveSnapshotId(topic.id, expectedProjectionHash) !== snapshot.id
  ) {
    throw namedError("MemoryTopicProjectionHashMismatch");
  }
}

function deriveProjectionHash(
  input: Readonly<{
    topicId: string;
    scopeFingerprint: string;
    graphRevision: string;
    memberships: readonly MemoryTopicMembershipV1[];
    relationRefs: readonly MemoryTopicRelationRefV1[];
    trajectories: readonly MemoryTrajectoryV1[];
  }>,
): string {
  const body = {
    schemaVersion: PAW_MEMORY_TOPIC_TRAJECTORY_SNAPSHOT_VERSION_V1,
    topicId: input.topicId,
    scopeFingerprint: input.scopeFingerprint,
    graphRevision: input.graphRevision,
    memberships: input.memberships.map((membership) => ({
      memoryId: membership.memoryId,
      role: membership.role,
      confidence: membership.confidence,
      basis: membership.basis,
      evidenceRefs: [...membership.evidenceRefs],
    })),
    relationRefs: input.relationRefs.map((relation) => ({ ...relation })),
    trajectories: input.trajectories.map((trajectory) => ({
      schemaVersion: trajectory.schemaVersion,
      trajectoryId: trajectory.trajectoryId,
      stateCount: trajectory.stateCount,
      sourceCount: trajectory.sourceCount,
      truncated: trajectory.truncated,
      states: trajectory.states.map((state) => ({
        ...state,
        evidenceRefs: [...state.evidenceRefs],
        supersedesMemoryIds: [...state.supersedesMemoryIds],
        supersededByMemoryIds: [...state.supersededByMemoryIds],
      })),
    })),
  } satisfies JsonValue;
  return hashCanonicalJsonV1(body);
}

function deriveSnapshotId(topicId: string, projectionHash: string): string {
  return createHash("sha256")
    .update(PAW_MEMORY_TOPIC_TRAJECTORY_SNAPSHOT_VERSION_V1)
    .update("\n")
    .update(topicId)
    .update("\n")
    .update(projectionHash)
    .digest("hex");
}

function normalizeMemberProposals(
  values: readonly MemoryTopicMemberProposalV1[],
): readonly MemoryTopicMemberProposalV1[] {
  if (!Array.isArray(values) || values.length > 256) {
    throw namedError("MemoryTopicMembersInvalid");
  }
  const seen = new Set<string>();
  const result = values.map((value) => {
    const memoryId = stableIdentity(
      value.memoryId,
      "MemoryTopicMemberIdInvalid",
    );
    if (seen.has(memoryId)) throw namedError("MemoryTopicMemberDuplicate");
    seen.add(memoryId);
    if (value.role !== "primary" && value.role !== "supporting") {
      throw namedError("MemoryTopicMemberRoleInvalid");
    }
    if (
      value.basis !== "model_proposed" &&
      value.basis !== "explicit_relation" &&
      value.basis !== "user_asserted"
    ) {
      throw namedError("MemoryTopicMemberBasisInvalid");
    }
    return Object.freeze({
      memoryId,
      role: value.role,
      confidence: unitInterval(
        value.confidence,
        "MemoryTopicMemberConfidenceInvalid",
      ),
      basis: value.basis,
    });
  });
  return Object.freeze(
    result.sort(
      (left, right) =>
        (left.role === right.role ? 0 : left.role === "primary" ? -1 : 1) ||
        left.memoryId.localeCompare(right.memoryId),
    ),
  );
}

function assertFamily(value: unknown): asserts value is MemoryTopicFamilyV1 {
  if (
    value !== "semantic" &&
    value !== "episodic" &&
    value !== "profile" &&
    value !== "instruction" &&
    value !== "mixed"
  ) {
    throw namedError("MemoryTopicFamilyInvalid");
  }
}

function displayName(value: unknown): string {
  if (typeof value !== "string") throw namedError("MemoryTopicNameInvalid");
  const normalized = value.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (normalized.length < 2 || normalized.length > 96) {
    throw namedError("MemoryTopicNameInvalid");
  }
  return normalized;
}

function stableIdentity(value: unknown, errorName: string): string {
  if (typeof value !== "string") throw namedError(errorName);
  const normalized = value.trim();
  if (!normalized || normalized.length > 8_192) throw namedError(errorName);
  return normalized;
}

function stableStrings(values: readonly string[], max: number): string[] {
  const result = [
    ...new Set(
      values.map((value) =>
        stableIdentity(value, "MemoryTopicEvidenceInvalid"),
      ),
    ),
  ].sort();
  if (result.length > max) throw namedError("MemoryTopicEvidenceInvalid");
  return result;
}

function unitInterval(value: number, errorName: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw namedError(errorName);
  }
  return value;
}

function isoTime(value: unknown, errorName: string): string {
  const text = stableIdentity(value, errorName);
  const time = Date.parse(text);
  if (!Number.isFinite(time)) throw namedError(errorName);
  return new Date(time).toISOString();
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
