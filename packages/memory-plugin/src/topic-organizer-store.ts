import { getSql } from "@paw/memory/db";
import {
  type MemoryEntry,
  type MemoryStoreEngine,
  PostgresMemoryStoreEngine,
} from "@paw/memory/longterm";
import type {
  MemoryTopicMemberProposalV1,
  MemoryTopicProposalV1,
} from "@paw/protocol";

import { hashCanonicalJsonV1 } from "./canonical.js";
import type { PawNextMemoryScopeV1 } from "./profile.js";
import {
  type MemoryTemporalGraphStoreV1,
  type MemoryTemporalRelationV1,
  createPostgresMemoryTemporalGraphStoreV1,
} from "./temporal-graph.js";
import type {
  MemoryTopicOrganizationSourceV1,
  MemoryTopicOrganizerStoreV1,
} from "./topic-organizer.js";
import {
  type MemoryTopicProjectionStoreV1,
  createPostgresMemoryTopicProjectionStoreV1,
} from "./topic-store.js";
import {
  createMemoryTopicProposalV1,
  deriveMemoryTopicIdV1,
  materializeMemoryTopicProjectionV1,
} from "./topic-trajectory.js";

export interface MemoryTopicOrganizerStoreEventV1 {
  readonly schemaVersion: "paw.memory-topic-organizer-store-event.v1";
  readonly type: "prepare" | "apply";
  readonly sourceCount?: number;
  readonly candidateCount?: number;
  readonly topicCount?: number;
  readonly relationCount?: number;
  readonly durationMs: number;
}

export function createPostgresMemoryTopicOrganizerStoreV1(
  input: Readonly<{
    scope: PawNextMemoryScopeV1;
    engine?: MemoryStoreEngine;
    graph?: MemoryTemporalGraphStoreV1;
    projections?: MemoryTopicProjectionStoreV1;
    onEvent?: (event: MemoryTopicOrganizerStoreEventV1) => void;
  }>,
): MemoryTopicOrganizerStoreV1 {
  const scope = Object.freeze({ ...input.scope });
  const engine = input.engine ?? new PostgresMemoryStoreEngine(scope);
  const graph =
    input.graph ?? createPostgresMemoryTemporalGraphStoreV1({ scope });
  const projections =
    input.projections ?? createPostgresMemoryTopicProjectionStoreV1({ scope });
  assertScopedEngine(engine, scope);
  assertExactScope(graph.scope, scope, "MemoryTopicGraphScopeMismatch");
  assertExactScope(projections.scope, scope, "MemoryTopicStoreScopeMismatch");

  return Object.freeze({
    async prepare(
      request: Parameters<MemoryTopicOrganizerStoreV1["prepare"]>[0],
      signal: AbortSignal,
    ): Promise<MemoryTopicOrganizationSourceV1> {
      const started = Date.now();
      if (signal.aborted) throw abortError();
      const sourceIds = uniqueIds(request.sourceMemoryIds, 64);
      assertExactScope(request.scope, scope, "MemoryTopicSourceScopeMismatch");
      const relations = await graph.list({ limit: 4_096 }, signal);
      const candidateIds = expandOneHop(sourceIds, relations, 128);
      const entries = await loadEntries(engine, candidateIds, signal);
      const topics = await listExistingTopics(scope, signal);
      const graphRevision = await graph.revisionToken(signal);
      const sourceRevision = hashCanonicalJsonV1({
        schemaVersion: "paw.memory-topic-source-revision.v1",
        graphRevision,
        sourceMemoryIds: sourceIds,
        entries: entries.map((entry) => ({
          id: entry.id,
          kind: entry.kind,
          tValid: entry.tValid,
          tInvalid: entry.tInvalid,
          evidence: [...entry.evidence].sort(),
        })),
        topics: topics.map((topic) => ({
          id: topic.id,
          family: topic.family,
          normalizedName: topic.normalizedName,
          projectionHash: topic.projectionHash,
        })),
      });
      const result = Object.freeze({
        sourceRevision,
        entries: Object.freeze(entries.map(toExtractionEntry)),
        existingTopics: Object.freeze(
          topics.map(({ projectionHash: _projectionHash, ...topic }) =>
            Object.freeze(topic),
          ),
        ),
      });
      emit(input.onEvent, {
        schemaVersion: "paw.memory-topic-organizer-store-event.v1",
        type: "prepare",
        sourceCount: sourceIds.length,
        candidateCount: result.entries.length,
        relationCount: relations.length,
        durationMs: Date.now() - started,
      });
      return result;
    },

    async apply(
      request: Parameters<MemoryTopicOrganizerStoreV1["apply"]>[0],
      signal: AbortSignal,
    ) {
      const started = Date.now();
      if (signal.aborted) throw abortError();
      assertExactScope(request.scope, scope, "MemoryTopicApplyScopeMismatch");
      const relations = await graph.list({ limit: 4_096 }, signal);
      const graphRevision = await graph.revisionToken(signal);
      const topicIds: string[] = [];
      const snapshotIds: string[] = [];
      for (const rawProposal of request.proposals) {
        if (signal.aborted) throw abortError();
        const topicId =
          rawProposal.targetTopicId ??
          deriveMemoryTopicIdV1({
            scope,
            family: rawProposal.family,
            normalizedName: rawProposal.normalizedName,
          });
        const existingMembers = await listActiveMembers(scope, topicId, signal);
        const completeMembers = expandMembers(
          [...existingMembers, ...rawProposal.members],
          relations,
          256,
        );
        const proposal: MemoryTopicProposalV1 = createMemoryTopicProposalV1({
          scope,
          family: rawProposal.family,
          canonicalName: rawProposal.canonicalName,
          ...(rawProposal.targetTopicId
            ? { targetTopicId: rawProposal.targetTopicId }
            : {}),
          members: completeMembers,
          confidence: rawProposal.confidence,
        });
        const entries = await loadEntries(
          engine,
          proposal.members.map((member) => member.memoryId),
          signal,
        );
        if (entries.length !== proposal.members.length) {
          throw namedError("MemoryTopicProjectionMemberMissing");
        }
        const projection = materializeMemoryTopicProjectionV1({
          scope,
          proposal,
          entries,
          relations,
          graphRevision,
          createdAt: new Date(request.claimedAt).toISOString(),
        });
        const committed = await projections.replaceProjection(
          projection,
          signal,
        );
        topicIds.push(committed.topicId);
        snapshotIds.push(committed.snapshotId);
      }
      emit(input.onEvent, {
        schemaVersion: "paw.memory-topic-organizer-store-event.v1",
        type: "apply",
        topicCount: topicIds.length,
        relationCount: relations.length,
        durationMs: Date.now() - started,
      });
      return Object.freeze({
        topicIds: Object.freeze(topicIds),
        snapshotIds: Object.freeze(snapshotIds),
      });
    },
  });
}

async function loadEntries(
  engine: MemoryStoreEngine,
  ids: readonly string[],
  signal: AbortSignal,
): Promise<readonly Exclude<MemoryEntry, { kind: "vault_ref" }>[]> {
  const entries: Exclude<MemoryEntry, { kind: "vault_ref" }>[] = [];
  for (const id of ids) {
    if (signal.aborted) throw abortError();
    const entry = await engine.get(id);
    if (entry && entry.kind !== "vault_ref") entries.push(entry);
  }
  return Object.freeze(entries);
}

function toExtractionEntry(entry: Exclude<MemoryEntry, { kind: "vault_ref" }>) {
  if (entry.kind === "semantic") {
    return Object.freeze({
      id: entry.id,
      kind: entry.kind,
      statement: entry.fact,
      keywords: Object.freeze([...entry.keywords]),
      confidence: entry.confidence,
    });
  }
  if (entry.kind === "profile") {
    return Object.freeze({
      id: entry.id,
      kind: entry.kind,
      statement: entry.insight,
      keywords: Object.freeze([]),
      confidence: entry.confidence,
    });
  }
  return Object.freeze({
    id: entry.id,
    kind: entry.kind,
    statement: [entry.whenToUse, entry.perspective, ...entry.modification].join(
      "\n",
    ),
    keywords: Object.freeze([
      entry.issueType,
      ...(entry.branch ? [entry.branch] : []),
    ]),
    confidence: entry.confidence,
  });
}

function expandOneHop(
  sourceIds: readonly string[],
  relations: readonly MemoryTemporalRelationV1[],
  limit: number,
): readonly string[] {
  const ids = new Set(sourceIds);
  for (const relation of relations) {
    if (relation.status !== "active") continue;
    if (ids.has(relation.fromMemoryId)) ids.add(relation.toMemoryId);
    else if (ids.has(relation.toMemoryId)) ids.add(relation.fromMemoryId);
    if (ids.size >= limit) break;
  }
  return Object.freeze([...ids].sort().slice(0, limit));
}

function expandMembers(
  proposed: readonly MemoryTopicMemberProposalV1[],
  relations: readonly MemoryTemporalRelationV1[],
  limit: number,
): readonly MemoryTopicMemberProposalV1[] {
  const members = new Map<string, MemoryTopicMemberProposalV1>();
  for (const member of proposed) {
    const prior = members.get(member.memoryId);
    if (!prior || memberPriority(member) >= memberPriority(prior)) {
      members.set(member.memoryId, Object.freeze({ ...member }));
    }
  }
  for (const relation of relations) {
    if (relation.status !== "active" || members.size >= limit) continue;
    const from = members.get(relation.fromMemoryId);
    const to = members.get(relation.toMemoryId);
    const relatedId =
      from && !to
        ? relation.toMemoryId
        : to && !from
          ? relation.fromMemoryId
          : undefined;
    if (!relatedId) continue;
    members.set(
      relatedId,
      Object.freeze({
        memoryId: relatedId,
        role: "supporting",
        confidence: 0.75,
        basis: "explicit_relation",
      }),
    );
  }
  return Object.freeze(
    [...members.values()]
      .sort((left, right) => left.memoryId.localeCompare(right.memoryId))
      .slice(0, limit),
  );
}

function memberPriority(member: MemoryTopicMemberProposalV1): number {
  const basis =
    member.basis === "user_asserted"
      ? 3
      : member.basis === "model_proposed"
        ? 2
        : 1;
  return basis * 10 + (member.role === "primary" ? 1 : 0);
}

async function listExistingTopics(
  scope: PawNextMemoryScopeV1,
  signal: AbortSignal,
) {
  if (signal.aborted) throw abortError();
  const sql = getSql();
  const rows = await sql`
    SELECT id, family, canonical_name, normalized_name, projection_hash
    FROM memory_topics
    WHERE scope->>'tenantId' = ${scope.tenantId}
      AND scope->>'userId' = ${scope.userId}
      AND scope->>'workspaceId' = ${scope.workspaceId}
      AND scope->>'repositoryId' = ${scope.repositoryId}
      AND status = 'active'
    ORDER BY updated_at DESC, id ASC
    LIMIT 128
  `;
  return Object.freeze(
    rows.map((row) => {
      const family = String(row.family);
      if (
        family !== "semantic" &&
        family !== "episodic" &&
        family !== "profile" &&
        family !== "instruction" &&
        family !== "mixed"
      ) {
        throw namedError("MemoryTopicStoredFamilyInvalid");
      }
      return Object.freeze({
        id: String(row.id),
        family,
        canonicalName: String(row.canonical_name),
        normalizedName: String(row.normalized_name),
        projectionHash: String(row.projection_hash),
      });
    }),
  );
}

async function listActiveMembers(
  scope: PawNextMemoryScopeV1,
  topicId: string,
  signal: AbortSignal,
): Promise<readonly MemoryTopicMemberProposalV1[]> {
  if (signal.aborted) throw abortError();
  const sql = getSql();
  const rows = await sql`
    SELECT membership.memory_id, membership.role, membership.confidence,
           membership.basis
    FROM memory_topic_memberships membership
    JOIN memory_topics topic ON topic.id = membership.topic_id
    WHERE membership.topic_id = ${topicId}
      AND membership.status = 'active'
      AND topic.scope->>'tenantId' = ${scope.tenantId}
      AND topic.scope->>'userId' = ${scope.userId}
      AND topic.scope->>'workspaceId' = ${scope.workspaceId}
      AND topic.scope->>'repositoryId' = ${scope.repositoryId}
    ORDER BY membership.memory_id ASC
    LIMIT 256
  `;
  return Object.freeze(
    rows.map((row) => {
      const role = row.role === "primary" ? "primary" : "supporting";
      const basis =
        row.basis === "user_asserted" ||
        row.basis === "explicit_relation" ||
        row.basis === "model_proposed"
          ? row.basis
          : "explicit_relation";
      return Object.freeze({
        memoryId: String(row.memory_id),
        role,
        confidence: Math.max(0, Math.min(1, Number(row.confidence))),
        basis,
      });
    }),
  );
}

function uniqueIds(ids: readonly string[], limit: number): readonly string[] {
  const values = [
    ...new Set(ids.map((id) => id.trim()).filter(Boolean)),
  ].sort();
  if (values.length === 0 || values.length > limit) {
    throw namedError("MemoryTopicSourceIdsInvalid");
  }
  return Object.freeze(values);
}

function assertScopedEngine(
  engine: MemoryStoreEngine,
  scope: PawNextMemoryScopeV1,
): void {
  if (!engine.scope) throw namedError("MemoryTopicEngineScopeMissing");
  assertExactScope(engine.scope, scope, "MemoryTopicEngineScopeMismatch");
}

function assertExactScope(
  actual: PawNextMemoryScopeV1,
  expected: PawNextMemoryScopeV1,
  errorName: string,
): void {
  if (
    actual.tenantId !== expected.tenantId ||
    actual.userId !== expected.userId ||
    actual.workspaceId !== expected.workspaceId ||
    actual.repositoryId !== expected.repositoryId
  ) {
    throw namedError(errorName);
  }
}

function emit(
  observer: ((event: MemoryTopicOrganizerStoreEventV1) => void) | undefined,
  event: MemoryTopicOrganizerStoreEventV1,
): void {
  try {
    observer?.(Object.freeze(event));
  } catch {
    // Caller-owned telemetry cannot change persistence semantics.
  }
}

function abortError(): Error {
  const error = new Error("Memory topic organizer store operation aborted");
  error.name = "AbortError";
  return error;
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
