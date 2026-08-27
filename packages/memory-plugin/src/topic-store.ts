import { getSql } from "@paw/memory/db";

import {
  type PawNextMemoryScopeV1,
  memoryScopeFingerprintV1,
} from "./profile.js";
import {
  type MemoryTopicProjectionV1,
  PAW_MEMORY_TOPIC_TRAJECTORY_SNAPSHOT_VERSION_V1,
  PAW_MEMORY_TOPIC_VERSION_V1,
  assertMemoryTopicProjectionIntegrityV1,
} from "./topic-trajectory.js";

export interface MemoryTopicStoreEventV1 {
  readonly schemaVersion: "paw.memory-topic-store-event.v1";
  readonly type: "projection_commit";
  readonly scopeFingerprint: string;
  readonly memberCount: number;
  readonly relationCount: number;
  readonly trajectoryCount: number;
  readonly changed: boolean;
  readonly durationMs: number;
}

export interface MemoryTopicProjectionCommitResultV1 {
  readonly topicId: string;
  readonly snapshotId: string;
  readonly topicRevision: number;
  readonly changed: boolean;
}

export interface MemoryTopicProjectionStoreV1 {
  readonly scope: PawNextMemoryScopeV1;
  replaceProjection(
    projection: MemoryTopicProjectionV1,
    signal: AbortSignal,
  ): Promise<MemoryTopicProjectionCommitResultV1>;
}

/**
 * Stores one complete topic projection atomically. Membership omission means
 * retraction, so callers must pass a complete, evidence-verified member set.
 */
export function createPostgresMemoryTopicProjectionStoreV1(
  input: Readonly<{
    scope: PawNextMemoryScopeV1;
    onEvent?: (event: MemoryTopicStoreEventV1) => void;
  }>,
): MemoryTopicProjectionStoreV1 {
  const scope = Object.freeze({ ...input.scope });
  const scopeFingerprint = memoryScopeFingerprintV1(scope);
  return Object.freeze({
    scope,
    async replaceProjection(
      projection: MemoryTopicProjectionV1,
      signal: AbortSignal,
    ): Promise<MemoryTopicProjectionCommitResultV1> {
      const startedAt = Date.now();
      if (signal.aborted) throw abortError();
      assertMemoryTopicProjectionIntegrityV1(projection);
      assertExactScope(projection.topic.scope, scope);
      const sql = getSql();
      const result = await sql.begin(async (tx) => {
        if (signal.aborted) throw abortError();
        const priorRows = await tx`
          SELECT projection_hash
          FROM memory_topics
          WHERE id = ${projection.topic.id}
            AND scope->>'tenantId' = ${scope.tenantId}
            AND scope->>'userId' = ${scope.userId}
            AND scope->>'workspaceId' = ${scope.workspaceId}
            AND scope->>'repositoryId' = ${scope.repositoryId}
          FOR UPDATE
        `;
        const priorHash = (
          priorRows[0] as { projection_hash?: unknown } | undefined
        )?.projection_hash;
        const changed =
          String(priorHash ?? "") !== projection.topic.projectionHash;
        const topicRows = await tx`
          INSERT INTO memory_topics (
            id, schema_version, scope, family, canonical_name, normalized_name,
            status, revision, projection_hash, created_at, updated_at
          ) VALUES (
            ${projection.topic.id}, ${PAW_MEMORY_TOPIC_VERSION_V1},
            ${tx.json(scope)}, ${projection.topic.family},
            ${projection.topic.canonicalName}, ${projection.topic.normalizedName},
            ${projection.topic.status}, 1, ${projection.topic.projectionHash},
            ${projection.topic.createdAt}, ${projection.topic.createdAt}
          )
          ON CONFLICT (id) DO UPDATE SET
            canonical_name = EXCLUDED.canonical_name,
            status = EXCLUDED.status,
            projection_hash = EXCLUDED.projection_hash,
            revision = CASE
              WHEN memory_topics.projection_hash <> EXCLUDED.projection_hash
              THEN memory_topics.revision + 1
              ELSE memory_topics.revision
            END,
            updated_at = CASE
              WHEN memory_topics.projection_hash <> EXCLUDED.projection_hash
              THEN EXCLUDED.updated_at
              ELSE memory_topics.updated_at
            END
          WHERE memory_topics.scope->>'tenantId' = ${scope.tenantId}
            AND memory_topics.scope->>'userId' = ${scope.userId}
            AND memory_topics.scope->>'workspaceId' = ${scope.workspaceId}
            AND memory_topics.scope->>'repositoryId' = ${scope.repositoryId}
            AND memory_topics.family = EXCLUDED.family
            AND memory_topics.normalized_name = EXCLUDED.normalized_name
          RETURNING revision
        `;
        if (topicRows.length !== 1) {
          throw namedError("MemoryTopicStoreScopeMismatch");
        }

        if (changed) {
          await tx`
            UPDATE memory_topic_memberships
            SET status = 'retracted', updated_at = ${projection.snapshot.createdAt}
            WHERE topic_id = ${projection.topic.id} AND status = 'active'
          `;
          for (const membership of projection.snapshot.memberships) {
            if (signal.aborted) throw abortError();
            const memoryRows = await tx`
              SELECT id FROM memory_items
              WHERE id = ${membership.memoryId}
                AND scope->>'tenantId' = ${scope.tenantId}
                AND scope->>'userId' = ${scope.userId}
                AND scope->>'workspaceId' = ${scope.workspaceId}
                AND scope->>'repositoryId' = ${scope.repositoryId}
            `;
            if (memoryRows.length !== 1) {
              throw namedError("MemoryTopicMemberScopeMismatch");
            }
            await tx`
              INSERT INTO memory_topic_memberships (
                topic_id, memory_id, role, confidence, basis, status,
                evidence_refs, created_at, updated_at
              ) VALUES (
                ${projection.topic.id}, ${membership.memoryId},
                ${membership.role}, ${membership.confidence}, ${membership.basis},
                'active', ${tx.json([...membership.evidenceRefs])},
                ${projection.snapshot.createdAt}, ${projection.snapshot.createdAt}
              )
              ON CONFLICT (topic_id, memory_id) DO UPDATE SET
                role = EXCLUDED.role,
                confidence = EXCLUDED.confidence,
                basis = EXCLUDED.basis,
                status = 'active',
                evidence_refs = EXCLUDED.evidence_refs,
                updated_at = EXCLUDED.updated_at
            `;
          }
          await tx`
            INSERT INTO memory_trajectory_snapshots (
              id, schema_version, topic_id, projection_hash,
              graph_revision, payload, created_at
            ) VALUES (
              ${projection.snapshot.id},
              ${PAW_MEMORY_TOPIC_TRAJECTORY_SNAPSHOT_VERSION_V1},
              ${projection.topic.id}, ${projection.snapshot.projectionHash},
              ${projection.snapshot.graphRevision},
              ${tx.json(projection.snapshot as never)},
              ${projection.snapshot.createdAt}
            )
            ON CONFLICT (topic_id, projection_hash) DO NOTHING
          `;
        }
        return Object.freeze({
          topicId: projection.topic.id,
          snapshotId: projection.snapshot.id,
          topicRevision: Number(
            (topicRows[0] as { revision?: unknown }).revision ?? 1,
          ),
          changed,
        });
      });
      emit(input.onEvent, {
        schemaVersion: "paw.memory-topic-store-event.v1",
        type: "projection_commit",
        scopeFingerprint,
        memberCount: projection.snapshot.memberships.length,
        relationCount: projection.snapshot.relationRefs.length,
        trajectoryCount: projection.snapshot.trajectories.length,
        changed: result.changed,
        durationMs: Date.now() - startedAt,
      });
      return result;
    },
  });
}

function assertExactScope(
  actual: PawNextMemoryScopeV1,
  expected: PawNextMemoryScopeV1,
): void {
  if (
    actual.tenantId !== expected.tenantId ||
    actual.userId !== expected.userId ||
    actual.workspaceId !== expected.workspaceId ||
    actual.repositoryId !== expected.repositoryId
  ) {
    throw namedError("MemoryTopicStoreScopeMismatch");
  }
}

function emit(
  observer: ((event: MemoryTopicStoreEventV1) => void) | undefined,
  event: MemoryTopicStoreEventV1,
): void {
  try {
    observer?.(Object.freeze(event));
  } catch {
    // Observability must not affect projection durability.
  }
}

function abortError(): Error {
  const error = new Error("Memory topic store operation aborted");
  error.name = "AbortError";
  return error;
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
