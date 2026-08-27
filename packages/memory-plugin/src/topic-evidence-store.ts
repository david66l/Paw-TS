import { getSql } from "@paw/memory/db";
import {
  type MemoryEntry,
  type MemoryStoreEngine,
  PostgresMemoryStoreEngine,
} from "@paw/memory/longterm";

import type { PawNextMemoryScopeV1 } from "./profile.js";
import type { MemoryTopicEvidenceCatalogItemV1 } from "./topic-evidence-planner.js";
import {
  type MemoryTopicTrajectorySnapshotV1,
  type MemoryTopicV1,
  PAW_MEMORY_TOPIC_VERSION_V1,
  assertMemoryTopicProjectionIntegrityV1,
} from "./topic-trajectory.js";

export interface MemoryTopicEvidenceStoreV1 {
  readonly scope: PawNextMemoryScopeV1;
  load(
    signal: AbortSignal,
  ): Promise<readonly MemoryTopicEvidenceCatalogItemV1[]>;
}

export interface MemoryTopicEvidenceStoreEventV1 {
  readonly schemaVersion: "paw.memory-topic-evidence-store-event.v1";
  readonly type: "load";
  readonly topicCount: number;
  readonly memoryCount: number;
  readonly durationMs: number;
}

export function createPostgresMemoryTopicEvidenceStoreV1(
  input: Readonly<{
    scope: PawNextMemoryScopeV1;
    engine?: MemoryStoreEngine;
    onEvent?: (event: MemoryTopicEvidenceStoreEventV1) => void;
  }>,
): MemoryTopicEvidenceStoreV1 {
  const scope = Object.freeze({ ...input.scope });
  const engine = input.engine ?? new PostgresMemoryStoreEngine(scope);
  assertScopedEngine(engine, scope);
  return Object.freeze({
    scope,
    async load(signal: AbortSignal) {
      const started = Date.now();
      if (signal.aborted) throw abortError();
      const sql = getSql();
      const rows = await sql`
        SELECT topic.id, topic.family, topic.canonical_name,
               topic.normalized_name, topic.status, topic.projection_hash,
               topic.created_at, snapshot.payload
        FROM memory_topics topic
        JOIN LATERAL (
          SELECT payload
          FROM memory_trajectory_snapshots
          WHERE topic_id = topic.id
            AND projection_hash = topic.projection_hash
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        ) snapshot ON TRUE
        WHERE topic.scope->>'tenantId' = ${scope.tenantId}
          AND topic.scope->>'userId' = ${scope.userId}
          AND topic.scope->>'workspaceId' = ${scope.workspaceId}
          AND topic.scope->>'repositoryId' = ${scope.repositoryId}
          AND topic.status = 'active'
        ORDER BY topic.updated_at DESC, topic.id ASC
        LIMIT 128
      `;
      const catalog: MemoryTopicEvidenceCatalogItemV1[] = [];
      let memoryCount = 0;
      for (const row of rows) {
        if (signal.aborted) throw abortError();
        const snapshot = parseSnapshot(row.payload);
        const topic = parseTopic(row, scope);
        const projection = Object.freeze({ topic, snapshot });
        assertMemoryTopicProjectionIntegrityV1(projection);
        const entries: MemoryEntry[] = [];
        for (const id of snapshot.memberMemoryIds) {
          if (signal.aborted) throw abortError();
          const entry = await engine.get(id);
          if (!entry) throw namedError("MemoryTopicEvidenceMemberMissing");
          entries.push(entry);
        }
        memoryCount += entries.length;
        catalog.push(
          Object.freeze({
            projection,
            entries: Object.freeze(entries),
          }),
        );
      }
      emit(input.onEvent, {
        schemaVersion: "paw.memory-topic-evidence-store-event.v1",
        type: "load",
        topicCount: catalog.length,
        memoryCount,
        durationMs: Date.now() - started,
      });
      return Object.freeze(catalog);
    },
  });
}

function parseTopic(
  row: Record<string, unknown>,
  scope: PawNextMemoryScopeV1,
): MemoryTopicV1 {
  const family = row.family;
  if (
    family !== "semantic" &&
    family !== "episodic" &&
    family !== "profile" &&
    family !== "instruction" &&
    family !== "mixed"
  ) {
    throw namedError("MemoryTopicEvidenceFamilyInvalid");
  }
  if (row.status !== "active") {
    throw namedError("MemoryTopicEvidenceStatusInvalid");
  }
  return Object.freeze({
    schemaVersion: PAW_MEMORY_TOPIC_VERSION_V1,
    id: requiredString(row.id, "MemoryTopicEvidenceTopicInvalid"),
    scope,
    family,
    canonicalName: requiredString(
      row.canonical_name,
      "MemoryTopicEvidenceTopicInvalid",
    ),
    normalizedName: requiredString(
      row.normalized_name,
      "MemoryTopicEvidenceTopicInvalid",
    ),
    status: "active",
    projectionHash: requiredString(
      row.projection_hash,
      "MemoryTopicEvidenceTopicInvalid",
    ),
    createdAt: toIso(row.created_at),
  });
}

function parseSnapshot(value: unknown): MemoryTopicTrajectorySnapshotV1 {
  const parsed =
    typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw namedError("MemoryTopicEvidenceSnapshotInvalid");
  }
  return parsed as MemoryTopicTrajectorySnapshotV1;
}

function requiredString(value: unknown, errorName: string): string {
  if (typeof value !== "string" || !value.trim()) throw namedError(errorName);
  return value;
}

function toIso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) {
    throw namedError("MemoryTopicEvidenceTimeInvalid");
  }
  return date.toISOString();
}

function assertScopedEngine(
  engine: MemoryStoreEngine,
  scope: PawNextMemoryScopeV1,
): void {
  if (
    !engine.scope ||
    engine.scope.tenantId !== scope.tenantId ||
    engine.scope.userId !== scope.userId ||
    engine.scope.workspaceId !== scope.workspaceId ||
    engine.scope.repositoryId !== scope.repositoryId
  ) {
    throw namedError("MemoryTopicEvidenceEngineScopeMismatch");
  }
}

function emit(
  observer: ((event: MemoryTopicEvidenceStoreEventV1) => void) | undefined,
  event: MemoryTopicEvidenceStoreEventV1,
): void {
  try {
    observer?.(Object.freeze(event));
  } catch {
    // Content-free observability cannot affect evidence loading.
  }
}

function abortError(): Error {
  const error = new Error("Memory topic evidence store operation aborted");
  error.name = "AbortError";
  return error;
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
