import { getSql } from "@paw/memory/db";

import {
  type PawNextMemoryScopeV1,
  memoryScopeFingerprintV1,
} from "./profile.js";
import {
  type MemoryTopicDossierV1,
  PAW_MEMORY_TOPIC_DOSSIER_EXTRACTOR_VERSION_V1,
  PAW_MEMORY_TOPIC_DOSSIER_POLICY_VERSION_V1,
  assertMemoryTopicDossierIntegrityV1,
} from "./topic-dossier.js";

export interface MemoryTopicDossierStoreEventV1 {
  readonly schemaVersion: "paw.memory-topic-dossier-store-event.v1";
  readonly type: "get" | "put";
  readonly scopeFingerprint: string;
  readonly found?: boolean;
  readonly inserted?: boolean;
  readonly durationMs: number;
}

export interface MemoryTopicDossierStoreV1 {
  readonly scope: PawNextMemoryScopeV1;
  getExact(
    key: Readonly<{
      topicId: string;
      projectionHash: string;
      policyVersion: string;
      extractorVersion: string;
    }>,
    signal: AbortSignal,
  ): Promise<MemoryTopicDossierV1 | undefined>;
  getCurrent(
    topicId: string,
    signal: AbortSignal,
  ): Promise<MemoryTopicDossierV1 | undefined>;
  put(
    dossier: MemoryTopicDossierV1,
    signal: AbortSignal,
  ): Promise<Readonly<{ inserted: boolean }>>;
}

export function createPostgresMemoryTopicDossierStoreV1(
  input: Readonly<{
    scope: PawNextMemoryScopeV1;
    onEvent?: (event: MemoryTopicDossierStoreEventV1) => void;
  }>,
): MemoryTopicDossierStoreV1 {
  const scope = Object.freeze({ ...input.scope });
  const scopeFingerprint = memoryScopeFingerprintV1(scope);

  return Object.freeze({
    scope,
    async getExact(
      key: Parameters<MemoryTopicDossierStoreV1["getExact"]>[0],
      signal: AbortSignal,
    ) {
      const started = Date.now();
      if (signal.aborted) throw abortError();
      const sql = getSql();
      const rows = await sql`
        SELECT dossier.payload
        FROM memory_topic_dossiers dossier
        JOIN memory_topics topic ON topic.id = dossier.topic_id
        WHERE dossier.topic_id = ${bounded(key.topicId, 256, "MemoryTopicDossierTopicInvalid")}
          AND dossier.projection_hash = ${bounded(key.projectionHash, 256, "MemoryTopicDossierProjectionInvalid")}
          AND dossier.policy_version = ${bounded(key.policyVersion, 256, "MemoryTopicDossierPolicyInvalid")}
          AND dossier.extractor_version = ${bounded(key.extractorVersion, 256, "MemoryTopicDossierExtractorInvalid")}
          AND dossier.scope_fingerprint = ${scopeFingerprint}
          AND topic.scope->>'tenantId' = ${scope.tenantId}
          AND topic.scope->>'userId' = ${scope.userId}
          AND topic.scope->>'workspaceId' = ${scope.workspaceId}
          AND topic.scope->>'repositoryId' = ${scope.repositoryId}
        LIMIT 1
      `;
      const dossier = rows[0]
        ? parseDossier((rows[0] as { payload?: unknown }).payload)
        : undefined;
      emit(input.onEvent, {
        schemaVersion: "paw.memory-topic-dossier-store-event.v1",
        type: "get",
        scopeFingerprint,
        found: dossier !== undefined,
        durationMs: Date.now() - started,
      });
      return dossier;
    },

    async getCurrent(topicId: string, signal: AbortSignal) {
      const started = Date.now();
      if (signal.aborted) throw abortError();
      const sql = getSql();
      const rows = await sql`
        SELECT dossier.payload
        FROM memory_topics topic
        JOIN memory_topic_dossiers dossier
          ON dossier.topic_id = topic.id
         AND dossier.projection_hash = topic.projection_hash
        WHERE topic.id = ${bounded(topicId, 256, "MemoryTopicDossierTopicInvalid")}
          AND dossier.scope_fingerprint = ${scopeFingerprint}
          AND dossier.policy_version = ${PAW_MEMORY_TOPIC_DOSSIER_POLICY_VERSION_V1}
          AND dossier.extractor_version = ${PAW_MEMORY_TOPIC_DOSSIER_EXTRACTOR_VERSION_V1}
          AND topic.scope->>'tenantId' = ${scope.tenantId}
          AND topic.scope->>'userId' = ${scope.userId}
          AND topic.scope->>'workspaceId' = ${scope.workspaceId}
          AND topic.scope->>'repositoryId' = ${scope.repositoryId}
          AND topic.status = 'active'
        ORDER BY dossier.created_at DESC, dossier.id ASC
        LIMIT 1
      `;
      const dossier = rows[0]
        ? parseDossier((rows[0] as { payload?: unknown }).payload)
        : undefined;
      emit(input.onEvent, {
        schemaVersion: "paw.memory-topic-dossier-store-event.v1",
        type: "get",
        scopeFingerprint,
        found: dossier !== undefined,
        durationMs: Date.now() - started,
      });
      return dossier;
    },

    async put(dossier: MemoryTopicDossierV1, signal: AbortSignal) {
      const started = Date.now();
      if (signal.aborted) throw abortError();
      assertMemoryTopicDossierIntegrityV1(dossier);
      if (dossier.scopeFingerprint !== scopeFingerprint) {
        throw namedError("MemoryTopicDossierStoreScopeMismatch");
      }
      const sql = getSql();
      const rows = await sql`
        INSERT INTO memory_topic_dossiers (
          id, schema_version, topic_id, scope_fingerprint, projection_hash,
          graph_revision, policy_version, extractor_version, proposal_hash,
          payload, created_at
        )
        SELECT
          ${dossier.id}, ${dossier.schemaVersion}, ${dossier.topicId},
          ${dossier.scopeFingerprint}, ${dossier.projectionHash},
          ${dossier.graphRevision}, ${dossier.policyVersion},
          ${dossier.extractorVersion}, ${dossier.proposalHash},
          ${sql.json(dossier as never)}, ${dossier.createdAt}
        FROM memory_topics topic
        WHERE topic.id = ${dossier.topicId}
          AND topic.projection_hash = ${dossier.projectionHash}
          AND topic.scope->>'tenantId' = ${scope.tenantId}
          AND topic.scope->>'userId' = ${scope.userId}
          AND topic.scope->>'workspaceId' = ${scope.workspaceId}
          AND topic.scope->>'repositoryId' = ${scope.repositoryId}
        ON CONFLICT (topic_id, projection_hash, policy_version, extractor_version)
        DO NOTHING
        RETURNING id
      `;
      const inserted = rows.length === 1;
      if (!inserted) {
        const existing = await this.getExact(
          {
            topicId: dossier.topicId,
            projectionHash: dossier.projectionHash,
            policyVersion: dossier.policyVersion,
            extractorVersion: dossier.extractorVersion,
          },
          signal,
        );
        if (!existing) {
          throw namedError("MemoryTopicDossierStoreProjectionMismatch");
        }
      }
      emit(input.onEvent, {
        schemaVersion: "paw.memory-topic-dossier-store-event.v1",
        type: "put",
        scopeFingerprint,
        inserted,
        durationMs: Date.now() - started,
      });
      return Object.freeze({ inserted });
    },
  });
}

function parseDossier(value: unknown): MemoryTopicDossierV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw namedError("MemoryTopicDossierStoredPayloadInvalid");
  }
  const dossier = value as MemoryTopicDossierV1;
  assertMemoryTopicDossierIntegrityV1(dossier);
  return Object.freeze(dossier);
}

function bounded(value: string, max: number, errorName: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw namedError(errorName);
  return normalized;
}

function emit(
  observer: ((event: MemoryTopicDossierStoreEventV1) => void) | undefined,
  event: MemoryTopicDossierStoreEventV1,
): void {
  try {
    observer?.(Object.freeze(event));
  } catch {
    // Observability cannot affect dossier durability.
  }
}

function abortError(): Error {
  const error = new Error("Memory topic dossier store operation aborted");
  error.name = "AbortError";
  return error;
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
