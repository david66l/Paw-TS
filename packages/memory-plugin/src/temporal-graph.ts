import { createHash } from "node:crypto";

import { getSql } from "@paw/memory/db";

import {
  type PawNextMemoryScopeV1,
  memoryScopeFingerprintV1,
} from "./profile.js";

export const PAW_MEMORY_TEMPORAL_GRAPH_VERSION_V1 =
  "paw.memory-temporal-graph.v1" as const;

export type MemoryTemporalRelationTypeV1 =
  | "supersedes"
  | "supports"
  | "contradicts"
  | "derived_from";

export type MemoryTemporalRelationStatusV1 = "active" | "retracted";

export interface MemoryTemporalRelationV1 {
  readonly schemaVersion: typeof PAW_MEMORY_TEMPORAL_GRAPH_VERSION_V1;
  readonly id: string;
  /** The newer/subject memory. For supersedes this points at the old memory. */
  readonly fromMemoryId: string;
  readonly toMemoryId: string;
  readonly relationType: MemoryTemporalRelationTypeV1;
  readonly status: MemoryTemporalRelationStatusV1;
  readonly sourceRefs: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MemoryTemporalGraphEventV1 {
  readonly schemaVersion: "paw.memory-temporal-graph-event.v1";
  readonly type: "put" | "list" | "revision";
  readonly scopeFingerprint: string;
  readonly relationCount: number;
  readonly durationMs: number;
}

export interface MemoryTemporalGraphStoreV1 {
  readonly scope: PawNextMemoryScopeV1;
  put(
    relations: readonly MemoryTemporalRelationV1[],
    signal: AbortSignal,
  ): Promise<void>;
  list(
    options: Readonly<{ limit?: number }>,
    signal: AbortSignal,
  ): Promise<readonly MemoryTemporalRelationV1[]>;
  revisionToken(signal: AbortSignal): Promise<string>;
}

export function createMemoryTemporalRelationV1(
  input: Readonly<{
    scope: PawNextMemoryScopeV1;
    fromMemoryId: string;
    toMemoryId: string;
    relationType: MemoryTemporalRelationTypeV1;
    status?: MemoryTemporalRelationStatusV1;
    sourceRefs?: readonly string[];
    evidenceRefs?: readonly string[];
    createdAt: string;
  }>,
): MemoryTemporalRelationV1 {
  const fromMemoryId = nonEmpty(input.fromMemoryId, "fromMemoryId");
  const toMemoryId = nonEmpty(input.toMemoryId, "toMemoryId");
  if (fromMemoryId === toMemoryId) {
    throw namedError("MemoryTemporalRelationSelfReference");
  }
  const createdAt = isoTime(input.createdAt, "createdAt");
  const status = input.status ?? "active";
  assertRelationType(input.relationType);
  assertRelationStatus(status);
  const sourceRefs = stableRefs(input.sourceRefs ?? []);
  const evidenceRefs = stableRefs(input.evidenceRefs ?? []);
  const id = deriveMemoryTemporalRelationIdV1({
    scope: input.scope,
    relationType: input.relationType,
    fromMemoryId,
    toMemoryId,
  });
  return Object.freeze({
    schemaVersion: PAW_MEMORY_TEMPORAL_GRAPH_VERSION_V1,
    id,
    fromMemoryId,
    toMemoryId,
    relationType: input.relationType,
    status,
    sourceRefs,
    evidenceRefs,
    createdAt,
    updatedAt: createdAt,
  });
}

export function deriveMemoryTemporalRelationIdV1(
  input: Readonly<{
    scope: PawNextMemoryScopeV1;
    fromMemoryId: string;
    toMemoryId: string;
    relationType: MemoryTemporalRelationTypeV1;
  }>,
): string {
  const fromMemoryId = nonEmpty(input.fromMemoryId, "fromMemoryId");
  const toMemoryId = nonEmpty(input.toMemoryId, "toMemoryId");
  assertRelationType(input.relationType);
  return createHash("sha256")
    .update(PAW_MEMORY_TEMPORAL_GRAPH_VERSION_V1)
    .update("\n")
    .update(memoryScopeFingerprintV1(input.scope))
    .update("\n")
    .update(input.relationType)
    .update("\n")
    .update(fromMemoryId)
    .update("\n")
    .update(toMemoryId)
    .digest("hex");
}

export function createPostgresMemoryTemporalGraphStoreV1(
  input: Readonly<{
    scope: PawNextMemoryScopeV1;
    onEvent?: (event: MemoryTemporalGraphEventV1) => void;
  }>,
): MemoryTemporalGraphStoreV1 {
  const scope = Object.freeze({ ...input.scope });
  const scopeFingerprint = memoryScopeFingerprintV1(scope);
  return Object.freeze({
    scope,
    async put(
      relations: readonly MemoryTemporalRelationV1[],
      signal: AbortSignal,
    ): Promise<void> {
      const startedAt = Date.now();
      if (signal.aborted) throw abortError();
      const sql = getSql();
      for (const raw of relations) {
        if (signal.aborted) throw abortError();
        const relation = validateRelation(raw);
        if (
          relation.id !==
          deriveMemoryTemporalRelationIdV1({
            scope,
            fromMemoryId: relation.fromMemoryId,
            toMemoryId: relation.toMemoryId,
            relationType: relation.relationType,
          })
        ) {
          throw namedError("MemoryTemporalRelationIdentityMismatch");
        }
        const rows = await sql`
          INSERT INTO memory_relations (
            id, from_memory_id, to_memory_id, relation_type, status,
            source_refs, evidence_refs, created_at, updated_at
          )
          SELECT
            ${relation.id}, source.id, target.id, ${relation.relationType},
            ${relation.status}, ${sql.json([...relation.sourceRefs])},
            ${sql.json([...relation.evidenceRefs])}, ${relation.createdAt},
            ${relation.updatedAt}
          FROM memory_items source
          JOIN memory_items target ON target.id = ${relation.toMemoryId}
          WHERE source.id = ${relation.fromMemoryId}
            AND source.scope->>'tenantId' = ${scope.tenantId}
            AND source.scope->>'userId' = ${scope.userId}
            AND source.scope->>'workspaceId' = ${scope.workspaceId}
            AND source.scope->>'repositoryId' = ${scope.repositoryId}
            AND target.scope->>'tenantId' = ${scope.tenantId}
            AND target.scope->>'userId' = ${scope.userId}
            AND target.scope->>'workspaceId' = ${scope.workspaceId}
            AND target.scope->>'repositoryId' = ${scope.repositoryId}
          ON CONFLICT (id) DO UPDATE SET
            status = EXCLUDED.status,
            source_refs = EXCLUDED.source_refs,
            evidence_refs = EXCLUDED.evidence_refs,
            updated_at = EXCLUDED.updated_at
          WHERE memory_relations.from_memory_id = EXCLUDED.from_memory_id
            AND memory_relations.to_memory_id = EXCLUDED.to_memory_id
            AND memory_relations.relation_type = EXCLUDED.relation_type
          RETURNING id
        `;
        if (rows.length !== 1) {
          throw namedError("MemoryTemporalRelationScopeMismatch");
        }
      }
      emit(input.onEvent, {
        schemaVersion: "paw.memory-temporal-graph-event.v1",
        type: "put",
        scopeFingerprint,
        relationCount: relations.length,
        durationMs: Date.now() - startedAt,
      });
    },
    async list(
      options: Readonly<{ limit?: number }>,
      signal: AbortSignal,
    ): Promise<readonly MemoryTemporalRelationV1[]> {
      const startedAt = Date.now();
      if (signal.aborted) throw abortError();
      const limit = boundedLimit(options.limit ?? 2_048);
      const sql = getSql();
      const rows = await sql`
        SELECT relation.*
        FROM memory_relations relation
        JOIN memory_items source ON source.id = relation.from_memory_id
        JOIN memory_items target ON target.id = relation.to_memory_id
        WHERE source.scope->>'tenantId' = ${scope.tenantId}
          AND source.scope->>'userId' = ${scope.userId}
          AND source.scope->>'workspaceId' = ${scope.workspaceId}
          AND source.scope->>'repositoryId' = ${scope.repositoryId}
          AND target.scope->>'tenantId' = ${scope.tenantId}
          AND target.scope->>'userId' = ${scope.userId}
          AND target.scope->>'workspaceId' = ${scope.workspaceId}
          AND target.scope->>'repositoryId' = ${scope.repositoryId}
        ORDER BY relation.updated_at DESC, relation.id ASC
        LIMIT ${limit}
      `;
      if (signal.aborted) throw abortError();
      const result = Object.freeze(rows.map(rowToRelation));
      emit(input.onEvent, {
        schemaVersion: "paw.memory-temporal-graph-event.v1",
        type: "list",
        scopeFingerprint,
        relationCount: result.length,
        durationMs: Date.now() - startedAt,
      });
      return result;
    },
    async revisionToken(signal: AbortSignal): Promise<string> {
      const startedAt = Date.now();
      if (signal.aborted) throw abortError();
      const sql = getSql();
      const rows = await sql`
        SELECT COUNT(*)::text AS relation_count,
               MAX(relation.updated_at) AS max_updated_at
        FROM memory_relations relation
        JOIN memory_items source ON source.id = relation.from_memory_id
        JOIN memory_items target ON target.id = relation.to_memory_id
        WHERE source.scope->>'tenantId' = ${scope.tenantId}
          AND source.scope->>'userId' = ${scope.userId}
          AND source.scope->>'workspaceId' = ${scope.workspaceId}
          AND source.scope->>'repositoryId' = ${scope.repositoryId}
          AND target.scope->>'tenantId' = ${scope.tenantId}
          AND target.scope->>'userId' = ${scope.userId}
          AND target.scope->>'workspaceId' = ${scope.workspaceId}
          AND target.scope->>'repositoryId' = ${scope.repositoryId}
      `;
      const row = rows[0] as
        | { relation_count?: unknown; max_updated_at?: unknown }
        | undefined;
      const token = [
        PAW_MEMORY_TEMPORAL_GRAPH_VERSION_V1,
        scopeFingerprint,
        String(row?.relation_count ?? "0"),
        row?.max_updated_at == null
          ? "none"
          : new Date(
              row.max_updated_at as string | number | Date,
            ).toISOString(),
      ].join(":");
      emit(input.onEvent, {
        schemaVersion: "paw.memory-temporal-graph-event.v1",
        type: "revision",
        scopeFingerprint,
        relationCount: Number(row?.relation_count ?? 0),
        durationMs: Date.now() - startedAt,
      });
      return token;
    },
  });
}

function rowToRelation(row: Record<string, unknown>): MemoryTemporalRelationV1 {
  return validateRelation({
    schemaVersion: PAW_MEMORY_TEMPORAL_GRAPH_VERSION_V1,
    id: row.id,
    fromMemoryId: row.from_memory_id,
    toMemoryId: row.to_memory_id,
    relationType: row.relation_type,
    status: row.status,
    sourceRefs: parseRefs(row.source_refs),
    evidenceRefs: parseRefs(row.evidence_refs),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  });
}

function validateRelation(value: unknown): MemoryTemporalRelationV1 {
  if (typeof value !== "object" || value === null) {
    throw namedError("MemoryTemporalRelationInvalid");
  }
  const relation = value as Record<string, unknown>;
  if (relation.schemaVersion !== PAW_MEMORY_TEMPORAL_GRAPH_VERSION_V1) {
    throw namedError("MemoryTemporalRelationInvalid");
  }
  const relationType = relation.relationType;
  const status = relation.status;
  assertRelationType(relationType);
  assertRelationStatus(status);
  const createdAt = isoTime(relation.createdAt, "createdAt");
  const updatedAt = isoTime(relation.updatedAt, "updatedAt");
  const fromMemoryId = nonEmpty(relation.fromMemoryId, "fromMemoryId");
  const toMemoryId = nonEmpty(relation.toMemoryId, "toMemoryId");
  if (fromMemoryId === toMemoryId) {
    throw namedError("MemoryTemporalRelationSelfReference");
  }
  return Object.freeze({
    schemaVersion: PAW_MEMORY_TEMPORAL_GRAPH_VERSION_V1,
    id: nonEmpty(relation.id, "id"),
    fromMemoryId,
    toMemoryId,
    relationType,
    status,
    sourceRefs: stableRefs(arrayValue(relation.sourceRefs)),
    evidenceRefs: stableRefs(arrayValue(relation.evidenceRefs)),
    createdAt,
    updatedAt,
  });
}

function parseRefs(value: unknown): readonly string[] {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  return arrayValue(parsed);
}

function arrayValue(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw namedError("MemoryTemporalRelationRefsInvalid");
  }
  return value as string[];
}

function stableRefs(values: readonly string[]): readonly string[] {
  const result = [
    ...new Set(values.map((value) => nonEmpty(value, "ref"))),
  ].sort((left, right) => left.localeCompare(right));
  if (result.length > 128)
    throw namedError("MemoryTemporalRelationRefsInvalid");
  return Object.freeze(result);
}

function assertRelationType(
  value: unknown,
): asserts value is MemoryTemporalRelationTypeV1 {
  if (
    value !== "supersedes" &&
    value !== "supports" &&
    value !== "contradicts" &&
    value !== "derived_from"
  ) {
    throw namedError("MemoryTemporalRelationTypeInvalid");
  }
}

function assertRelationStatus(
  value: unknown,
): asserts value is MemoryTemporalRelationStatusV1 {
  if (value !== "active" && value !== "retracted") {
    throw namedError("MemoryTemporalRelationStatusInvalid");
  }
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 8_192) {
    throw namedError(`MemoryTemporalRelation${field}Invalid`);
  }
  return value.trim();
}

function isoTime(value: unknown, field: string): string {
  const text = nonEmpty(value, field);
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) {
    throw namedError(`MemoryTemporalRelation${field}Invalid`);
  }
  return new Date(timestamp).toISOString();
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function boundedLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 4_096) {
    throw namedError("MemoryTemporalRelationLimitInvalid");
  }
  return value;
}

function emit(
  observer: ((event: MemoryTemporalGraphEventV1) => void) | undefined,
  event: MemoryTemporalGraphEventV1,
): void {
  try {
    observer?.(Object.freeze(event));
  } catch {
    // Observability must never affect memory correctness.
  }
}

function abortError(): Error {
  const error = new Error("Memory temporal graph operation aborted");
  error.name = "AbortError";
  return error;
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
