import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";

import type { SessionInputSnapshot } from "@paw/agent-loop";

import {
  MEMORY_RRF_TEXT_WEIGHT_V1,
  MEMORY_RRF_VECTOR_WEIGHT_V1,
  type MemoryAtomWriterStoreV1,
  type MemoryContextResolverV1,
  type MemoryConversationTurnKindV1,
  type MemoryEvidenceCandidateRankListV2,
  type MemoryEvidenceNotebookHitV1,
  type MemoryEvidenceSupportVerifierV1,
  type MemoryPersonaProjectionV1,
  type MemoryProviderResultV1,
  type MemoryProviderV1,
  type MemoryRawEvidenceArchiveV1,
  type MemoryRetrievalCacheEventV1,
  type MemoryRrfFusionEventV1,
  type MemorySceneSnapshotV1,
  type MemorySourceLocalEvidenceRequestV1,
  type MemorySourceLocalEvidenceResultV1,
  type MemoryTopicDossierProjectorV1,
  type MemoryTopicDossierStoreV1,
  type MemoryTopicEvidenceStoreV1,
  type MemoryTopicOrganizerStoreV1,
  type MemoryWriterModelV1,
  PAW_MEMORY_ATOM_CONFLICT_RESOLVER_VERSION_V1,
  PAW_MEMORY_ATOM_EXTRACTOR_VERSION_V1,
  PAW_MEMORY_CONVERSATION_BUNDLE_POLICY_VERSION_V1,
  PAW_MEMORY_EVIDENCE_CANDIDATE_FUSION_VERSION_V2,
  PAW_MEMORY_EVIDENCE_NOTEBOOK_POLICY_VERSION_V1,
  PAW_MEMORY_TOPIC_DOSSIER_EXTRACTOR_VERSION_V1,
  PAW_MEMORY_TOPIC_DOSSIER_POLICY_VERSION_V1,
  PAW_NEXT_MEMORY_PLUGIN_POLICY_VERSION_V1,
  PAW_NEXT_MEMORY_RRF_PROVIDER_VERSION_V1,
  PAW_NEXT_MEMORY_V2_PROVIDER_VERSION_V1,
  type PawNextMemoryPluginProfileV1,
  type PawNextMemoryScopeV1,
  boundMemoryRawEvidenceSpansV1,
  buildMemoryConversationTurnBundleV1,
  classifyMemoryEvidenceQueryV3,
  createJsonMemoryAtomConflictResolverV1,
  createJsonMemoryAtomExtractorV1,
  createJsonMemoryEvidenceClosureAuditorV1,
  createJsonMemoryEvidenceCoveragePlannerV1,
  createJsonMemoryEvidenceQueryPlannerV3,
  createJsonMemoryEvidenceSupportSelectorV1,
  createJsonMemoryEvidenceSupportVerifierV1,
  createJsonMemoryTopicDossierExtractorV1,
  createJsonMemoryTopicExtractorV1,
  createMemoryAtomWriterStoreV1,
  createMemoryContextResolverV1,
  createMemoryEvidenceResolverV1,
  createMemoryRetrievalCacheStoreV1,
  createMemorySceneSnapshotV1,
  createMemoryTopicDossierProjectorV1,
  createOpenAICompatibleMemoryEmbeddingServiceV1,
  createPartitionedHybridMemoryEmbeddingServiceV1,
  createPawNextMemoryRrfPostgresProviderV1,
  createPawNextMemoryV2PostgresProviderV1,
  createPostgresMemoryRawEvidenceArchiveV1,
  createPostgresMemoryTopicDossierStoreV1,
  createPostgresMemoryTopicEvidenceStoreV1,
  createPostgresMemoryTopicOrganizerStoreV1,
  hasMemorySourceLocalDialogueCertificateV1,
  memoryScopeFingerprintV1,
  memorySourceLocalEvidenceCacheKeyV1,
  needsMemoryEvidenceRoleResolutionV1,
  planMemoryEvidenceCoverageV1,
  planMemoryTopicEvidenceV1,
  projectEvidenceFirstMemoryAnswerContractV1,
  projectEvidenceFirstMemoryContextPacketV1,
  projectMemoryPersonaEvidenceV1,
  projectMemoryResolvedContextToolV1,
  projectMemoryTopicDossierToolV1,
  projectMemoryTopicToolStatesV1,
  projectSourceGroundedMemoryScenesV1,
  projectSourceGroundedPersonaV1,
  reciprocalRankFusionV1,
  reconcileMemoryAtomsV1,
  resolveMemoryTopicIdV1,
  routeMemoryQueryV1,
  selectMemorySceneEvidenceV1,
} from "@paw/memory-plugin";
import {
  type EpisodicExperience,
  type MemoryEntry,
  PostgresMemoryStoreEngine,
} from "@paw/memory/longterm";
import type { InputFactV1 } from "@paw/protocol";
import { closeSql, getSql } from "../../packages/memory/src/db/connection.js";
import {
  type AmbMemoryLlmPurposeV1,
  type AtomIngestCheckpointStoreV1,
  createAmbMemoryLlmBudgetPortfolioV1,
  createAtomIngestCheckpointStoreV1,
  parseAmbCachedMemoryUsageV1,
  projectAmbMemoryEvidenceV1,
  readAmbMemoryLlmBudgetLimitsV1,
  runKeyedInOrderV1,
  selectAmbSourceChunksV1,
  selectAmbSourceEvidenceV1,
} from "./atom-ingest-control.js";
import { decideAmbEmbeddingPrewarmV1 } from "./embedding-prewarm-policy.js";
import {
  planAmbEmbeddingWavesV1,
  streamAmbEmbeddingBatchesV1,
} from "./embedding-stream.js";
import {
  immutableSourceTurnEvidenceRefV1,
  legacyImmutableTurnEvidenceRefV1,
  logicalSourceLocalEvidenceRefV1,
} from "./immutable-evidence-address.js";
import { buildAmbMemoryLlmReplayCacheKeyV1 } from "./memory-llm-replay-cache.js";
import {
  isAmbDocumentVisibleAtQueryV1,
  parseAmbQueryTimeCutoffV1,
} from "./query-time-cutoff.js";

interface BridgeRequestV1 {
  readonly id: number;
  readonly method: "prepare" | "ingest" | "retrieve" | "stats" | "cleanup";
  readonly params?: Record<string, unknown>;
}

interface AmbDocumentV1 {
  readonly id: string;
  readonly content: string;
  readonly user_id?: string | null;
  readonly timestamp?: string | null;
}

interface NormalizedAmbDocumentV1 {
  readonly id: string;
  readonly content: string;
  readonly userId: string;
  readonly created: string;
}

const logPath = resolve(
  process.env.PAW_AMB_LOG ?? "logs/amb/paw-memory-bridge.jsonl",
);
mkdirSync(dirname(logPath), { recursive: true });

const cache = createMemoryRetrievalCacheStoreV1({ maxEntries: 2_048 });
const engines = new Map<string, PostgresMemoryStoreEngine>();
const sourceEngines = new Map<string, PostgresMemoryStoreEngine>();
const sourceLocalLocatorCache = new Map<
  string,
  MemorySourceLocalEvidenceResultV1
>();
const sourceChunkEngines = new Map<string, PostgresMemoryStoreEngine>();
const providers = new Map<string, MemoryProviderV1>();
const atomStores = new Map<string, MemoryAtomWriterStoreV1>();
const topicOrganizerStores = new Map<string, MemoryTopicOrganizerStoreV1>();
const topicEvidenceStores = new Map<string, MemoryTopicEvidenceStoreV1>();
const topicDossierStores = new Map<string, MemoryTopicDossierStoreV1>();
const topicDossierProjectors = new Map<string, MemoryTopicDossierProjectorV1>();
const contextResolvers = new Map<string, MemoryContextResolverV1>();
const rawEvidenceArchives = new Map<string, MemoryRawEvidenceArchiveV1>();
const documentIdsByUser = new Map<string, Set<string>>();
const documentCreatedByUser = new Map<string, Map<string, string>>();
const documentOrderByUser = new Map<string, Map<string, number>>();
const sourceBlockIdsByUserDocument = new Map<
  string,
  Map<string, readonly string[]>
>();
const sourceKindByUser = new Map<
  string,
  Map<string, MemoryConversationTurnKindV1>
>();
const sceneSnapshots = new Map<
  string,
  {
    revision: string;
    snapshot: MemorySceneSnapshotV1;
    persona: MemoryPersonaProjectionV1;
  }
>();
const routeStats = {
  l0Fallback: 0,
  sceneCausal: 0,
  sceneExploratory: 0,
  sceneReads: 0,
  selectedAtoms: 0,
  dynamicChars: 0,
  personaInjections: 0,
};
let pendingCacheEvents: MemoryRetrievalCacheEventV1[] = [];
let runKey = "unprepared";
let resetOnFirstIngest = false;
const resetUsers = new Set<string>();
const retrievalPolicy =
  process.env.PAW_AMB_RETRIEVAL_POLICY === "legacy" ? "legacy" : "rrf";
const ingestMode =
  process.env.PAW_AMB_INGEST_MODE?.trim().toLowerCase() === "atom"
    ? "atom"
    : "raw_chunk";
const atomContextMode = (() => {
  const value = process.env.PAW_AMB_ATOM_CONTEXT_MODE?.trim().toLowerCase();
  if (!value || value === "atom_only") return "atom_only" as const;
  if (value === "source_expand") return "source_expand" as const;
  if (value === "hybrid") return "hybrid" as const;
  if (value === "scene_hybrid") return "scene_hybrid" as const;
  if (value === "scene_routed") return "scene_routed" as const;
  if (value === "evidence_first") return "evidence_first" as const;
  if (value === "topic_evidence") return "topic_evidence" as const;
  if (value === "tool_driven") return "tool_driven" as const;
  throw new Error("PAW_AMB_ATOM_CONTEXT_MODE is invalid");
})();
const atomSourceContextMaxChars = readBoundedInteger(
  process.env.PAW_AMB_ATOM_SOURCE_MAX_CHARS,
  14_000,
  1_024,
  64_000,
  "PAW_AMB_ATOM_SOURCE_MAX_CHARS",
);
const atomSceneContextMaxChars = readBoundedInteger(
  process.env.PAW_AMB_ATOM_SCENE_MAX_CHARS,
  7_500,
  1_024,
  64_000,
  "PAW_AMB_ATOM_SCENE_MAX_CHARS",
);
const atomSceneIndexMaxChars = readBoundedInteger(
  process.env.PAW_AMB_ATOM_SCENE_INDEX_MAX_CHARS,
  4_096,
  512,
  32_768,
  "PAW_AMB_ATOM_SCENE_INDEX_MAX_CHARS",
);
const atomPersonaMaxChars = readBoundedInteger(
  process.env.PAW_AMB_ATOM_PERSONA_MAX_CHARS,
  4_000,
  512,
  16_000,
  "PAW_AMB_ATOM_PERSONA_MAX_CHARS",
);
const providerVersion =
  retrievalPolicy === "rrf"
    ? PAW_NEXT_MEMORY_RRF_PROVIDER_VERSION_V1
    : PAW_NEXT_MEMORY_V2_PROVIDER_VERSION_V1;
const memoryLlmBudgetLimits = readAmbMemoryLlmBudgetLimitsV1();
const atomLimits = memoryLlmBudgetLimits["memory-write"];
const memoryLlmBudgets = createAmbMemoryLlmBudgetPortfolioV1(
  memoryLlmBudgetLimits,
);
const atomBudget = memoryLlmBudgets.budgetFor("memory-write");
const atomResume = /^(?:1|true)$/i.test(
  process.env.PAW_AMB_ATOM_RESUME?.trim() ?? "",
);
const reuseIndex = /^(?:1|true)$/i.test(
  process.env.PAW_AMB_REUSE_INDEX?.trim() ?? "",
);
if (reuseIndex && !atomResume) {
  throw new Error("PAW_AMB_REUSE_INDEX requires PAW_AMB_ATOM_RESUME");
}
const atomWriteMode = (() => {
  if (ingestMode !== "atom") return "off" as const;
  const value = process.env.PAW_AMB_ATOM_WRITE_MODE?.trim().toLowerCase();
  if (!value || value === "full") return "full" as const;
  if (value === "index") return "index" as const;
  if (value === "off") return "off" as const;
  throw new Error("PAW_AMB_ATOM_WRITE_MODE is invalid");
})();
const atomMaxOutputTokens = 4_096;
const atomWriterIdentityHash = sha(
  JSON.stringify({
    policy: "paw.amb-memory-write-cache.v1",
    writeMode: atomWriteMode,
    extractor: PAW_MEMORY_ATOM_EXTRACTOR_VERSION_V1,
    conflictResolver:
      atomWriteMode === "full"
        ? PAW_MEMORY_ATOM_CONFLICT_RESOLVER_VERSION_V1
        : null,
    repairPolicy: "paw.memory-atom-repair-once.v1",
    promptSchema: "paw.memory-atom-extraction-input.v2",
    model: process.env.DEEPSEEK_MODEL?.trim() || "deepseek-v4-flash",
    baseUrl: (
      process.env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com"
    ).replace(/\/+$/, ""),
    evidenceProjection: "system-user-only.v1",
    maxWindowChars: 24_000,
    temperature: 0,
    thinking: "disabled",
    maxTokens: atomMaxOutputTokens,
    rawEvidenceArchive: "paw.memory-raw-evidence-span.v1",
    topicDossierPolicy: PAW_MEMORY_TOPIC_DOSSIER_POLICY_VERSION_V1,
    topicDossierExtractor: PAW_MEMORY_TOPIC_DOSSIER_EXTRACTOR_VERSION_V1,
  }),
);
let atomCheckpoint: AtomIngestCheckpointStoreV1 | undefined;
const embeddingBaseUrl = process.env.PAW_AMB_EMBEDDING_BASE_URL?.trim();
const embeddingCacheMaxEntries = readBoundedInteger(
  process.env.PAW_AMB_EMBEDDING_CACHE_ENTRIES,
  2_048,
  64,
  8_192,
  "PAW_AMB_EMBEDDING_CACHE_ENTRIES",
);
const embeddingMaxAttempts = readBoundedInteger(
  process.env.PAW_AMB_EMBEDDING_MAX_ATTEMPTS,
  3,
  1,
  5,
  "PAW_AMB_EMBEDDING_MAX_ATTEMPTS",
);
const embeddingRetryBaseDelayMs = readBoundedInteger(
  process.env.PAW_AMB_EMBEDDING_RETRY_BASE_MS,
  200,
  0,
  5_000,
  "PAW_AMB_EMBEDDING_RETRY_BASE_MS",
);
const embeddingStreamBatchSize = readBoundedInteger(
  process.env.PAW_AMB_EMBEDDING_STREAM_BATCH_SIZE,
  64,
  1,
  64,
  "PAW_AMB_EMBEDDING_STREAM_BATCH_SIZE",
);
const embeddingStoreConcurrency = readBoundedInteger(
  process.env.PAW_AMB_EMBEDDING_STORE_CONCURRENCY,
  8,
  1,
  8,
  "PAW_AMB_EMBEDDING_STORE_CONCURRENCY",
);
if (embeddingBaseUrl && retrievalPolicy !== "rrf") {
  throw new Error("Dense embedding is supported only by the RRF AMB policy");
}
const embeddingMode = embeddingBaseUrl
  ? process.env.PAW_AMB_EMBEDDING_MODE?.trim() || "dense"
  : "off";
if (!new Set(["off", "dense", "hybrid_partitioned"]).has(embeddingMode)) {
  throw new Error("PAW_AMB_EMBEDDING_MODE is invalid");
}
const denseEmbedding = embeddingBaseUrl
  ? createOpenAICompatibleMemoryEmbeddingServiceV1({
      baseUrl: embeddingBaseUrl,
      apiKey: process.env.PAW_AMB_EMBEDDING_API_KEY,
      model:
        process.env.PAW_AMB_EMBEDDING_MODEL?.trim() ||
        "sentence-transformers/all-MiniLM-L6-v2+zero-pad-1536",
      version: process.env.PAW_AMB_EMBEDDING_VERSION?.trim() || "main",
      dimensions: 1_536,
      requestDimensions: false,
      maxCacheEntries: embeddingCacheMaxEntries,
      maxAttempts: embeddingMaxAttempts,
      retryBaseDelayMs: embeddingRetryBaseDelayMs,
      onEvent(event) {
        log("embedding", event);
      },
    })
  : undefined;
const embedding =
  embeddingMode === "off"
    ? undefined
    : denseEmbedding && embeddingMode === "hybrid_partitioned"
      ? createPartitionedHybridMemoryEmbeddingServiceV1({
          dense: denseEmbedding,
          denseSignalDimensions: Number(
            process.env.PAW_AMB_EMBEDDING_DENSE_DIMENSIONS ?? 384,
          ),
          denseWeight: Number(
            process.env.PAW_AMB_EMBEDDING_DENSE_WEIGHT ?? 0.25,
          ),
        })
      : denseEmbedding;
const denseIndexLevel = embedding
  ? process.env.PAW_AMB_DENSE_INDEX_LEVEL?.trim() || "turn"
  : "off";
if (!new Set(["off", "turn", "chunk", "both"]).has(denseIndexLevel)) {
  throw new Error("PAW_AMB_DENSE_INDEX_LEVEL is invalid");
}
const sourceSpanEmbedding =
  embedding && (denseIndexLevel === "turn" || denseIndexLevel === "both")
    ? embedding
    : undefined;
const sourceChunkEmbedding =
  embedding && (denseIndexLevel === "chunk" || denseIndexLevel === "both")
    ? embedding
    : undefined;
const atomExtractor =
  ingestMode === "atom" && atomWriteMode !== "off"
    ? createJsonMemoryAtomExtractorV1({ model: createAmbMemoryWriterModel() })
    : undefined;
const atomConflictResolver =
  ingestMode === "atom" && atomWriteMode === "full"
    ? createJsonMemoryAtomConflictResolverV1({
        model: createAmbMemoryWriterModel(),
      })
    : undefined;
const topicExtractor =
  ingestMode === "atom" &&
  (atomContextMode === "topic_evidence" || atomContextMode === "tool_driven")
    ? createJsonMemoryTopicExtractorV1({ model: createAmbMemoryWriterModel() })
    : undefined;
const topicDossierExtractor =
  ingestMode === "atom" && atomContextMode === "tool_driven"
    ? createJsonMemoryTopicDossierExtractorV1({
        model: createAmbMemoryWriterModel(),
      })
    : undefined;
const coveragePlanner =
  ingestMode === "atom" &&
  (atomContextMode === "topic_evidence" || atomContextMode === "tool_driven")
    ? createJsonMemoryEvidenceCoveragePlannerV1({
        model: createAmbMemoryWriterModel("query-plan"),
      })
    : undefined;
const supportVerifier: MemoryEvidenceSupportVerifierV1 | undefined =
  ingestMode === "atom" && atomContextMode === "tool_driven"
    ? createJsonMemoryEvidenceSupportVerifierV1({
        model: createAmbMemoryWriterModel("evidence-support"),
      })
    : undefined;
const evidenceQueryPlanner =
  ingestMode === "atom" &&
  atomContextMode === "evidence_first" &&
  /^(?:1|true)$/iu.test(process.env.PAW_AMB_QUERY_EXPANSION?.trim() ?? "")
    ? createJsonMemoryEvidenceQueryPlannerV3({
        model: createAmbMemoryWriterModel("query-plan"),
      })
    : undefined;
const evidenceSupportSelector =
  ingestMode === "atom" &&
  atomContextMode === "evidence_first" &&
  /^(?:1|true)$/iu.test(process.env.PAW_AMB_QUERY_EXPANSION?.trim() ?? "")
    ? createJsonMemoryEvidenceSupportSelectorV1({
        model: createAmbMemoryWriterModel("evidence-support"),
      })
    : undefined;
const evidenceClosureAuditor =
  ingestMode === "atom" &&
  atomContextMode === "evidence_first" &&
  /^(?:1|true)$/iu.test(process.env.PAW_AMB_CLOSURE_AUDIT?.trim() ?? "")
    ? createJsonMemoryEvidenceClosureAuditorV1({
        model: createAmbMemoryWriterModel("closure-audit"),
      })
    : undefined;
const sourceLocalLocatorEnabled =
  ingestMode === "atom" &&
  atomContextMode === "evidence_first" &&
  /^(?:1|true)$/iu.test(process.env.PAW_AMB_SOURCE_LOCAL_LOCATOR?.trim() ?? "");

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function contentFreeSourceHashes(
  sourceIds: Iterable<string>,
): readonly string[] {
  return Object.freeze(
    [...new Set(sourceIds)]
      .sort()
      .map((sourceId) => sha(sourceId).slice(0, 20)),
  );
}

function createAmbMemoryWriterModel(
  purpose: AmbMemoryLlmPurposeV1 = "memory-write",
): MemoryWriterModelV1 {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "DEEPSEEK_API_KEY is required for PAW_AMB_INGEST_MODE=atom",
    );
  }
  const model = process.env.DEEPSEEK_MODEL?.trim() || "deepseek-v4-flash";
  const baseUrl = (
    process.env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com"
  ).replace(/\/+$/, "");
  const cacheDir = resolve(
    process.env.PAW_AMB_LLM_CACHE_DIR ?? "benchmarks/amb/runs/.llm-cache-t0",
    purpose,
  );
  const sourceArtifactSha256 =
    process.env.PAW_AMB_SOURCE_ARTIFACT_SHA256?.trim() || "unbound-development";
  const purposeBudget = memoryLlmBudgets.budgetFor(purpose);
  mkdirSync(cacheDir, { recursive: true });
  return Object.freeze({
    async complete(
      request: Parameters<MemoryWriterModelV1["complete"]>[0],
      options: Parameters<MemoryWriterModelV1["complete"]>[1],
    ) {
      const promptHash = sha(
        JSON.stringify({ system: request.system, user: request.user }),
      );
      const cacheKey = buildAmbMemoryLlmReplayCacheKeyV1({
        purpose,
        model,
        baseUrl,
        promptHash,
        maxTokens: atomMaxOutputTokens,
      });
      const cachePath = resolve(cacheDir, `${cacheKey}.json`);
      if (existsSync(cachePath)) {
        try {
          const cached = JSON.parse(readFileSync(cachePath, "utf8")) as {
            schemaVersion?: unknown;
            text?: unknown;
            usage?: unknown;
          };
          if (typeof cached.text === "string") {
            const usage = parseAmbCachedMemoryUsageV1(cached.usage);
            purposeBudget.recordCacheHit(usage ?? undefined);
            log("memory_llm_settlement", {
              purpose,
              model,
              promptHash,
              cacheHit: true,
              status: "completed",
              durationMs: 0,
              promptTokens: 0,
              completionTokens: 0,
              cachedOriginPromptTokens: usage?.promptTokens ?? null,
              cachedOriginCompletionTokens: usage?.completionTokens ?? null,
              cachedOriginProviderCacheHitTokens:
                usage?.providerCacheHitTokens ?? null,
              cachedOriginProviderCacheMissTokens:
                usage?.providerCacheMissTokens ?? null,
              costEvidenceComplete: usage !== null,
              budgetScope: purpose,
              budget: purposeBudget.snapshot(),
            });
            return { status: "completed" as const, text: cached.text };
          }
        } catch {
          // Invalid cache entries are ignored and replaced after a successful call.
        }
      }
      const started = performance.now();
      let reservation:
        | ReturnType<typeof purposeBudget.reserveRemoteCall>
        | undefined;
      try {
        reservation = purposeBudget.reserveRemoteCall({
          promptTokenUpperBound:
            Buffer.byteLength(
              JSON.stringify({ system: request.system, user: request.user }),
              "utf8",
            ) + 256,
          completionTokenUpperBound: atomMaxOutputTokens,
        });
        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: request.system },
              { role: "user", content: request.user },
            ],
            response_format: { type: "json_object" },
            temperature: 0,
            max_tokens: atomMaxOutputTokens,
            thinking: { type: "disabled" },
          }),
          signal: options.signal,
        });
        if (!response.ok) {
          throw Object.assign(new Error("MemoryWriterHttpError"), {
            name: `MemoryWriterHttp${response.status}`,
          });
        }
        const payload = (await response.json()) as {
          choices?: Array<{
            finish_reason?: string;
            message?: { content?: string };
          }>;
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            prompt_cache_hit_tokens?: number;
            prompt_cache_miss_tokens?: number;
          };
        };
        const choice = payload.choices?.[0];
        const text = choice?.message?.content;
        const usage = Object.freeze({
          promptTokens: payload.usage?.prompt_tokens ?? 0,
          completionTokens: payload.usage?.completion_tokens ?? 0,
          providerCacheHitTokens: payload.usage?.prompt_cache_hit_tokens ?? 0,
          providerCacheMissTokens: payload.usage?.prompt_cache_miss_tokens ?? 0,
        });
        purposeBudget.settleRemoteCall(reservation, {
          ...usage,
        });
        reservation = undefined;
        if (
          choice?.finish_reason === "length" ||
          choice?.finish_reason === "max_tokens"
        ) {
          log("memory_llm_settlement", {
            purpose,
            model,
            promptHash,
            cacheHit: false,
            status: "truncated",
            durationMs: Math.max(0, performance.now() - started),
            promptTokens: payload.usage?.prompt_tokens ?? 0,
            completionTokens: payload.usage?.completion_tokens ?? 0,
            budgetScope: purpose,
            budget: purposeBudget.snapshot(),
          });
          return {
            status: "truncated" as const,
            errorCode: "MemoryWriterModelTruncated",
          };
        }
        if (typeof text !== "string" || !text.trim()) {
          const error = new Error("MemoryWriterEmptyResponse");
          error.name = "MemoryWriterEmptyResponse";
          throw error;
        }
        const tempPath = `${cachePath}.${process.pid}.tmp`;
        writeFileSync(
          tempPath,
          JSON.stringify({
            schemaVersion: "paw.amb-memory-llm-cache-entry.v1",
            text,
            usage,
            sourceArtifactSha256,
          }),
          "utf8",
        );
        renameSync(tempPath, cachePath);
        log("memory_llm_settlement", {
          purpose,
          model,
          promptHash,
          cacheHit: false,
          status: "completed",
          durationMs: Math.max(0, performance.now() - started),
          ...usage,
          budgetScope: purpose,
          budget: purposeBudget.snapshot(),
        });
        return { status: "completed" as const, text };
      } catch (error) {
        if (reservation) purposeBudget.releaseRemoteCall(reservation);
        const cancelled = options.signal.aborted;
        const errorCode = cancelled
          ? "MemoryWriterModelCancelled"
          : error instanceof Error
            ? error.name
            : "MemoryWriterModelUnknown";
        log("memory_llm_settlement", {
          purpose,
          model,
          promptHash,
          cacheHit: false,
          status: cancelled ? "cancelled" : "failed",
          errorCode,
          durationMs: Math.max(0, performance.now() - started),
          budgetScope: purpose,
          budget: purposeBudget.snapshot(),
        });
        return cancelled
          ? { status: "cancelled" as const, errorCode }
          : { status: "failed" as const, errorCode };
      }
    },
  });
}

function scopeFor(userId: string): PawNextMemoryScopeV1 {
  const safeUser = userId.slice(0, 240) || "default";
  return Object.freeze({
    tenantId: "amb",
    userId: safeUser,
    workspaceId: `amb-run-${runKey}`,
    repositoryId: `amb-personamem-${runKey}`,
  });
}

function sourceScopeFor(userId: string): PawNextMemoryScopeV1 {
  const scope = scopeFor(userId);
  return Object.freeze({
    ...scope,
    repositoryId: `amb-personamem-source-${runKey}`,
  });
}

function sourceChunkScopeFor(userId: string): PawNextMemoryScopeV1 {
  const scope = scopeFor(userId);
  return Object.freeze({
    ...scope,
    repositoryId: `amb-personamem-source-chunks-${runKey}`,
  });
}

function engineFor(userId: string): PostgresMemoryStoreEngine {
  let engine = engines.get(userId);
  if (!engine) {
    engine = new PostgresMemoryStoreEngine(
      scopeFor(userId),
      embedding ? { embedding } : {},
    );
    engines.set(userId, engine);
  }
  return engine;
}

function sourceEngineFor(userId: string): PostgresMemoryStoreEngine {
  let engine = sourceEngines.get(userId);
  if (!engine) {
    engine = new PostgresMemoryStoreEngine(
      sourceScopeFor(userId),
      sourceSpanEmbedding ? { embedding: sourceSpanEmbedding } : {},
    );
    sourceEngines.set(userId, engine);
  }
  return engine;
}

function sourceChunkEngineFor(userId: string): PostgresMemoryStoreEngine {
  let engine = sourceChunkEngines.get(userId);
  if (!engine) {
    engine = new PostgresMemoryStoreEngine(
      sourceChunkScopeFor(userId),
      sourceChunkEmbedding ? { embedding: sourceChunkEmbedding } : {},
    );
    sourceChunkEngines.set(userId, engine);
  }
  return engine;
}

function sourceBlockId(
  userId: string,
  documentId: string,
  seq: number,
): string {
  return `episodic-source-${sha(
    `source-block-v1\n${runKey}\n${userId}\n${documentId}\n${seq}`,
  ).slice(0, 16)}`;
}

function sourceChunkId(
  userId: string,
  documentId: string,
  index: number,
): string {
  return `episodic-source-chunk-${sha(
    `source-chunk-v1\n${runKey}\n${userId}\n${documentId}\n${index}`,
  ).slice(0, 16)}`;
}

function providerFor(userId: string): MemoryProviderV1 {
  let provider = providers.get(userId);
  if (!provider) {
    const profile: PawNextMemoryPluginProfileV1 = Object.freeze({
      policyVersion: PAW_NEXT_MEMORY_PLUGIN_POLICY_VERSION_V1,
      mode: "read_only",
      providerVersion,
      scope: scopeFor(userId),
      maxCards: 16,
      maxInjectedTokens: 4_096,
      ...(embedding
        ? {
            embedding: {
              model: embedding.model,
              version: embedding.version,
              dimensions: 1_536 as const,
            },
          }
        : {}),
    });
    const cacheOptions = {
      cache,
      onEvent(event: MemoryRetrievalCacheEventV1) {
        pendingCacheEvents.push(event);
        log("cache", event);
      },
    };
    provider =
      retrievalPolicy === "rrf"
        ? createPawNextMemoryRrfPostgresProviderV1(
            profile,
            cacheOptions,
            embedding
              ? {
                  embedding,
                  vectorPolicy:
                    embeddingMode === "hybrid_partitioned"
                      ? "always"
                      : "lexical_gap_only",
                }
              : undefined,
            undefined,
            {
              onFusionEvent(event: MemoryRrfFusionEventV1) {
                log("rrf_fusion", event);
              },
            },
          )
        : createPawNextMemoryV2PostgresProviderV1(profile, cacheOptions);
    providers.set(userId, provider);
  }
  return provider;
}

function atomStoreFor(userId: string): MemoryAtomWriterStoreV1 {
  let store = atomStores.get(userId);
  if (!store) {
    store = createMemoryAtomWriterStoreV1({
      engine: engineFor(userId),
      scope: scopeFor(userId),
      sourceRef({ runId, sourceSeq }) {
        return `amb:document/${runId}#atom-${sourceSeq}`;
      },
    });
    atomStores.set(userId, store);
  }
  return store;
}

function topicOrganizerStoreFor(userId: string): MemoryTopicOrganizerStoreV1 {
  let store = topicOrganizerStores.get(userId);
  if (!store) {
    store = createPostgresMemoryTopicOrganizerStoreV1({
      scope: scopeFor(userId),
    });
    topicOrganizerStores.set(userId, store);
  }
  return store;
}

function topicEvidenceStoreFor(userId: string): MemoryTopicEvidenceStoreV1 {
  let store = topicEvidenceStores.get(userId);
  if (!store) {
    store = createPostgresMemoryTopicEvidenceStoreV1({
      scope: scopeFor(userId),
    });
    topicEvidenceStores.set(userId, store);
  }
  return store;
}

function topicDossierStoreFor(userId: string): MemoryTopicDossierStoreV1 {
  let store = topicDossierStores.get(userId);
  if (!store) {
    store = createPostgresMemoryTopicDossierStoreV1({
      scope: scopeFor(userId),
    });
    topicDossierStores.set(userId, store);
  }
  return store;
}

function topicDossierProjectorFor(
  userId: string,
): MemoryTopicDossierProjectorV1 {
  if (!topicDossierExtractor) {
    throw new Error("AMB topic dossier extractor is unavailable");
  }
  let projector = topicDossierProjectors.get(userId);
  if (!projector) {
    projector = createMemoryTopicDossierProjectorV1({
      scope: scopeFor(userId),
      extractor: topicDossierExtractor,
      store: topicDossierStoreFor(userId),
      onEvent(event) {
        log("topic_dossier_projection", {
          ...event,
          topicId: sha(event.topicId),
        });
      },
    });
    topicDossierProjectors.set(userId, projector);
  }
  return projector;
}

function rawEvidenceArchiveFor(userId: string): MemoryRawEvidenceArchiveV1 {
  let archive = rawEvidenceArchives.get(userId);
  if (!archive) {
    archive = createPostgresMemoryRawEvidenceArchiveV1({
      scope: scopeFor(userId),
    });
    rawEvidenceArchives.set(userId, archive);
  }
  return archive;
}

function contextResolverFor(userId: string): MemoryContextResolverV1 {
  let resolver = contextResolvers.get(userId);
  if (!resolver) {
    const profile: PawNextMemoryPluginProfileV1 = Object.freeze({
      policyVersion: PAW_NEXT_MEMORY_PLUGIN_POLICY_VERSION_V1,
      mode: "read_only",
      providerVersion,
      scope: scopeFor(userId),
      maxCards: 16,
      maxInjectedTokens: 4_096,
    });
    resolver = createMemoryContextResolverV1({
      profile,
      provider: providerFor(userId),
      topicStore: topicEvidenceStoreFor(userId),
      dossierStore: topicDossierStoreFor(userId),
      archive: rawEvidenceArchiveFor(userId),
      ...(coveragePlanner === undefined ? {} : { planner: coveragePlanner }),
      ...(supportVerifier === undefined ? {} : { verifier: supportVerifier }),
      maxRequirements: 4,
      maxExpansionTopics: 3,
      maxSupplementalStates: 8,
      maxSupplementalChars: 4_096,
      maxRawSpans: 6,
      maxRawChars: 6_000,
      onEvent(event) {
        log("context_resolver", {
          ...event,
          userFingerprint: sha(userId).slice(0, 20),
        });
      },
    });
    contextResolvers.set(userId, resolver);
  }
  return resolver;
}

function log(event: string, detail: unknown): void {
  appendFileSync(
    logPath,
    `${JSON.stringify({
      schemaVersion: "paw.amb-log.v1",
      at: new Date().toISOString(),
      event,
      detail,
    })}\n`,
    "utf8",
  );
}

function isFatalAtomIngestErrorV1(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "AbortError" ||
    error.name === "AtomIngestRemoteCallBudgetExceeded" ||
    error.name === "AtomIngestPromptTokenBudgetExceeded" ||
    error.name === "AtomIngestCompletionTokenBudgetExceeded" ||
    error.name === "AtomIngestCheckpointIdentityMismatch"
  );
}

function classifyAtomIngestErrorV1(error: unknown): string {
  if (!(error instanceof Error)) return "MemoryAtomWindowUnknownFailure";
  if (error.name !== "Error") return error.name;
  const known = new Map<string, string>([
    [
      "Store memory atom cannot have targetIds",
      "MemoryAtomStoreTargetsUnexpected",
    ],
    [
      "Memory atom targets an unrecognized memory id",
      "MemoryAtomTargetUnrecognized",
    ],
    [
      "Memory atom sourceSeqs are outside the extraction evidence",
      "MemoryAtomSourceEvidenceInvalid",
    ],
    [
      "Memory atom target is missing from the scoped store",
      "MemoryAtomTargetMissing",
    ],
    ["Memory extractor output is not JSON", "MemoryAtomOutputInvalid"],
  ]);
  return known.get(error.message) ?? "MemoryAtomWindowValidationFailed";
}

function chunks(content: string, size = 5_000, overlap = 400): string[] {
  const normalized = content.trim();
  if (!normalized) return [];
  const output: string[] = [];
  for (let start = 0; start < normalized.length; start += size - overlap) {
    output.push(normalized.slice(start, start + size));
    if (start + size >= normalized.length) break;
  }
  return output;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value)
    throw new Error(`${label} is required`);
  return value;
}

function asStringArray(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string")
  ) {
    throw new Error("Expected a string array");
  }
  return value;
}

function readBoundedInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  label: string,
): number {
  if (value === undefined || !value.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} is invalid`);
  }
  return parsed;
}

async function prepare(params: Record<string, unknown>): Promise<unknown> {
  const storeDir = asString(params.storeDir, "storeDir");
  const unitIds = asStringArray(params.unitIds ?? ["default"]);
  const requestedReset = params.reset !== false;
  const reset = requestedReset && !(ingestMode === "atom" && atomResume);
  runKey = sha(resolve(storeDir)).slice(0, 20);
  engines.clear();
  sourceEngines.clear();
  sourceChunkEngines.clear();
  providers.clear();
  atomStores.clear();
  topicOrganizerStores.clear();
  topicEvidenceStores.clear();
  topicDossierStores.clear();
  topicDossierProjectors.clear();
  rawEvidenceArchives.clear();
  contextResolvers.clear();
  documentIdsByUser.clear();
  documentCreatedByUser.clear();
  documentOrderByUser.clear();
  sourceBlockIdsByUserDocument.clear();
  sourceKindByUser.clear();
  sceneSnapshots.clear();
  cache.clear();
  sourceLocalLocatorCache.clear();
  resetUsers.clear();
  routeStats.l0Fallback = 0;
  routeStats.sceneCausal = 0;
  routeStats.sceneExploratory = 0;
  routeStats.sceneReads = 0;
  routeStats.selectedAtoms = 0;
  routeStats.dynamicChars = 0;
  routeStats.personaInjections = 0;
  resetOnFirstIngest = reset && unitIds.length === 0;
  let deleted = 0;
  if (reset) {
    for (const unitId of unitIds) {
      deleted += await clearScope(unitId);
      resetUsers.add(unitId);
    }
  }
  if (ingestMode === "atom") {
    atomCheckpoint = createAtomIngestCheckpointStoreV1({
      path: resolve(storeDir, "paw-m2a-atom-checkpoint.v1.json"),
      runKey,
      identityHash: atomWriterIdentityHash,
      resume: atomResume || !requestedReset,
    });
  } else {
    atomCheckpoint = undefined;
  }
  const checkpoint = atomCheckpoint?.snapshot();
  log("prepare", {
    runKey,
    requestedReset,
    effectiveReset: reset,
    resumeRequested: atomResume,
    resumed: atomCheckpoint?.resumed ?? false,
    units: unitIds.length,
    deleted,
    checkpointCompleted: checkpoint?.completedCount ?? 0,
    atomLimits: ingestMode === "atom" ? atomLimits : null,
    atomWriteMode,
  });
  return {
    runKey,
    reset,
    resumed: atomCheckpoint?.resumed ?? false,
    units: unitIds.length,
    deleted,
    checkpointCompleted: checkpoint?.completedCount ?? 0,
  };
}

async function ingest(params: Record<string, unknown>): Promise<unknown> {
  const rawDocuments = params.documents;
  if (!Array.isArray(rawDocuments))
    throw new Error("documents must be an array");
  const documents = rawDocuments.map((document, index) =>
    normalizeAmbDocument(document, index),
  );
  const sourceChunksByDocument = new Map(
    documents.map((document) => [
      `${document.userId}\0${document.id}`,
      chunks(document.content),
    ]),
  );
  const evidenceWindowsByDocument = new Map(
    documents.map((document) => [
      `${document.userId}\0${document.id}`,
      projectAmbMemoryEvidenceV1(document.content),
    ]),
  );
  const nextOrderByUser = new Map<string, number>();
  for (const document of documents) {
    const orderByDocument =
      documentOrderByUser.get(document.userId) ?? new Map<string, number>();
    const observedOrder = nextOrderByUser.get(document.userId) ?? 0;
    orderByDocument.set(document.id, observedOrder);
    nextOrderByUser.set(document.userId, observedOrder + 1);
    documentOrderByUser.set(document.userId, orderByDocument);
    const kinds = sourceKindByUser.get(document.userId) ?? new Map();
    const windows =
      evidenceWindowsByDocument.get(`${document.userId}\0${document.id}`) ?? [];
    const sources = windows.flatMap((window) => window.source);
    const blockIdsByDocument =
      sourceBlockIdsByUserDocument.get(document.userId) ??
      new Map<string, readonly string[]>();
    blockIdsByDocument.set(
      document.id,
      Object.freeze(
        sources.map((source) =>
          sourceBlockId(document.userId, document.id, source.seq),
        ),
      ),
    );
    sourceBlockIdsByUserDocument.set(document.userId, blockIdsByDocument);
    for (const source of sources) {
      kinds.set(
        `amb:document/${document.id}#source-${source.seq}`,
        source.kind,
      );
    }
    sourceKindByUser.set(document.userId, kinds);
  }
  if (reuseIndex) {
    const users = [...new Set(documents.map((document) => document.userId))];
    const coverageByUser = await Promise.all(
      users.map(async (userId) => {
        const userDocuments = documents.filter(
          (document) => document.userId === userId,
        );
        const spanIds = userDocuments.flatMap((document) =>
          (
            evidenceWindowsByDocument.get(`${userId}\0${document.id}`) ?? []
          ).flatMap((window) =>
            window.source.map((source) =>
              sourceBlockId(userId, document.id, source.seq),
            ),
          ),
        );
        const chunkIds = userDocuments.flatMap((document) =>
          (sourceChunksByDocument.get(`${userId}\0${document.id}`) ?? []).map(
            (_chunk, index) => sourceChunkId(userId, document.id, index),
          ),
        );
        const [spans, chunks] = await Promise.all([
          sourceEngineFor(userId).inspectDerivedIndexCoverage({
            ids: spanIds,
            requireEmbedding: Boolean(sourceSpanEmbedding),
          }),
          sourceChunkEngineFor(userId).inspectDerivedIndexCoverage({
            ids: chunkIds,
            requireEmbedding: Boolean(sourceChunkEmbedding),
          }),
        ]);
        return Object.freeze({ userId, spans, chunks });
      }),
    );
    const incomplete = coverageByUser.filter(
      (coverage) => !coverage.spans.complete || !coverage.chunks.complete,
    );
    const coverageSummary = Object.freeze({
      users: users.length,
      expectedItems: coverageByUser.reduce(
        (total, coverage) =>
          total + coverage.spans.expectedCount + coverage.chunks.expectedCount,
        0,
      ),
      presentItems: coverageByUser.reduce(
        (total, coverage) =>
          total + coverage.spans.itemCount + coverage.chunks.itemCount,
        0,
      ),
      requiredEmbeddings: coverageByUser.reduce(
        (total, coverage) =>
          total +
          (coverage.spans.embeddingRequired
            ? coverage.spans.expectedCount
            : 0) +
          (coverage.chunks.embeddingRequired
            ? coverage.chunks.expectedCount
            : 0),
        0,
      ),
      presentRequiredEmbeddings: coverageByUser.reduce(
        (total, coverage) =>
          total +
          (coverage.spans.embeddingRequired
            ? coverage.spans.embeddingCount
            : 0) +
          (coverage.chunks.embeddingRequired
            ? coverage.chunks.embeddingCount
            : 0),
        0,
      ),
      incompleteUsers: incomplete.length,
      incompleteUserHashes: incomplete.map((coverage) =>
        sha(coverage.userId).slice(0, 20),
      ),
    });
    log("reuse_index_validation", {
      ...coverageSummary,
      denseIndexLevel,
      embeddingModel: embedding?.model ?? null,
      embeddingVersion: embedding?.version ?? null,
      status: incomplete.length === 0 ? "completed" : "failed",
    });
    if (incomplete.length > 0) {
      throw new Error(
        `AMB reusable L0 index is incomplete: ${coverageSummary.presentItems}/${coverageSummary.expectedItems} items, ${coverageSummary.presentRequiredEmbeddings}/${coverageSummary.requiredEmbeddings} required embeddings`,
      );
    }
    for (const document of documents) {
      const documentIds =
        documentIdsByUser.get(document.userId) ?? new Set<string>();
      documentIds.add(document.id);
      documentIdsByUser.set(document.userId, documentIds);
      const createdByDocument =
        documentCreatedByUser.get(document.userId) ?? new Map<string, string>();
      createdByDocument.set(document.id, document.created);
      documentCreatedByUser.set(document.userId, createdByDocument);
    }
    log("reuse_index", {
      documents: documents.length,
      users: new Set(documents.map((document) => document.userId)).size,
      checkpointCompleted: atomCheckpoint?.snapshot().completedCount ?? 0,
      coverage: coverageSummary,
      status: "completed",
    });
    return {
      documents: documents.length,
      ingestMode,
      atomWriteMode,
      reusedIndex: true,
      checkpoint: atomCheckpoint?.snapshot() ?? null,
    };
  }
  if (ingestMode === "atom" && embedding?.embedMany) {
    const sourceChunkTexts = [...sourceChunksByDocument.values()].flat();
    const sourceSpanTexts = [...evidenceWindowsByDocument.values()].flatMap(
      (windows) =>
        windows.flatMap((window) => window.source.map((item) => item.content)),
    );
    const l0Texts = [
      ...(sourceChunkEmbedding ? sourceChunkTexts : []),
      ...(sourceSpanEmbedding ? sourceSpanTexts : []),
    ];
    const prewarmDecision = decideAmbEmbeddingPrewarmV1({
      textCount: l0Texts.length,
      cacheMaxEntries: embeddingCacheMaxEntries,
    });
    if (!prewarmDecision.shouldPrewarm && l0Texts.length > 0) {
      log("l0_embedding_prewarm", {
        documentCount: documents.length,
        chunkTextCount: sourceChunkTexts.length,
        spanTextCount: sourceSpanTexts.length,
        textCount: l0Texts.length,
        cacheMaxEntries: embeddingCacheMaxEntries,
        status: "skipped",
        reasonCode: prewarmDecision.reasonCode,
      });
    } else if (prewarmDecision.shouldPrewarm) {
      const started = performance.now();
      try {
        await embedding.embedMany(l0Texts);
        log("l0_embedding_prewarm", {
          documentCount: documents.length,
          chunkTextCount: sourceChunkTexts.length,
          spanTextCount: sourceSpanTexts.length,
          textCount: l0Texts.length,
          durationMs: Math.max(0, performance.now() - started),
          status: "completed",
        });
      } catch (error) {
        log("l0_embedding_prewarm", {
          documentCount: documents.length,
          chunkTextCount: sourceChunkTexts.length,
          spanTextCount: sourceSpanTexts.length,
          textCount: l0Texts.length,
          durationMs: Math.max(0, performance.now() - started),
          status: "failed",
          errorCode:
            error instanceof Error
              ? error.name
              : "SourceChunkEmbeddingPrewarmFailed",
        });
      }
    }
  }
  let storedChunks = 0;
  let storedSourceBlocks = 0;
  let storedSourceChunks = 0;
  let storedAtoms = 0;
  let skippedAtoms = 0;
  let atomWindowFailures = 0;
  let completedSources = 0;
  let resumedSources = 0;
  let topicOrganizationFailures = 0;
  let topicDossierProjectionFailures = 0;
  let embeddingStreamBatches = 0;
  let embeddingStreamItems = 0;
  let embeddingDocumentWaves = 0;
  let embeddingWaveItems = 0;

  function l0EmbeddingTexts(document: NormalizedAmbDocumentV1): string[] {
    return [
      ...(sourceChunkEmbedding
        ? (sourceChunksByDocument.get(`${document.userId}\0${document.id}`) ??
          [])
        : []),
      ...(sourceSpanEmbedding
        ? (
            evidenceWindowsByDocument.get(
              `${document.userId}\0${document.id}`,
            ) ?? []
          ).flatMap((window) => window.source.map((source) => source.content))
        : []),
    ];
  }

  async function putL0Entries(
    engine: PostgresMemoryStoreEngine,
    entries: readonly EpisodicExperience[],
    denseEmbeddingEnabled: boolean,
  ): Promise<void> {
    if (entries.length === 0) return;
    if (!denseEmbeddingEnabled || !embedding?.embedMany) {
      for (const entry of entries) await engine.put(entry);
      return;
    }
    const report = await streamAmbEmbeddingBatchesV1({
      items: entries,
      batchSize: embeddingStreamBatchSize,
      text: (entry) => entry.whenToUse,
      prewarm: (texts) => embedding.embedMany!(texts),
      persistBatch: (batch) =>
        runKeyedInOrderV1({
          items: batch,
          concurrency: embeddingStoreConcurrency,
          key: (entry) => entry.id,
          run: (entry) => engine.put(entry),
        }),
    });
    embeddingStreamBatches += report.batchCount;
    embeddingStreamItems += report.itemCount;
  }

  async function ingestDocument(
    document: NormalizedAmbDocumentV1,
  ): Promise<void> {
    const documentId = document.id;
    const content = document.content;
    const userId = document.userId;
    const documentIds = documentIdsByUser.get(userId) ?? new Set<string>();
    documentIds.add(documentId);
    documentIdsByUser.set(userId, documentIds);
    const createdByDocument = documentCreatedByUser.get(userId) ?? new Map();
    createdByDocument.set(documentId, document.created);
    documentCreatedByUser.set(userId, createdByDocument);
    sceneSnapshots.delete(userId);
    if (resetOnFirstIngest && !resetUsers.has(userId)) {
      const deleted = await clearScope(userId);
      resetUsers.add(userId);
      log("scope_reset", {
        userFingerprint: sha(userId).slice(0, 20),
        deleted,
      });
    }
    const engine = engineFor(userId);
    const created = document.created;
    if (ingestMode === "atom") {
      if (!atomCheckpoint)
        throw new Error("AMB atom checkpoint is unavailable");
      const store = atomStoreFor(userId);
      const documentStoredIds = new Set<string>();
      const evidenceWindows =
        evidenceWindowsByDocument.get(`${userId}\0${documentId}`) ??
        projectAmbMemoryEvidenceV1(content);
      const sourceChunks =
        sourceChunksByDocument.get(`${userId}\0${documentId}`) ??
        chunks(content);
      // Keep an exact L0 copy for conservative routes. L2/L3 projections are
      // intentionally user-grounded, but a fallback must retain the complete
      // conversation (including assistant turns) to match raw retrieval.
      const sourceChunkEntries = sourceChunks.map((chunk, index) => {
        const sourceEntry: EpisodicExperience = {
          id: sourceChunkId(userId, documentId, index),
          kind: "episodic",
          repo: sourceChunkScopeFor(userId).repositoryId,
          created,
          tValid: created,
          tInvalid: null,
          source: "repo_docs",
          confidence: 1,
          evidence: [`amb:document/${documentId}#source-chunk-${index}`],
          freq: 0,
          utility: 0,
          whenToUse: chunk,
          perspective: "",
          modification: [],
          issueType: "AmbBenchmarkSourceTimelineChunk",
          taskId: `amb-source-${sha(documentId).slice(0, 20)}`,
        };
        return sourceEntry;
      });
      await putL0Entries(
        sourceChunkEngineFor(userId),
        sourceChunkEntries,
        sourceChunkEmbedding !== undefined,
      );
      storedSourceChunks += sourceChunkEntries.length;
      const sourceBlockEntries = evidenceWindows.flatMap((window) =>
        window.source.map((source) => {
          const sourceEntry: EpisodicExperience = {
            id: sourceBlockId(userId, documentId, source.seq),
            kind: "episodic",
            repo: sourceScopeFor(userId).repositoryId,
            created,
            tValid: created,
            tInvalid: null,
            source: "repo_docs",
            confidence: 1,
            evidence: [`amb:document/${documentId}#source-${source.seq}`],
            freq: 0,
            utility: 0,
            whenToUse: source.content,
            perspective: "",
            modification: [],
            issueType: source.kind,
            taskId: `amb-source-${sha(documentId).slice(0, 20)}`,
          };
          return sourceEntry;
        }),
      );
      await putL0Entries(
        sourceEngineFor(userId),
        sourceBlockEntries,
        sourceSpanEmbedding !== undefined,
      );
      storedSourceBlocks += sourceBlockEntries.length;
      for (const [index, window] of evidenceWindows.entries()) {
        const sourceFromSeq = window.source[0]?.seq;
        const sourceThroughSeq = window.source.at(-1)?.seq;
        if (sourceFromSeq === undefined || sourceThroughSeq === undefined)
          continue;
        const sourceHash = sha(JSON.stringify(window.source));
        const writeId = sha(
          `${atomWriterIdentityHash}\n${runKey}\n${userId}\n${documentId}\n${sourceHash}\natom\n${index}`,
        );
        // L0 is an immutable conversational record, not a by-product of which
        // L1 atoms happened to be selected. Preserve the complete bounded
        // window, including assistant context, before any resumable L1 work.
        await rawEvidenceArchiveFor(userId).put(
          window.archiveSource.flatMap((source) =>
            ["atom", "source"].map((addressKind) => ({
              evidenceRef: `amb:document/${documentId}#${addressKind}-${source.seq}`,
              sourceKind: source.kind,
              sourceSeq: source.seq,
              content: source.content,
              createdAt: created,
            })),
          ),
          new AbortController().signal,
        );
        if (atomCheckpoint.has(writeId)) {
          resumedSources += 1;
          log("atom_checkpoint_skip", {
            userFingerprint: sha(userId).slice(0, 20),
            documentHash: sha(documentId),
            sourceIndex: index,
            sourceHash,
            writeId,
            l0Replayed: true,
          });
          continue;
        }
        if (atomWriteMode === "off") {
          completedSources += 1;
          atomCheckpoint.markCompleted(writeId);
          log("atom_l0_only_ingest", {
            userFingerprint: sha(userId).slice(0, 20),
            documentHash: sha(documentId),
            sourceIndex: index,
            sourceHash,
            writeId,
          });
          continue;
        }
        if (!atomExtractor)
          throw new Error("AMB atom extractor is unavailable");
        const signal = new AbortController().signal;
        try {
          const conflicts = await store.recall(window.text, 16, signal);
          const extractedAtoms = await atomExtractor.extract(
            {
              writeId,
              runId: documentId,
              repositoryId: scopeFor(userId).repositoryId,
              sourceFromSeq,
              sourceThroughSeq,
              source: window.source,
              conflicts,
              maxAtoms: 16,
            },
            signal,
          );
          const reconciliation =
            atomWriteMode === "index"
              ? Object.freeze({
                  atoms: Object.freeze(
                    extractedAtoms
                      .filter((atom) => atom.action !== "skip")
                      .map((atom) =>
                        Object.freeze({
                          ...atom,
                          action: "store" as const,
                          targetIds: Object.freeze([]),
                        }),
                      ),
                  ),
                  candidateCount: 0,
                  revisedDecisionCount: extractedAtoms.filter(
                    (atom) => atom.action !== "store",
                  ).length,
                  status: "index" as const,
                  resolutionRevision: undefined,
                  reasonCode: undefined,
                })
              : await reconcileMemoryAtomsV1({
                  atoms: extractedAtoms,
                  seedCandidates: conflicts,
                  store,
                  ...(atomConflictResolver === undefined
                    ? {}
                    : { resolver: atomConflictResolver }),
                  observedAt: created,
                  signal,
                });
          const atoms = reconciliation.atoms;
          log("atom_reconcile", {
            userFingerprint: sha(userId).slice(0, 20),
            documentHash: sha(documentId),
            sourceIndex: index,
            writeId,
            status: reconciliation.status,
            candidateCount: reconciliation.candidateCount,
            revisedDecisionCount: reconciliation.revisedDecisionCount,
            resolutionRevision: reconciliation.resolutionRevision ?? null,
            reasonCode: reconciliation.reasonCode ?? null,
          });
          const applied = await store.apply(
            {
              writeId,
              runId: documentId,
              repositoryId: scopeFor(userId).repositoryId,
              claimedAt: Date.parse(created),
              atoms,
            },
            signal,
          );
          storedAtoms += applied.storedIds.length;
          for (const id of applied.storedIds) documentStoredIds.add(id);
          skippedAtoms += applied.skippedAtomIds.length;
          completedSources += 1;
          atomCheckpoint.markCompleted(writeId);
          log("atom_ingest", {
            userFingerprint: sha(userId).slice(0, 20),
            documentHash: sha(documentId),
            sourceIndex: index,
            sourceHash,
            writeId,
            conflictCount: conflicts.length,
            atomCount: atoms.length,
            storedCount: applied.storedIds.length,
            invalidatedCount: applied.invalidatedIds.length,
            skippedCount: applied.skippedAtomIds.length,
          });
        } catch (error) {
          if (isFatalAtomIngestErrorV1(error)) throw error;
          atomWindowFailures += 1;
          log("atom_window_failed_open", {
            userFingerprint: sha(userId).slice(0, 20),
            documentHash: sha(documentId),
            sourceIndex: index,
            sourceHash,
            writeId,
            code: classifyAtomIngestErrorV1(error),
            errorFingerprint:
              error instanceof Error ? sha(error.message).slice(0, 20) : null,
            l0Preserved: true,
            retryable: true,
          });
        }
      }
      if (
        (atomContextMode === "topic_evidence" ||
          atomContextMode === "tool_driven") &&
        documentStoredIds.size > 0
      ) {
        try {
          topicDossierProjectionFailures += await organizeTopicEvidenceV1({
            userId,
            documentId,
            claimedAt: Date.parse(created),
            memoryIds: [...documentStoredIds],
          });
        } catch (error) {
          topicOrganizationFailures += 1;
          const code = error instanceof Error ? error.name : "UnknownError";
          log("topic_organization_failed", {
            userFingerprint: sha(userId).slice(0, 20),
            documentHash: sha(documentId),
            code,
            errorFingerprint:
              error instanceof Error ? sha(error.message).slice(0, 20) : null,
          });
        }
      }
      return;
    }
    for (const [index, chunk] of chunks(content).entries()) {
      const id = `episodic-${sha(`${runKey}\n${userId}\n${documentId}\n${index}`).slice(0, 16)}`;
      const entry: EpisodicExperience = {
        id,
        kind: "episodic",
        repo: scopeFor(userId).repositoryId,
        created,
        tValid: created,
        tInvalid: null,
        source: "repo_docs",
        confidence: 1,
        evidence: [`amb:document/${documentId}#chunk-${index}`],
        freq: 0,
        utility: 0,
        whenToUse: chunk,
        perspective: "",
        modification: [],
        issueType: "AmbBenchmarkDocument",
        taskId: `amb-${sha(documentId).slice(0, 20)}`,
      };
      await engine.put(entry);
      storedChunks += 1;
    }
  }

  if (ingestMode === "atom") {
    const waves = embedding?.embedMany
      ? planAmbEmbeddingWavesV1({
          items: documents,
          weight: (document) => l0EmbeddingTexts(document).length,
          maxWeight: embeddingCacheMaxEntries,
          maxItems: 64,
        })
      : [documents];
    for (const wave of waves) {
      if (embedding?.embedMany) {
        const texts = wave.flatMap(l0EmbeddingTexts);
        if (texts.length <= embeddingCacheMaxEntries) {
          await embedding.embedMany(texts);
          embeddingDocumentWaves += 1;
          embeddingWaveItems += texts.length;
        }
      }
      await runKeyedInOrderV1({
        items: wave,
        concurrency: atomLimits.concurrency,
        key: (document) => document.userId,
        run: async (document) => {
          try {
            await ingestDocument(document);
          } catch (error) {
            log("atom_document_failed", {
              userFingerprint: sha(document.userId).slice(0, 20),
              documentHash: sha(document.id),
              code: error instanceof Error ? error.name : "UnknownError",
              errorFingerprint:
                error instanceof Error ? sha(error.message).slice(0, 20) : null,
              checkpoint: atomCheckpoint?.snapshot() ?? null,
            });
            throw error;
          }
        },
      });
    }
  } else {
    for (const document of documents) await ingestDocument(document);
  }
  log("ingest", {
    documents: documents.length,
    ingestMode,
    atomWriteMode,
    storedChunks,
    storedSourceBlocks,
    storedSourceChunks,
    storedAtoms,
    skippedAtoms,
    atomWindowFailures,
    completedSources,
    resumedSources,
    topicOrganizationFailures,
    topicDossierProjectionFailures,
    embeddingStreamBatches,
    embeddingStreamItems,
    embeddingStreamBatchSize,
    embeddingStoreConcurrency,
    embeddingDocumentWaves,
    embeddingWaveItems,
    budget: ingestMode === "atom" ? atomBudget.snapshot() : null,
    checkpoint: atomCheckpoint?.snapshot() ?? null,
  });
  return {
    documents: documents.length,
    ingestMode,
    atomWriteMode,
    storedChunks,
    storedSourceBlocks,
    storedSourceChunks,
    storedAtoms,
    skippedAtoms,
    completedSources,
    resumedSources,
    topicOrganizationFailures,
    topicDossierProjectionFailures,
    budget: ingestMode === "atom" ? atomBudget.snapshot() : null,
    checkpoint: atomCheckpoint?.snapshot() ?? null,
  };
}

async function organizeTopicEvidenceV1(input: {
  userId: string;
  documentId: string;
  claimedAt: number;
  memoryIds: readonly string[];
}): Promise<number> {
  if (!topicExtractor) throw new Error("AMB topic extractor is unavailable");
  const store = topicOrganizerStoreFor(input.userId);
  const signal = new AbortController().signal;
  const ids = [...new Set(input.memoryIds)].sort();
  let dossierFailures = 0;
  for (let offset = 0; offset < ids.length; offset += 64) {
    const sourceIds = ids.slice(offset, offset + 64);
    const prepared = await store.prepare(
      { scope: scopeFor(input.userId), sourceMemoryIds: sourceIds },
      signal,
    );
    if (prepared.entries.length === 0) continue;
    const proposals = await topicExtractor.extract(
      {
        scope: scopeFor(input.userId),
        sourceRevision: prepared.sourceRevision,
        entries: prepared.entries,
        existingTopics: prepared.existingTopics,
        maxTopics: 8,
      },
      signal,
    );
    const organizationId = sha(
      `amb-topic-evidence-v1\n${runKey}\n${input.userId}\n${input.documentId}\n${offset}\n${prepared.sourceRevision}`,
    );
    const applied = await store.apply(
      {
        organizationId,
        scope: scopeFor(input.userId),
        claimedAt: input.claimedAt,
        proposals,
      },
      signal,
    );
    log("topic_organization", {
      userFingerprint: sha(input.userId).slice(0, 20),
      documentHash: sha(input.documentId),
      organizationId,
      sourceCount: sourceIds.length,
      proposalCount: proposals.length,
      topicCount: applied.topicIds.length,
      snapshotCount: applied.snapshotIds.length,
    });
    if (topicDossierExtractor) {
      const catalog = await topicEvidenceStoreFor(input.userId).load(signal);
      for (const topicId of applied.topicIds) {
        const candidate = catalog.find(
          (item) => item.projection.topic.id === topicId,
        );
        if (!candidate) {
          dossierFailures += 1;
          log("topic_dossier_projection_missing", {
            userFingerprint: sha(input.userId).slice(0, 20),
            topicHash: sha(topicId),
          });
          continue;
        }
        try {
          await topicDossierProjectorFor(input.userId).project(
            candidate,
            signal,
          );
        } catch {
          // Projector emitted a content-free failure event; L1/L2 trajectory
          // ingestion remains usable and this derivative fails open.
          dossierFailures += 1;
        }
      }
    }
  }
  return dossierFailures;
}

function normalizeAmbDocument(
  value: unknown,
  ingestionOrdinal: number,
): NormalizedAmbDocumentV1 {
  if (!value || typeof value !== "object")
    throw new Error("document is invalid");
  const document = value as AmbDocumentV1;
  return Object.freeze({
    id: asString(document.id, "document.id"),
    content: asString(document.content, "document.content"),
    userId: document.user_id || "default",
    created:
      document.timestamp && !Number.isNaN(Date.parse(document.timestamp))
        ? new Date(document.timestamp).toISOString()
        : fallbackObservedAtV1(document.id, ingestionOrdinal),
  });
}

/** Preserve source order when an upstream corpus has no wall-clock timestamps. */
function fallbackObservedAtV1(
  documentId: string,
  ingestionOrdinal: number,
): string {
  const suffix = /_(\d+)$/.exec(documentId)?.[1];
  const sessionOrdinal =
    suffix === undefined ? ingestionOrdinal : Number(suffix);
  const safeOrdinal =
    Number.isSafeInteger(sessionOrdinal) && sessionOrdinal >= 0
      ? sessionOrdinal
      : ingestionOrdinal;
  return new Date(Date.UTC(2000, 0, 1) + safeOrdinal * 1_000).toISOString();
}

async function clearScope(userId: string): Promise<number> {
  const scope = scopeFor(userId);
  if (ingestMode === "atom") {
    const sql = getSql();
    await sql`
      DELETE FROM memory_topics
      WHERE scope->>'tenantId' = ${scope.tenantId}
        AND scope->>'userId' = ${scope.userId}
        AND scope->>'workspaceId' = ${scope.workspaceId}
        AND scope->>'repositoryId' = ${scope.repositoryId}
    `;
    await sql`
      DELETE FROM memory_raw_evidence_spans
      WHERE scope->>'tenantId' = ${scope.tenantId}
        AND scope->>'userId' = ${scope.userId}
        AND scope->>'workspaceId' = ${scope.workspaceId}
        AND scope->>'repositoryId' = ${scope.repositoryId}
    `;
  }
  const engine = engineFor(userId);
  const entries = await engine.query({
    includeInvalidated: true,
    includeDegraded: true,
    limit: 100_000,
  });
  for (const entry of entries) await engine.delete(entry.id);
  if (ingestMode !== "atom") return entries.length;
  const sourceEngine = sourceEngineFor(userId);
  const sourceEntries = await sourceEngine.query({
    includeInvalidated: true,
    includeDegraded: true,
    limit: 100_000,
  });
  for (const entry of sourceEntries) await sourceEngine.delete(entry.id);
  const sourceChunkEngine = sourceChunkEngineFor(userId);
  const sourceChunkEntries = await sourceChunkEngine.query({
    includeInvalidated: true,
    includeDegraded: true,
    limit: 100_000,
  });
  for (const entry of sourceChunkEntries) {
    await sourceChunkEngine.delete(entry.id);
  }
  return entries.length + sourceEntries.length + sourceChunkEntries.length;
}

async function sourceTextsForDocument(
  userId: string,
  documentId: string,
  sourceSeqs: readonly number[],
): Promise<string[]> {
  const texts: string[] = [];
  const engine = sourceEngineFor(userId);
  const neighborSeqs = new Set<number>();
  for (const seq of sourceSeqs) {
    for (let offset = -1; offset <= 1; offset += 1) {
      if (seq + offset > 0) neighborSeqs.add(seq + offset);
    }
  }
  const selectedSeqs =
    neighborSeqs.size > 0
      ? [...neighborSeqs].sort((left, right) => left - right)
      : Array.from({ length: 64 }, (_, index) => index + 1);
  for (const seq of selectedSeqs) {
    const entry = await engine.get(sourceBlockId(userId, documentId, seq));
    if (!entry) continue;
    if (entry.kind === "episodic" && entry.whenToUse.trim()) {
      texts.push(entry.whenToUse);
    }
  }
  return texts;
}

async function sourceChunksForDocument(
  userId: string,
  documentId: string,
): Promise<Array<{ documentId: string; index: number; text: string }>> {
  const output: Array<{ documentId: string; index: number; text: string }> = [];
  const engine = sourceChunkEngineFor(userId);
  for (let index = 0; index < 64; index += 1) {
    const entry = await engine.get(sourceChunkId(userId, documentId, index));
    if (!entry) break;
    if (entry.kind === "episodic" && entry.whenToUse.trim()) {
      output.push({ documentId, index, text: entry.whenToUse });
    }
  }
  return output;
}

/**
 * Discovery-only hybrid search. Candidate depth is independent from the final
 * generation-context budget; only selected evidence addresses are hydrated.
 */
async function searchEvidenceIndexEntriesV2(input: {
  readonly engine: PostgresMemoryStoreEngine;
  readonly query: string;
  readonly limit: number;
  readonly repositoryId: string;
  readonly vector: boolean;
  readonly indexKind: "source_chunk" | "source_span";
}): Promise<readonly MemoryEntry[]> {
  if (
    !input.query.trim() ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 64
  ) {
    throw new Error("Evidence index discovery input is invalid");
  }
  const candidateK = Math.min(256, Math.max(32, input.limit * 8));
  const [lexical, vector] = await Promise.all([
    input.engine
      .searchText(input.query, candidateK, input.repositoryId)
      .then((hits) => ({ hits, failed: false as const }))
      .catch(() => ({ hits: [], failed: true as const })),
    input.vector
      ? input.engine
          .searchVector(input.query, candidateK, input.repositoryId)
          .then((hits) => ({ hits, failed: false as const }))
          .catch(() => ({ hits: [], failed: true as const }))
      : Promise.resolve({ hits: [], failed: false as const }),
  ]);
  const ranked = reciprocalRankFusionV1([
    { weight: MEMORY_RRF_TEXT_WEIGHT_V1, hits: lexical.hits },
    ...(input.vector
      ? [{ weight: MEMORY_RRF_VECTOR_WEIGHT_V1, hits: vector.hits }]
      : []),
  ]).slice(0, candidateK);
  const entries = input.engine.getMany
    ? await input.engine.getMany(ranked.map((item) => item.id))
    : (
        await Promise.all(ranked.map((item) => input.engine.get(item.id)))
      ).filter((entry): entry is MemoryEntry => entry !== null);
  const rankedSourceIds = entries.flatMap((entry) => {
    const evidence = entry.evidence.find((ref) =>
      input.indexKind === "source_span"
        ? /#source-\d+$/.test(ref)
        : /#source-chunk-\d+$/.test(ref),
    );
    const match = evidence?.match(
      input.indexKind === "source_span"
        ? /^amb:document\/(.+)#source-\d+$/
        : /^amb:document\/(.+)#source-chunk-\d+$/,
    );
    return match?.[1] ? [match[1]] : [];
  });
  const uniqueSourceCount = new Set(rankedSourceIds).size;
  log("evidence_index_search", {
    indexKind: input.indexKind,
    queryHash: sha(input.query),
    requested: input.limit,
    candidateK,
    lexicalCandidates: lexical.hits.length,
    vectorCandidates: vector.hits.length,
    lexicalFailed: lexical.failed,
    vectorFailed: vector.failed,
    fusedCandidates: ranked.length,
    hydrated: entries.length,
    uniqueSourceCount,
    topSourceHashes: [
      ...new Set(rankedSourceIds.map((sourceId) => sha(sourceId).slice(0, 20))),
    ].slice(0, 16),
  });
  return entries;
}

function memoryEntryStatement(entry: MemoryEntry): string | null {
  if (entry.kind === "semantic") return entry.fact;
  if (entry.kind === "episodic") return entry.perspective || entry.whenToUse;
  if (entry.kind === "profile") return entry.insight;
  return null;
}

async function sceneSourcesForDocuments(
  userId: string,
  documentIds: readonly string[],
): Promise<
  Array<{
    sourceId: string;
    rank: number;
    atoms: Array<{
      id: string;
      kind: "semantic" | "episodic" | "profile";
      statement: string;
      sourceSeqs: number[];
      confidence: number;
      validFrom: string;
      validTo?: string;
    }>;
  }>
> {
  const entries = await engineFor(userId).query({ limit: 100_000 });
  return documentIds.map((documentId, rank) => {
    const prefix = `amb:document/${documentId}#atom-`;
    const atoms = entries.flatMap((entry) => {
      if (entry.kind === "vault_ref") return [];
      const statement = memoryEntryStatement(entry);
      if (!statement) return [];
      const sourceSeqs = entry.evidence.flatMap((ref) => {
        if (!ref.startsWith(prefix)) return [];
        const seq = Number(ref.slice(prefix.length));
        return Number.isSafeInteger(seq) && seq > 0 ? [seq] : [];
      });
      if (sourceSeqs.length === 0) return [];
      return [
        {
          id: entry.id,
          kind: entry.kind,
          statement,
          sourceSeqs: [...new Set(sourceSeqs)],
          confidence: entry.confidence,
          validFrom: entry.tValid,
          ...(entry.tInvalid === null ? {} : { validTo: entry.tInvalid }),
        },
      ];
    });
    return { sourceId: documentId, rank, atoms };
  });
}

async function sceneSnapshotForUser(userId: string): Promise<{
  snapshot: MemorySceneSnapshotV1;
  persona: MemoryPersonaProjectionV1;
}> {
  const revision = await engineFor(userId).retrievalRevisionToken();
  const cached = sceneSnapshots.get(userId);
  if (cached?.revision === revision) {
    return { snapshot: cached.snapshot, persona: cached.persona };
  }
  const documentIds = [...(documentIdsByUser.get(userId) ?? [])].sort();
  const snapshot = createMemorySceneSnapshotV1({
    scopeFingerprint: memoryScopeFingerprintV1(scopeFor(userId)),
    projectionRevision: revision,
    sources: await sceneSourcesForDocuments(userId, documentIds),
    maxIndexChars: atomSceneIndexMaxChars,
  });
  const persona = projectSourceGroundedPersonaV1({
    snapshot,
    maxChars: atomPersonaMaxChars,
  });
  sceneSnapshots.set(userId, { revision, snapshot, persona });
  log("scene_snapshot", {
    userFingerprint: sha(userId).slice(0, 20),
    snapshotKey: snapshot.snapshotKey,
    projectionRevisionHash: sha(revision),
    indexEntries: snapshot.indexEntries.length,
    indexChars: snapshot.indexText.length,
    personaKey: persona.projectionKey,
    personaClaims: persona.claims.length,
    personaSources: persona.sourceCount,
    personaChars: persona.text.length,
  });
  return { snapshot, persona };
}

function sourceDocumentIdFromEvidenceV1(ref: string): string | undefined {
  if (!ref.startsWith("amb:document/")) return undefined;
  const value = ref.slice("amb:document/".length);
  const fragment = value.indexOf("#");
  const documentId = (fragment < 0 ? value : value.slice(0, fragment)).trim();
  return documentId || undefined;
}

function isMemoryConversationTurnKindV1(
  value: string,
): value is MemoryConversationTurnKindV1 {
  return (
    value === "user_input" ||
    value === "assistant_output" ||
    value === "tool_observation" ||
    value === "verification" ||
    value === "outcome" ||
    value === "source_document"
  );
}

async function retrieve(params: Record<string, unknown>): Promise<unknown> {
  const queryText = asString(params.query, "query");
  const queryTimeCutoff = parseAmbQueryTimeCutoffV1(params.queryTimestamp);
  const toolMode =
    typeof params.toolMode === "string" && params.toolMode.trim()
      ? params.toolMode.trim()
      : "initial";
  const userId =
    typeof params.userId === "string" && params.userId
      ? params.userId
      : "default";
  const requestedK = Number(params.k ?? 10);
  const k = Number.isSafeInteger(requestedK)
    ? Math.max(1, Math.min(16, requestedK))
    : 10;
  const scope = scopeFor(userId);
  const queryHash = sha(queryText);
  const queryContractHash = sha(
    `${queryHash}\n${queryTimeCutoff?.normalizedIso ?? "latest"}`,
  );
  const queryId = sha(`${runKey}\n${userId}\n${queryContractHash}\n${k}`);
  const requestedEvidenceRefs = Array.isArray(params.evidenceRefs)
    ? params.evidenceRefs
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean)
        .slice(0, 8)
    : [];
  const requestedMemoryIds = Array.isArray(params.memoryIds)
    ? params.memoryIds
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean)
        .slice(0, 16)
    : [];
  pendingCacheEvents = [];
  const started = performance.now();
  const result: MemoryProviderResultV1 =
    toolMode === "resolve_context"
      ? Object.freeze({
          status: "completed" as const,
          cards: Object.freeze([]),
        })
      : await providerFor(userId).retrieve(
          Object.freeze({
            queryId,
            trigger: "task_start" as const,
            text: queryText,
            inputId: `amb-${queryContractHash.slice(0, 20)}`,
            inputContentHash: queryContractHash,
            scope,
            maxCards: k,
            maxInjectedTokens: 4_096,
          }),
          new AbortController().signal,
        );
  const futureExcludedDocumentIds = new Set<string>();
  function documentVisibleAtQuery(documentId: string): boolean {
    const visible = isAmbDocumentVisibleAtQueryV1(
      documentCreatedByUser.get(userId)?.get(documentId),
      queryTimeCutoff,
    );
    if (!visible) futureExcludedDocumentIds.add(documentId);
    return visible;
  }
  const atomDocuments = result.cards
    .map((card) => {
      const evidences = card.sources
        .map((source) => source.ref)
        .filter((ref) => ref.startsWith("amb:document/"));
      const evidence = evidences[0];
      const documentId =
        (evidence ? sourceDocumentIdFromEvidenceV1(evidence) : undefined) ??
        card.id;
      return {
        id: documentId,
        content: card.statement,
        user_id: userId,
        metadata: { memoryId: card.id, evidence, evidences },
      };
    })
    .filter((document) => documentVisibleAtQuery(document.id));
  let expandedSourceDocuments = 0;
  let projectedSceneCount = 0;
  let projectedSceneAtomCount = 0;
  let selectedSourceChunkCount = 0;
  let memoryRoute: string | null = null;
  let stablePrefixHash: string | null = null;
  let stablePrefixChars = 0;
  let dynamicMemoryChars = 0;
  let routedFallback = false;
  let personaHash: string | null = null;
  let personaChars = 0;
  let personaClaims = 0;
  let personaInjected = false;
  let topicIndexRevision: string | null = null;
  let topicIndexCount = 0;
  let topicEvidenceStateCount = 0;
  let rawEvidenceSpanCount = 0;
  let rawEvidenceChars = 0;
  let toolPayload: Readonly<Record<string, unknown>> | undefined;
  let coverageStatus: "completed" | "noop" | "failed" | null = null;
  let coverageRequirementCount = 0;
  let coverageCoveredCount = 0;
  let coveragePartialCount = 0;
  let coverageMissingCount = 0;
  let coverageExpansionTopicCount = 0;
  let coverageSupplementalStateCount = 0;
  let evidenceFirstL0CandidateCount = 0;
  let evidenceFirstL0SpanCandidateCount = 0;
  let evidenceFirstConversationCandidateCount = 0;
  let evidenceFirstConfirmedDialogueCount = 0;
  let evidenceFirstAssistantRecallCount = 0;
  let evidenceFirstQueryExpansionCount = 0;
  let evidenceFirstQueryExpansionStatus: string = evidenceQueryPlanner
    ? "not_needed"
    : "disabled";
  let evidenceFirstSupportSelectorStatus: string = evidenceSupportSelector
    ? "not_needed"
    : "disabled";
  let evidenceFirstDirectCertificateStatus = "not_evaluated";
  let evidenceFirstClosureAuditStatus = evidenceClosureAuditor
    ? "not_evaluated"
    : "not_configured";
  let evidenceFirstClosureVerdict = "not_evaluated";
  let evidenceFirstClosureRepairCount = 0;
  let evidenceFirstContextStop = "not_evaluated";
  let evidenceFirstVerificationStatus = "not_evaluated";
  const evidenceIntent = classifyMemoryEvidenceQueryV3(queryText);
  const evidenceFirstInitialRoleConstraint = evidenceIntent.roleConstraint;
  const evidenceFirstRoleResolutionRequested =
    evidenceIntent.roleConstraint === "any" &&
    needsMemoryEvidenceRoleResolutionV1(queryText);
  let evidenceFirstRoleResolutionStatus = evidenceFirstRoleResolutionRequested
    ? "pending"
    : "not_needed";
  let evidenceFirstPlanAnswerShape: string = evidenceIntent.answerShape;
  let evidenceFirstPlanTemporalMode: string = evidenceIntent.temporalMode;
  let evidenceFirstPlanRoleConstraint: string = evidenceIntent.roleConstraint;
  let evidenceFirstPlanRequirementCount = 0;
  let evidenceFirstNotebookCoveredCount = 0;
  let evidenceFirstNotebookPartialCount = 0;
  let evidenceFirstNotebookMissingCount = 0;
  let evidenceFirstNotebookHitCount = 0;
  let evidenceFirstNotebookIndependentEvidenceCount = 0;
  let evidenceFirstNotebookClosureEvidenceCount = 0;
  let evidenceFirstNotebookUnresolvedEvidenceCount = 0;
  let evidenceFirstNotebookChars = 0;
  // L0 ingestion does not yet produce a stable cross-session event key. Keep
  // the fallback explicit in telemetry so episode diversity is never reported
  // as semantic event deduplication.
  const evidenceFirstEventIdentityMode = "episode_fallback";
  const evidenceFirstEventKeyCoverageRate = 0;
  let evidenceFirstL1CandidateCount = 0;
  let evidenceFirstFusedCandidateCount = 0;
  let evidenceFirstDualChannelCount = 0;
  let evidenceFirstSelectedSourceCount = 0;
  let documents = atomDocuments;
  const grouped = new Map<
    string,
    {
      statements: string[];
      memoryIds: string[];
      evidence: string[];
      sourceSeqs: number[];
    }
  >();
  if (ingestMode === "atom" && atomContextMode !== "atom_only") {
    for (const document of atomDocuments) {
      const group = grouped.get(document.id) ?? {
        statements: [],
        memoryIds: [],
        evidence: [],
        sourceSeqs: [],
      };
      group.statements.push(document.content);
      group.memoryIds.push(document.metadata.memoryId);
      for (const evidence of document.metadata.evidences) {
        group.evidence.push(evidence);
        const match = evidence.match(/#atom-(\d+)$/);
        if (match?.[1]) group.sourceSeqs.push(Number(match[1]));
      }
      grouped.set(document.id, group);
    }
  }
  async function buildHybridDocuments() {
    const atomSummaryDocuments = [...grouped.entries()].map(
      ([documentId, group]) => ({
        id: documentId,
        content: `[Memory atoms]\n${group.statements.join("\n")}`,
        user_id: userId,
        metadata: {
          memoryId: group.memoryIds[0] ?? documentId,
          memoryIds: group.memoryIds,
          evidence: group.evidence[0],
          evidences: group.evidence,
        },
      }),
    );
    const sourceCandidates = (
      await Promise.all(
        [...grouped.keys()].map((documentId) =>
          sourceChunksForDocument(userId, documentId),
        ),
      )
    ).flat();
    const atomStatements = [...grouped.values()].flatMap(
      (group) => group.statements,
    );
    const atomSummaryChars = atomSummaryDocuments.reduce(
      (total, document) => total + document.content.length,
      0,
    );
    const selectedChunks = selectAmbSourceChunksV1({
      chunks: sourceCandidates,
      query: queryText,
      atomStatements,
      maxChars: Math.max(
        256,
        atomSourceContextMaxChars - atomSummaryChars - 1_024,
      ),
    });
    expandedSourceDocuments = new Set(
      selectedChunks.map((chunk) => chunk.documentId),
    ).size;
    selectedSourceChunkCount = selectedChunks.length;
    return [
      ...atomSummaryDocuments,
      ...selectedChunks.map((chunk) => ({
        id: chunk.documentId,
        content: `[Contiguous source evidence]\n${chunk.text}`,
        user_id: userId,
        metadata: {
          memoryId: `source-chunk-${chunk.index}`,
          memoryIds: [] as string[],
          evidence: `amb:document/${chunk.documentId}#source-chunk-${chunk.index}`,
          evidences: [
            `amb:document/${chunk.documentId}#source-chunk-${chunk.index}`,
          ],
        },
      })),
    ];
  }
  async function searchL0SourceChunks(searchText = queryText, searchLimit = k) {
    const entries = await searchEvidenceIndexEntriesV2({
      engine: sourceChunkEngineFor(userId),
      query: searchText,
      limit: searchLimit,
      repositoryId: sourceChunkScopeFor(userId).repositoryId,
      vector: Boolean(sourceChunkEmbedding),
      indexKind: "source_chunk",
    });
    const selectedChunks: Array<{
      documentId: string;
      index: number;
      text: string;
      evidenceRef: string;
    }> = [];
    for (const entry of entries) {
      const evidence = entry.evidence.find((ref) =>
        /#source-chunk-\d+$/.test(ref),
      );
      const match = evidence?.match(/^amb:document\/(.+)#source-chunk-(\d+)$/);
      if (!match?.[1] || match[2] === undefined) continue;
      selectedChunks.push({
        documentId: match[1],
        index: Number(match[2]),
        text: entry.kind === "episodic" ? entry.whenToUse : "",
        evidenceRef: evidence ?? match[0],
      });
    }
    return selectedChunks;
  }
  async function searchL0SourceSpans(searchText = queryText, searchLimit = 16) {
    const entries = await searchEvidenceIndexEntriesV2({
      engine: sourceEngineFor(userId),
      query: searchText,
      limit: searchLimit,
      repositoryId: sourceScopeFor(userId).repositoryId,
      vector: Boolean(sourceSpanEmbedding),
      indexKind: "source_span",
    });
    const spans: Array<{
      documentId: string;
      sourceSeq: number;
      text: string;
      evidenceRef: string;
      sourceKind:
        | "user_input"
        | "assistant_output"
        | "tool_observation"
        | "verification"
        | "outcome"
        | "source_document";
      authority: "user_asserted" | "context_only" | "mixed";
    }> = [];
    for (const entry of entries) {
      const evidence = entry.evidence.find((ref) => /#source-\d+$/.test(ref));
      const match = evidence?.match(/^amb:document\/(.+)#source-(\d+)$/);
      if (!match?.[1] || match[2] === undefined) continue;
      const rawKind =
        sourceKindByUser.get(userId)?.get(evidence ?? "") ??
        (entry.kind === "episodic" ? entry.issueType : "");
      const sourceKind =
        rawKind === "user_input" ||
        rawKind === "assistant_output" ||
        rawKind === "tool_observation" ||
        rawKind === "verification" ||
        rawKind === "outcome" ||
        rawKind === "source_document"
          ? rawKind
          : "source_document";
      const authority =
        sourceKind === "user_input"
          ? "user_asserted"
          : sourceKind === "assistant_output"
            ? "context_only"
            : "mixed";
      spans.push({
        documentId: match[1],
        sourceSeq: Number(match[2]),
        text: entry.kind === "episodic" ? entry.whenToUse : "",
        evidenceRef: evidence ?? match[0],
        sourceKind,
        authority,
      });
    }
    return spans;
  }
  async function searchL0ConversationSpans(searchText = queryText) {
    const archive = rawEvidenceArchiveFor(userId);
    if (!archive.search) return [];
    const boundedQuery = searchText.trim().replace(/\s+/gu, " ").slice(0, 512);
    if (!boundedQuery) return [];
    const spans = await archive.search(
      {
        query: boundedQuery,
        maxSpans: 16,
        maxChars: Math.min(16_384, atomSourceContextMaxChars),
      },
      new AbortController().signal,
    );
    return spans.flatMap((span) => {
      const match = span.evidenceRef.match(
        /^amb:document\/(.+)#(?:atom|source)-(\d+)$/,
      );
      if (!match?.[1] || match[2] === undefined) return [];
      return [
        {
          documentId: match[1],
          sourceSeq: Number(match[2]),
          text: span.content,
          hitText: span.hitContent,
          sourceKind: span.sourceKind,
          authority: span.authority,
          evidenceRef: span.evidenceRef,
        },
      ];
    });
  }
  async function buildL0FallbackDocuments(
    searchText = queryText,
    searchLimit = k,
  ) {
    const selectedChunks = await searchL0SourceChunks(searchText, searchLimit);
    if (selectedChunks.length === 0) return buildHybridDocuments();
    expandedSourceDocuments = new Set(
      selectedChunks.map((chunk) => chunk.documentId),
    ).size;
    selectedSourceChunkCount = selectedChunks.length;
    return selectedChunks.map((chunk) => ({
      id: chunk.documentId,
      // Do not add another wrapper or character budget here. The provider has
      // already applied the same maxCards/maxInjectedTokens policy as raw mode.
      content: chunk.text,
      user_id: userId,
      metadata: {
        memoryId: `source-chunk-${chunk.index}`,
        memoryIds: [] as string[],
        evidence: `amb:document/${chunk.documentId}#source-chunk-${chunk.index}`,
        evidences: [
          `amb:document/${chunk.documentId}#source-chunk-${chunk.index}`,
        ],
      },
    }));
  }
  async function buildEvidenceFirstDocuments() {
    type AmbEvidenceIndexSearch = Readonly<{
      candidates: Awaited<ReturnType<typeof searchL0SourceChunks>>;
      spans: Awaited<ReturnType<typeof searchL0SourceSpans>>;
      conversations: Awaited<ReturnType<typeof searchL0ConversationSpans>>;
      lists: readonly MemoryEvidenceCandidateRankListV2[];
      hits: readonly MemoryEvidenceNotebookHitV1[];
    }>;
    const searchResultByText = new Map<string, AmbEvidenceIndexSearch>();
    async function searchEvidenceIndex(
      searchText: string,
    ): Promise<AmbEvidenceIndexSearch> {
      const cached = searchResultByText.get(searchText);
      if (cached) return cached;
      const pending = (async () => {
        const [rawCandidates, rawSpans, rawConversations] = await Promise.all([
          searchL0SourceChunks(searchText, 16),
          searchL0SourceSpans(
            searchText,
            evidenceIntent.answerShape === "recommend" ? 32 : 16,
          ),
          searchL0ConversationSpans(searchText),
        ]);
        const candidates = rawCandidates.filter((chunk) =>
          documentVisibleAtQuery(chunk.documentId),
        );
        const spans = rawSpans.filter((span) =>
          documentVisibleAtQuery(span.documentId),
        );
        const conversations = rawConversations.filter((span) =>
          documentVisibleAtQuery(span.documentId),
        );
        return {
          candidates,
          spans,
          conversations,
          lists: [
            {
              channel: "l0" as const,
              retrieverId: "source-chunk",
              weight: 0.65,
              candidates: candidates.map((chunk) => ({
                candidateId: chunk.evidenceRef,
                sourceId: chunk.documentId,
                evidenceRef: chunk.evidenceRef,
                sourceKind: "source_chunk" as const,
                authority: "mixed" as const,
                observedAt: documentCreatedByUser
                  .get(userId)
                  ?.get(chunk.documentId),
              })),
            },
            {
              channel: "l0" as const,
              retrieverId: "source-span",
              weight: 1,
              candidates: spans.map((span) => ({
                candidateId: span.evidenceRef,
                sourceId: span.documentId,
                evidenceRef: span.evidenceRef,
                sourceKind: span.sourceKind,
                authority: span.authority,
                observedAt: documentCreatedByUser
                  .get(userId)
                  ?.get(span.documentId),
              })),
            },
            {
              channel: "l0" as const,
              retrieverId: "conversation-span",
              weight: 1.05,
              candidates: conversations.map((span) => ({
                candidateId: span.evidenceRef,
                sourceId: span.documentId,
                evidenceRef: span.evidenceRef,
                sourceKind: span.sourceKind,
                authority: span.authority,
                observedAt: documentCreatedByUser
                  .get(userId)
                  ?.get(span.documentId),
              })),
            },
            {
              channel: "l1" as const,
              retrieverId: "derived-atom",
              weight: 0.75,
              candidates: atomDocuments.map((document) => ({
                candidateId: `l1:${document.metadata.memoryId}`,
                sourceId: document.id,
                evidenceRef:
                  document.metadata.evidence ?? `amb:document/${document.id}`,
                sourceKind: "derived_atom" as const,
                authority: "derived" as const,
                observedAt: documentCreatedByUser.get(userId)?.get(document.id),
              })),
            },
          ],
          // Hydrate the notebook from exact conversation turns first, matching
          // the product adapter's hitContent contract. Semantic source spans
          // remain a fallback but must not hide an exact lexical turn that was
          // already found inside a primary-selected source.
          hits: [
            ...conversations.map((span) => ({
              sourceId: span.documentId,
              evidenceRef: span.evidenceRef,
              content: span.hitText,
              authority: span.authority,
              observedAt: documentCreatedByUser
                .get(userId)
                ?.get(span.documentId),
              episodeOrder: documentOrderByUser
                .get(userId)
                ?.get(span.documentId),
              turnOrder: span.sourceSeq,
            })),
            ...spans.map((span) => ({
              sourceId: span.documentId,
              evidenceRef: span.evidenceRef,
              content: span.text,
              authority: span.authority,
              observedAt: documentCreatedByUser
                .get(userId)
                ?.get(span.documentId),
              episodeOrder: documentOrderByUser
                .get(userId)
                ?.get(span.documentId),
              turnOrder: span.sourceSeq,
            })),
          ].filter(
            (hit, index, hits) =>
              hits.findIndex(
                (candidate) => candidate.evidenceRef === hit.evidenceRef,
              ) === index,
          ),
        };
      })();
      searchResultByText.set(searchText, await pending);
      return pending;
    }
    async function locateEvidenceWithinSources(
      request: MemorySourceLocalEvidenceRequestV1,
    ): Promise<MemorySourceLocalEvidenceResultV1> {
      const started = Date.now();
      const locatorQuery = request.requirement.searchText
        .replace(/\s+/gu, " ")
        .trim();
      const engine = sourceEngineFor(userId);
      const allowed = new Set(request.lockedSourceIds);
      const blockIdsByDocument = sourceBlockIdsByUserDocument.get(userId);
      const allowedIds = request.lockedSourceIds.flatMap(
        (documentId) => blockIdsByDocument?.get(documentId) ?? [],
      );
      const turnIndexRevision = await engine.retrievalRevisionToken();
      const cacheKey = memorySourceLocalEvidenceCacheKeyV1({
        locatorVersion:
          "paw.amb-source-local-locator.v3:logical-address-certified-rrf",
        scopeFingerprint: sha(JSON.stringify(sourceScopeFor(userId))),
        turnIndexRevision,
        embeddingIdentity: sourceSpanEmbedding
          ? `${sourceSpanEmbedding.model}@${sourceSpanEmbedding.version}`
          : "none",
        request,
        adjacencyPolicyVersion:
          PAW_MEMORY_CONVERSATION_BUNDLE_POLICY_VERSION_V1,
        rankerVersion: "paw.amb-source-local-ranker.v1:rrf",
      });
      const cached = sourceLocalLocatorCache.get(cacheKey);
      if (cached) {
        const replay = Object.freeze({
          ...cached,
          telemetry: Object.freeze({
            ...cached.telemetry,
            cacheHit: true,
            durationMs: Date.now() - started,
          }),
        });
        log("source_local_locator", {
          status: "cache_hit",
          locatorVersion: replay.locatorVersion,
          requirementIdHash: sha(request.requirement.requirementId).slice(
            0,
            20,
          ),
          sourceSetDigest: sha([...allowed].sort().join("\n")),
          lockedSourceCount: allowed.size,
          lockedSourceHashes: contentFreeSourceHashes(allowed),
          anchorCount: replay.hits.length,
          anchorSourceHashes: contentFreeSourceHashes(
            replay.hits.map((hit) => hit.sourceId),
          ),
          cacheHit: true,
          durationMs: replay.telemetry.durationMs,
        });
        return replay;
      }
      const filter = {
        allowedIds,
        issueType: "assistant_output",
        ...(request.evidenceTimeUpperBound === undefined
          ? {}
          : { createdAtUpperBound: request.evidenceTimeUpperBound }),
      };
      const [lexical, dense] = await Promise.all([
        engine
          .searchText(
            locatorQuery,
            request.budget.maxCandidatesPerChannel,
            sourceScopeFor(userId).repositoryId,
            filter,
          )
          .then((hits) => ({ hits, failed: false as const }))
          .catch(() => ({ hits: [], failed: true as const })),
        sourceSpanEmbedding
          ? engine
              .searchVector(
                locatorQuery,
                request.budget.maxCandidatesPerChannel,
                sourceScopeFor(userId).repositoryId,
                filter,
              )
              .then((hits) => ({ hits, failed: false as const }))
              .catch(() => ({ hits: [], failed: true as const }))
          : Promise.resolve({ hits: [], failed: false as const }),
      ]);
      const ranked = reciprocalRankFusionV1([
        { weight: MEMORY_RRF_TEXT_WEIGHT_V1, hits: lexical.hits },
        ...(sourceSpanEmbedding
          ? [{ weight: MEMORY_RRF_VECTOR_WEIGHT_V1, hits: dense.hits }]
          : []),
      ]);
      const entries = engine.getMany
        ? await engine.getMany(ranked.map((item) => item.id))
        : (await Promise.all(ranked.map((item) => engine.get(item.id)))).filter(
            (entry): entry is MemoryEntry => entry !== null,
          );
      const anchors = entries.flatMap((entry) => {
        if (
          entry.kind !== "episodic" ||
          entry.issueType !== "assistant_output" ||
          !entry.whenToUse.trim()
        ) {
          return [];
        }
        const physicalEvidenceRef = entry.evidence.find((ref) =>
          /#source-\d+$/.test(ref),
        );
        const documentId = physicalEvidenceRef
          ? sourceDocumentIdFromEvidenceV1(physicalEvidenceRef)
          : undefined;
        const evidenceRef = physicalEvidenceRef
          ? logicalSourceLocalEvidenceRefV1(physicalEvidenceRef)
          : undefined;
        const sourceSeq = Number(/#source-(\d+)$/.exec(evidenceRef ?? "")?.[1]);
        if (
          !evidenceRef ||
          !documentId ||
          !allowed.has(documentId) ||
          !documentVisibleAtQuery(documentId) ||
          !Number.isSafeInteger(sourceSeq) ||
          sourceSeq < 1
        ) {
          return [];
        }
        return [{ documentId, sourceSeq, evidenceRef }];
      });
      const perSource = new Map<string, number>();
      const hits = [];
      let renderedChars = 0;
      let uncertifiedAnchorCount = 0;
      for (const anchor of anchors) {
        if (hits.length >= request.budget.maxAnchors) break;
        const sourceCount = perSource.get(anchor.documentId) ?? 0;
        if (sourceCount >= request.budget.maxAnchorsPerSource) continue;
        const remaining = request.budget.maxChars - renderedChars;
        if (remaining < 256) break;
        const neighborEntries = (
          await Promise.all(
            Array.from(
              { length: request.budget.neighborRadius * 2 + 1 },
              (_, index) =>
                anchor.sourceSeq - request.budget.neighborRadius + index,
            )
              .filter((sourceSeq) => sourceSeq > 0)
              .map((sourceSeq) =>
                engine.get(sourceBlockId(userId, anchor.documentId, sourceSeq)),
              ),
          )
        ).filter(
          (entry): entry is MemoryEntry =>
            entry !== null &&
            entry.kind === "episodic" &&
            isMemoryConversationTurnKindV1(entry.issueType),
        );
        const turns = neighborEntries.flatMap((entry) => {
          if (entry.kind !== "episodic") return [];
          const physicalEvidenceRef = entry.evidence.find((ref) =>
            /#source-\d+$/.test(ref),
          );
          const evidenceRef = physicalEvidenceRef
            ? logicalSourceLocalEvidenceRefV1(physicalEvidenceRef)
            : undefined;
          const sourceSeq = Number(
            /#source-(\d+)$/.exec(evidenceRef ?? "")?.[1],
          );
          if (!evidenceRef || !Number.isSafeInteger(sourceSeq)) return [];
          return [
            {
              evidenceRef,
              sourceSeq,
              sourceKind: entry.issueType as MemoryConversationTurnKindV1,
              content: entry.whenToUse,
              hit: evidenceRef === anchor.evidenceRef,
            },
          ];
        });
        const bundle = buildMemoryConversationTurnBundleV1({
          turns,
          query: locatorQuery,
          maxChars: Math.min(2_400, remaining),
        });
        if (
          request.requirement.roleConstraint === "any" &&
          !hasMemorySourceLocalDialogueCertificateV1(
            bundle.includedEvidence,
            anchor.sourceSeq,
          )
        ) {
          uncertifiedAnchorCount += 1;
          continue;
        }
        hits.push(
          Object.freeze({
            sourceId: anchor.documentId,
            evidenceRef: anchor.evidenceRef,
            anchorEvidenceRef: anchor.evidenceRef,
            sourceKind: "assistant_output" as const,
            content: bundle.text,
            authority: bundle.authority,
            observedAt: documentCreatedByUser
              .get(userId)
              ?.get(anchor.documentId),
            episodeOrder: documentOrderByUser
              .get(userId)
              ?.get(anchor.documentId),
            turnOrder: anchor.sourceSeq,
            contextEvidenceRefs: Object.freeze(
              bundle.includedEvidence.map((turn) => turn.evidenceRef),
            ),
            includedTurns: Object.freeze(
              bundle.includedEvidence.map((turn) => ({
                ...turn,
                observedAt: documentCreatedByUser
                  .get(userId)
                  ?.get(anchor.documentId),
              })),
            ),
          }),
        );
        perSource.set(anchor.documentId, sourceCount + 1);
        renderedChars += bundle.text.length;
      }
      const degradedChannels = Object.freeze([
        ...(lexical.failed ? (["lexical"] as const) : []),
        ...(dense.failed ? (["dense"] as const) : []),
      ]);
      const result = Object.freeze({
        locatorVersion:
          "paw.amb-source-local-locator.v3:logical-address-certified-rrf",
        locatorRevision: sha(
          JSON.stringify({
            turnIndexRevision,
            evidenceRefs: hits.map((hit) => hit.evidenceRef),
            contextEvidenceRefs: hits.map((hit) => hit.contextEvidenceRefs),
          }),
        ),
        hits: Object.freeze(hits),
        degradedChannels,
        telemetry: Object.freeze({
          lexicalCandidates: lexical.hits.length,
          denseCandidates: dense.hits.length,
          anchorCount: hits.length,
          includedTurnCount: hits.reduce(
            (total, hit) => total + hit.includedTurns.length,
            0,
          ),
          renderedChars,
          cacheHit: false,
          durationMs: Date.now() - started,
        }),
      }) satisfies MemorySourceLocalEvidenceResultV1;
      if (degradedChannels.length === 0) {
        sourceLocalLocatorCache.set(cacheKey, result);
        if (sourceLocalLocatorCache.size > 2_048) {
          const oldest = sourceLocalLocatorCache.keys().next().value;
          if (oldest) sourceLocalLocatorCache.delete(oldest);
        }
      }
      log("source_local_locator", {
        status: degradedChannels.length === 0 ? "completed" : "degraded",
        locatorVersion: result.locatorVersion,
        requirementIdHash: sha(request.requirement.requirementId).slice(0, 20),
        sourceSetDigest: sha([...allowed].sort().join("\n")),
        lockedSourceCount: allowed.size,
        lockedSourceHashes: contentFreeSourceHashes(allowed),
        lexicalCandidateCount: lexical.hits.length,
        denseCandidateCount: dense.hits.length,
        anchorCount: hits.length,
        anchorSourceHashes: contentFreeSourceHashes(
          hits.map((hit) => hit.sourceId),
        ),
        includedTurnCount: result.telemetry.includedTurnCount,
        uncertifiedAnchorCount,
        renderedChars,
        cacheHit: false,
        durationMs: result.telemetry.durationMs,
      });
      return result;
    }
    const sharedResolver = createMemoryEvidenceResolverV1({
      index: {
        indexVersion: "paw.amb-turn-evidence-index.v1",
        async search(searchText) {
          const result = await searchEvidenceIndex(searchText);
          return { lists: result.lists, hits: result.hits };
        },
      },
      ...(evidenceQueryPlanner === undefined
        ? {}
        : { planner: evidenceQueryPlanner }),
      ...(evidenceSupportSelector === undefined
        ? {}
        : { supportSelector: evidenceSupportSelector }),
      ...(sourceLocalLocatorEnabled
        ? {
            sourceLocalLocator: Object.freeze({
              locatorVersion:
                "paw.amb-source-local-locator.v3:logical-address-certified-rrf",
              locate(request: MemorySourceLocalEvidenceRequestV1) {
                return locateEvidenceWithinSources(request);
              },
            }),
            sourceLocalHydrator: Object.freeze({
              hydratorVersion:
                "paw.amb-source-local-hydrator.v3:logical-immutable-archive",
              async hydrate(
                evidenceRefs: readonly string[],
                signal: AbortSignal,
              ) {
                const started = Date.now();
                const archive = rawEvidenceArchiveFor(userId);
                if (!archive.hydrate) {
                  throw new Error(
                    "immutable raw evidence hydration unavailable",
                  );
                }
                const currentAddresses = evidenceRefs.flatMap((evidenceRef) => {
                  const physicalRef =
                    immutableSourceTurnEvidenceRefV1(evidenceRef);
                  return physicalRef ? [{ evidenceRef, physicalRef }] : [];
                });
                const directlyHydrated = await archive.hydrate(
                  currentAddresses.map((item) => item.physicalRef),
                  signal,
                );
                const directByPhysicalRef = new Map(
                  directlyHydrated.map(
                    (row) => [row.evidenceRef, row] as const,
                  ),
                );
                const directByRef = new Map(
                  currentAddresses.flatMap(({ evidenceRef, physicalRef }) => {
                    const row = directByPhysicalRef.get(physicalRef);
                    return row
                      ? [
                          [
                            evidenceRef,
                            Object.freeze({ ...row, evidenceRef }),
                          ] as const,
                        ]
                      : [];
                  }),
                );
                // Existing 500-user indexes predate the source-ref alias. The
                // corresponding atom-ref points at the same immutable L0 turn,
                // so map the address without reading the mutable search index.
                const legacyAddresses = evidenceRefs.flatMap((evidenceRef) => {
                  if (directByRef.has(evidenceRef)) return [];
                  const legacyRef =
                    legacyImmutableTurnEvidenceRefV1(evidenceRef);
                  return legacyRef ? [{ evidenceRef, legacyRef }] : [];
                });
                const legacyHydrated =
                  legacyAddresses.length === 0
                    ? []
                    : await archive.hydrate(
                        legacyAddresses.map((item) => item.legacyRef),
                        signal,
                      );
                const legacyByRef = new Map(
                  legacyHydrated.map((row) => [row.evidenceRef, row] as const),
                );
                const hydrated = Object.freeze(
                  evidenceRefs.flatMap((evidenceRef) => {
                    const direct = directByRef.get(evidenceRef);
                    if (direct) return [direct];
                    const legacyRef = legacyAddresses.find(
                      (item) => item.evidenceRef === evidenceRef,
                    )?.legacyRef;
                    const legacy = legacyRef
                      ? legacyByRef.get(legacyRef)
                      : undefined;
                    return legacy
                      ? [Object.freeze({ ...legacy, evidenceRef })]
                      : [];
                  }),
                );
                log("source_local_hydrator", {
                  status:
                    hydrated.length === evidenceRefs.length
                      ? "completed"
                      : "incomplete",
                  hydratorVersion:
                    "paw.amb-source-local-hydrator.v3:logical-immutable-archive",
                  requestedCount: evidenceRefs.length,
                  returnedCount: hydrated.length,
                  directCount: directByRef.size,
                  legacyMappedCount: hydrated.length - directByRef.size,
                  cacheHit: false,
                  durationMs: Date.now() - started,
                });
                return hydrated;
              },
            }),
          }
        : {}),
      ...(queryTimeCutoff === undefined
        ? {}
        : { evidenceTimeUpperBound: queryTimeCutoff.normalizedIso }),
      ...(evidenceClosureAuditor === undefined
        ? {}
        : { closureAuditor: evidenceClosureAuditor }),
      maxSources: Math.min(8, Math.max(4, k)),
      maxEvidencePerSource: 8,
      maxHitsPerRequirement: 4,
      maxNotebookChars: Math.min(
        4_096,
        Math.max(512, Math.floor(atomSourceContextMaxChars * 0.3)),
      ),
    });
    const resolution = await sharedResolver.resolve(
      queryText,
      new AbortController().signal,
    );
    const evidenceContextPacket =
      projectEvidenceFirstMemoryContextPacketV1(resolution);
    const evidenceAnswerContract = projectEvidenceFirstMemoryAnswerContractV1(
      resolution,
      evidenceContextPacket,
    );
    const evidenceAnswerContractText = [
      "[Trusted memory control metadata; this block is not factual evidence]",
      JSON.stringify(evidenceAnswerContract),
      "[End trusted memory control metadata]",
    ].join("\n");
    evidenceFirstContextStop = evidenceContextPacket.stop;
    evidenceFirstVerificationStatus = evidenceContextPacket.verification.status;
    evidenceFirstPlanAnswerShape = resolution.intent.answerShape;
    evidenceFirstPlanTemporalMode = resolution.intent.temporalMode;
    evidenceFirstPlanRoleConstraint = resolution.intent.roleConstraint;
    evidenceFirstRoleResolutionStatus = evidenceFirstRoleResolutionRequested
      ? resolution.plannerStatus !== "completed"
        ? "fallback"
        : "preserved"
      : "not_needed";
    evidenceFirstPlanRequirementCount = resolution.requirements.length;
    evidenceFirstQueryExpansionCount = resolution.requirements.filter(
      (requirement) => requirement.searchText !== queryText,
    ).length;
    evidenceFirstQueryExpansionStatus = resolution.plannerStatus;
    evidenceFirstSupportSelectorStatus = resolution.supportSelectorStatus;
    evidenceFirstDirectCertificateStatus = resolution.directCertificateStatus;
    evidenceFirstClosureAuditStatus = resolution.closureAuditStatus;
    evidenceFirstClosureVerdict = resolution.closureVerdict ?? "not_evaluated";
    evidenceFirstClosureRepairCount = resolution.closureRepairCount;
    const searchResults = [...searchResultByText.values()];
    const l0Spans = searchResults.flatMap((result) => result.spans);
    const conversationSpans = searchResults.flatMap(
      (result) => result.conversations,
    );
    const fusion = {
      sources: resolution.sources,
      telemetry: resolution.telemetry,
    };
    evidenceFirstL0CandidateCount = fusion.telemetry.l0CandidateCount;
    evidenceFirstL0SpanCandidateCount = new Set(
      l0Spans.map((span) => span.documentId),
    ).size;
    evidenceFirstConversationCandidateCount = new Set(
      conversationSpans.map((span) => span.documentId),
    ).size;
    evidenceFirstConfirmedDialogueCount = conversationSpans.filter(
      (span) => span.authority === "user_confirmed_dialogue",
    ).length;
    const selectedEvidenceRefs = new Set(
      fusion.sources.flatMap((source) =>
        source.evidence.map((candidate) => candidate.evidenceRef),
      ),
    );
    const selectedConversationSpans = conversationSpans.filter((span) =>
      selectedEvidenceRefs.has(span.evidenceRef),
    );
    const assistantRecallSourceId =
      resolution.intent.roleConstraint !== "user"
        ? selectedConversationSpans.find(
            (span) =>
              span.sourceKind === "assistant_output" &&
              span.authority === "context_only",
          )?.documentId
        : undefined;
    evidenceFirstAssistantRecallCount = assistantRecallSourceId ? 1 : 0;
    evidenceFirstL1CandidateCount = fusion.telemetry.l1CandidateCount;
    evidenceFirstFusedCandidateCount = fusion.telemetry.fusedCandidateCount;
    evidenceFirstDualChannelCount = fusion.telemetry.dualChannelSourceCount;
    evidenceFirstSelectedSourceCount = fusion.telemetry.returnedSourceCount;
    log("evidence_first_selection", {
      queryHash: sha(queryText),
      selectedSources: fusion.sources.map((source) => ({
        sourceHash: sha(source.sourceId).slice(0, 20),
        bestRank: source.bestRank,
        channelHits: source.channelHits,
        evidenceCount: source.evidence.length,
      })),
      telemetry: fusion.telemetry,
    });
    const notebook = resolution.notebook;
    evidenceFirstNotebookCoveredCount = notebook.coverage.filter(
      (requirement) => requirement.status === "covered",
    ).length;
    evidenceFirstNotebookPartialCount = notebook.coverage.filter(
      (requirement) => requirement.status === "partial",
    ).length;
    evidenceFirstNotebookMissingCount = notebook.coverage.filter(
      (requirement) => requirement.status === "missing",
    ).length;
    evidenceFirstNotebookHitCount = notebook.selectedHitCount;
    evidenceFirstNotebookIndependentEvidenceCount = notebook.coverage.reduce(
      (total, requirement) => total + requirement.independentEvidenceCount,
      0,
    );
    evidenceFirstNotebookClosureEvidenceCount = notebook.coverage.reduce(
      (total, requirement) => total + requirement.closureEvidenceCount,
      0,
    );
    evidenceFirstNotebookUnresolvedEvidenceCount = notebook.coverage.reduce(
      (total, requirement) => total + requirement.unresolvedEvidenceRefs.length,
      0,
    );
    evidenceFirstNotebookChars = notebook.chars;
    log("evidence_notebook", {
      queryHash: sha(queryText),
      requirementCount: notebook.coverage.length,
      coveredCount: evidenceFirstNotebookCoveredCount,
      partialCount: evidenceFirstNotebookPartialCount,
      missingCount: evidenceFirstNotebookMissingCount,
      selectedHitCount: notebook.selectedHitCount,
      independentEvidenceCount: evidenceFirstNotebookIndependentEvidenceCount,
      closureEvidenceCount: evidenceFirstNotebookClosureEvidenceCount,
      unresolvedEvidenceCount: evidenceFirstNotebookUnresolvedEvidenceCount,
      sourceCount: notebook.sources.length,
      chars: notebook.chars,
      coverage: notebook.coverage.map((requirement) => ({
        requirementIdHash: sha(requirement.requirementId).slice(0, 20),
        status: requirement.status,
        selectedHitCount: requirement.selectedHitCount,
        independentEvidenceCount: requirement.independentEvidenceCount,
        closureEvidenceCount: requirement.closureEvidenceCount,
        unresolvedEvidenceCount: requirement.unresolvedEvidenceRefs.length,
      })),
    });
    log("evidence_closure_audit", {
      queryHash: sha(queryText),
      status: resolution.closureAuditStatus,
      verdict: resolution.closureVerdict ?? "not_evaluated",
      repairCount: resolution.closureRepairCount,
      finalRequirementCount: resolution.requirements.length,
      finalCoveredCount: evidenceFirstNotebookCoveredCount,
    });
    log("source_local_fusion", {
      queryHash: sha(queryText),
      status: resolution.sourceLocalization.status,
      reasonCode: resolution.sourceLocalization.reasonCode,
      failureCode: resolution.sourceLocalization.failureCode ?? null,
      locatorVersion: resolution.sourceLocalization.locatorVersion ?? null,
      hydratorVersion: resolution.sourceLocalization.hydratorVersion ?? null,
      localInvoked: new Set([
        "completed",
        "completed_empty",
        "fallback",
        "invalid_result",
      ]).has(resolution.sourceLocalization.status),
      localSelected: resolution.sourceLocalization.selectedCandidateCount,
      addedCandidateCount: resolution.sourceLocalization.addedCandidateCount,
      baselineSourceSetUnchanged: true,
      packetChanged: resolution.sourceLocalization.selectedCandidateCount > 0,
      extraLlmCalls:
        evidenceFirstRoleResolutionRequested &&
        resolution.plannerStatus === "completed"
          ? 1
          : 0,
      locatorExtraLlmCalls: 0,
    });
    expandedSourceDocuments = new Set(
      resolution.packetSources.map((source) => source.sourceId),
    ).size;
    rawEvidenceSpanCount = resolution.packetSources.length;
    memoryRoute = "evidence_first_spans";
    const output = resolution.packetSources.map((source, index) => {
      const authorityLabel =
        resolution.intent.roleConstraint === "assistant"
          ? "[Assistant-output evidence]\nAuthority rule: use only to recall the assistant's prior output or action; never as a user fact."
          : resolution.intent.roleConstraint === "any"
            ? "[Shared-dialogue evidence]\nAuthority rule: assistant output may answer only a directly requested shared artifact or prior answer whose neighboring user request establishes its provenance; never treat it as a user fact."
            : source.answerRole === "current"
              ? "[Current user-grounded evidence]"
              : source.answerRole === "ambiguous"
                ? "[Ambiguous user-grounded evidence]"
                : source.answerRole === "candidate"
                  ? "[Unverified candidate L0 evidence]\nUse only if it directly answers a missing requirement; relevance alone is not support."
                  : source.answerRole === "mixed"
                    ? "[Mixed verified and candidate L0 evidence]\nRequirement-bound evidence is followed by bounded candidates; verify candidate text before use."
                    : "[Supporting user-grounded evidence]";
      return {
        id: source.sourceId,
        content: [
          index === 0 ? evidenceAnswerContractText : "",
          authorityLabel,
          source.text,
        ]
          .filter(Boolean)
          .join("\n"),
        user_id: userId,
        metadata: {
          memoryId: `evidence-first-span-${index}`,
          memoryIds: [] as string[],
          evidence: `amb:document/${source.sourceId}#evidence-first`,
          evidences: [
            `amb:document/${source.sourceId}#evidence-first`,
            ...source.evidenceRefs,
          ],
        },
      };
    });
    dynamicMemoryChars = output.reduce(
      (total, document) => total + document.content.length,
      0,
    );
    rawEvidenceChars = dynamicMemoryChars;
    return output;
  }
  if (ingestMode === "atom" && atomContextMode === "source_expand") {
    const atomChars = [...grouped.values()].reduce(
      (total, group) => total + group.statements.join("\n").length,
      0,
    );
    const sourceBudget = Math.max(0, atomSourceContextMaxChars - atomChars);
    const perDocumentBudget = Math.max(
      256,
      Math.floor(sourceBudget / Math.max(1, grouped.size)),
    );
    documents = await Promise.all(
      [...grouped.entries()].map(async ([documentId, group]) => {
        const sourceTexts = await sourceTextsForDocument(
          userId,
          documentId,
          group.sourceSeqs,
        );
        const excerpt = selectAmbSourceEvidenceV1({
          sourceTexts,
          query: queryText,
          atomStatements: group.statements,
          maxChars: perDocumentBudget,
        });
        if (excerpt) expandedSourceDocuments += 1;
        return {
          id: documentId,
          content: excerpt
            ? `[Memory atoms]\n${group.statements.join("\n")}\n[Source evidence]\n${excerpt}`
            : group.statements.join("\n"),
          user_id: userId,
          metadata: {
            memoryId: group.memoryIds[0] ?? documentId,
            memoryIds: group.memoryIds,
            evidence: group.evidence[0],
            evidences: group.evidence,
          },
        };
      }),
    );
  } else if (ingestMode === "atom" && atomContextMode === "hybrid") {
    documents = await buildHybridDocuments();
  } else if (ingestMode === "atom" && atomContextMode === "evidence_first") {
    documents = await buildEvidenceFirstDocuments();
  } else if (ingestMode === "atom" && atomContextMode === "scene_hybrid") {
    const sourceIds = [...grouped.keys()];
    const scenes = projectSourceGroundedMemoryScenesV1({
      sources: await sceneSourcesForDocuments(userId, sourceIds),
      maxChars: Math.min(
        atomSceneContextMaxChars,
        Math.max(1_024, atomSourceContextMaxChars - 1_024),
      ),
    });
    const sceneDocuments = scenes.map((scene) => ({
      id: scene.sourceId,
      content: `[Source-grounded memory scene]\n${scene.text}`,
      user_id: userId,
      metadata: {
        memoryId: scene.atomIds[0] ?? scene.sourceId,
        memoryIds: [...scene.atomIds],
        evidence: `amb:document/${scene.sourceId}#scene`,
        evidences: [`amb:document/${scene.sourceId}#scene`],
      },
    }));
    const sourceCandidates = (
      await Promise.all(
        sourceIds.map((documentId) =>
          sourceChunksForDocument(userId, documentId),
        ),
      )
    ).flat();
    const sceneChars = sceneDocuments.reduce(
      (total, document) => total + document.content.length,
      0,
    );
    const selectedChunks = selectAmbSourceChunksV1({
      chunks: sourceCandidates,
      query: queryText,
      atomStatements: scenes.map((scene) => scene.text),
      maxChars: Math.max(256, atomSourceContextMaxChars - sceneChars - 512),
    });
    expandedSourceDocuments = new Set([
      ...scenes.map((scene) => scene.sourceId),
      ...selectedChunks.map((chunk) => chunk.documentId),
    ]).size;
    projectedSceneCount = scenes.length;
    projectedSceneAtomCount = scenes.reduce(
      (total, scene) => total + scene.atomIds.length,
      0,
    );
    selectedSourceChunkCount = selectedChunks.length;
    documents = [
      ...sceneDocuments,
      ...selectedChunks.map((chunk) => ({
        id: chunk.documentId,
        content: `[Contiguous source evidence]\n${chunk.text}`,
        user_id: userId,
        metadata: {
          memoryId: `source-chunk-${chunk.index}`,
          memoryIds: [] as string[],
          evidence: `amb:document/${chunk.documentId}#source-chunk-${chunk.index}`,
          evidences: [
            `amb:document/${chunk.documentId}#source-chunk-${chunk.index}`,
          ],
        },
      })),
    ];
  } else if (ingestMode === "atom" && atomContextMode === "topic_evidence") {
    const profileEntries = await engineFor(userId).query({
      kind: "profile",
      repo: scope.repositoryId,
      includeInvalidated: false,
      includeDegraded: false,
      limit: 256,
    });
    const persona = projectMemoryPersonaEvidenceV1({
      entries: profileEntries,
      minimumConfidence: 0.7,
      maxClaims: 12,
      maxChars: atomPersonaMaxChars,
    });
    const catalog = await topicEvidenceStoreFor(userId).load(
      new AbortController().signal,
    );
    const plan = planMemoryTopicEvidenceV1({
      query: queryText,
      scopeFingerprint: memoryScopeFingerprintV1(scope),
      catalog,
      maxIndexTopics: 96,
      maxSelectedTopics: 3,
      maxStates: 16,
      maxEvidenceChars: 8_000,
    });
    const indexContent = JSON.stringify({
      schemaVersion: "paw.memory-topic-index.v1",
      scopeFingerprint: plan.scopeFingerprint,
      indexRevision: plan.indexRevision,
      topics: plan.indexEntries,
    });
    const evidenceContent = JSON.stringify({
      schemaVersion: "paw.memory-topic-evidence.v1",
      indexRevision: plan.indexRevision,
      states: plan.evidenceStates,
    });
    const indexDocument = {
      id: `topic-index-${plan.indexRevision.slice(0, 20)}`,
      content: `[Stable memory topic index]\n${indexContent}`,
      user_id: userId,
      metadata: {
        memoryId: `topic-index-${plan.indexRevision.slice(0, 20)}`,
        memoryIds: [] as string[],
        evidence: `memory:topic-index/${plan.indexRevision}`,
        evidences: [`memory:topic-index/${plan.indexRevision}`],
      },
    };
    const personaDocuments =
      persona.claims.length === 0
        ? []
        : [
            {
              id: `persona-${persona.projectionKey.slice(0, 20)}`,
              content: `[Stable source-grounded persona]\n${JSON.stringify({
                schemaVersion: "paw.memory-persona-evidence.v1",
                scopeFingerprint: memoryScopeFingerprintV1(scope),
                projectionRevision: persona.projectionRevision,
                projectionKey: persona.projectionKey,
                claims: persona.claims,
                sourceCount: persona.sourceCount,
              })}`,
              user_id: userId,
              metadata: {
                memoryId: `persona-${persona.projectionKey.slice(0, 20)}`,
                memoryIds: persona.claims.map((claim) => claim.memoryId),
                evidence: `memory:persona/${persona.projectionKey}`,
                evidences: [`memory:persona/${persona.projectionKey}`],
              },
            },
          ];
    const evidenceDocuments =
      plan.evidenceStates.length === 0
        ? []
        : [
            {
              id: `topic-evidence-${queryHash.slice(0, 20)}`,
              content: `[Query-selected topic trajectories]\n${evidenceContent}`,
              user_id: userId,
              metadata: {
                memoryId: `topic-evidence-${queryHash.slice(0, 20)}`,
                memoryIds: plan.evidenceStates.map((state) => state.memoryId),
                evidence: `memory:topic-evidence/${queryHash}`,
                evidences: [`memory:topic-evidence/${queryHash}`],
              },
            },
          ];
    const rawRequestMap = new Map<string, Set<string>>();
    for (const document of atomDocuments) {
      for (const evidenceRef of document.metadata.evidences) {
        const ids = rawRequestMap.get(evidenceRef) ?? new Set<string>();
        ids.add(document.metadata.memoryId);
        rawRequestMap.set(evidenceRef, ids);
      }
    }
    for (const state of plan.evidenceStates) {
      for (const evidenceRef of state.evidenceRefs) {
        const ids = rawRequestMap.get(evidenceRef) ?? new Set<string>();
        ids.add(state.memoryId);
        rawRequestMap.set(evidenceRef, ids);
      }
    }
    const rawRequests = [...rawRequestMap.entries()].map(
      ([evidenceRef, ids]) => ({
        evidenceRef,
        memoryIds: [...ids].sort(),
      }),
    );
    const rawResolved = await rawEvidenceArchiveFor(userId).resolve(
      rawRequests.slice(0, 6),
      new AbortController().signal,
    );
    const rawPlan = boundMemoryRawEvidenceSpansV1({
      requests: rawRequests,
      resolved: rawResolved,
      maxSpans: 6,
      maxChars: 6_000,
    });
    let coveragePlan:
      | Awaited<ReturnType<typeof planMemoryEvidenceCoverageV1>>
      | undefined;
    if (coveragePlanner) {
      const coverageSnapshot: SessionInputSnapshot<InputFactV1> = Object.freeze(
        {
          entries: Object.freeze([
            {
              seq: 1,
              fact: {
                type: "memory.retrieval_settled",
                queryId,
                trigger: "task_start",
                providerVersion,
                policyVersion: "paw.memory-retrieval.v1",
                status: result.status,
                cards: result.cards,
                ...(result.reasonCode === undefined
                  ? {}
                  : { reasonCode: result.reasonCode }),
              } satisfies InputFactV1,
            },
            {
              seq: 2,
              fact: {
                type: "memory.topic_evidence_settled",
                queryId,
                plannerVersion: "paw.memory-topic-evidence-planner.v1",
                scopeFingerprint: memoryScopeFingerprintV1(scope),
                status: plan.evidenceStates.length > 0 ? "completed" : "noop",
                indexRevision: plan.indexRevision,
                indexEntries: plan.indexEntries,
                evidenceStates: plan.evidenceStates,
                ...(plan.evidenceStates.length > 0
                  ? {}
                  : { reasonCode: "memory_topic_no_matching_evidence" }),
                settledAt: 0,
              } satisfies InputFactV1,
            },
            {
              seq: 3,
              fact: {
                type: "memory.persona_projection_settled",
                queryId,
                projectorVersion: "paw.memory-persona-evidence-projector.v1",
                scopeFingerprint: memoryScopeFingerprintV1(scope),
                status: persona.claims.length > 0 ? "completed" : "noop",
                projectionRevision: persona.projectionRevision,
                projectionKey: persona.projectionKey,
                claims: persona.claims,
                sourceCount:
                  persona.claims.length > 0 ? persona.sourceCount : 0,
                ...(persona.claims.length > 0
                  ? {}
                  : { reasonCode: "memory_persona_no_claims" }),
                settledAt: 0,
              } satisfies InputFactV1,
            },
            {
              seq: 4,
              fact: {
                type: "memory.raw_evidence_settled",
                queryId,
                resolverVersion: "paw.memory-raw-evidence-resolver.v1",
                scopeFingerprint: memoryScopeFingerprintV1(scope),
                status: rawPlan.spans.length > 0 ? "completed" : "noop",
                resolutionRevision: rawPlan.resolutionRevision,
                spans: rawPlan.spans,
                ...(rawPlan.spans.length > 0
                  ? {}
                  : { reasonCode: "memory_raw_evidence_not_archived" }),
                settledAt: 0,
              } satisfies InputFactV1,
            },
          ]),
          tailSeq: 4,
          latestInputSeq: 4,
        },
      );
      try {
        coveragePlan = await planMemoryEvidenceCoverageV1({
          queryId,
          query: queryText,
          scopeFingerprint: memoryScopeFingerprintV1(scope),
          snapshot: coverageSnapshot,
          catalog,
          archive: rawEvidenceArchiveFor(userId),
          planner: coveragePlanner,
          maxRequirements: 4,
          maxExpansionTopics: 3,
          maxSupplementalStates: 8,
          maxSupplementalChars: 4_096,
          maxRawSpans: 6,
          maxRawChars: 6_000,
          signal: new AbortController().signal,
        });
        coverageStatus =
          coveragePlan.requirements.length > 0 ? "completed" : "noop";
        coverageRequirementCount = coveragePlan.requirements.length;
        coverageCoveredCount = coveragePlan.coverage.filter(
          (item) => item.status === "covered",
        ).length;
        coveragePartialCount = coveragePlan.coverage.filter(
          (item) => item.status === "partial",
        ).length;
        coverageMissingCount = coveragePlan.coverage.filter(
          (item) => item.status === "missing",
        ).length;
        coverageExpansionTopicCount = new Set(
          coveragePlan.coverage.flatMap((item) => item.topicIds),
        ).size;
        coverageSupplementalStateCount = coveragePlan.supplementalStates.length;
      } catch (error) {
        coverageStatus = "failed";
        log("evidence_coverage", {
          queryHash,
          status: "failed",
          reasonCode:
            error instanceof Error ? error.name : "MemoryCoverageUnknown",
        });
      }
    }
    const finalRawSpans =
      coveragePlan && coveragePlan.requirements.length > 0
        ? coveragePlan.spans
        : rawPlan.spans;
    const rawEvidenceDocuments =
      finalRawSpans.length === 0 ||
      (coveragePlan !== undefined && coveragePlan.requirements.length > 0)
        ? []
        : [
            {
              id: `raw-evidence-${rawPlan.resolutionRevision.slice(0, 20)}`,
              content: `[Bounded original evidence]\n${JSON.stringify({
                schemaVersion: "paw.memory-raw-evidence.v1",
                resolutionRevision: rawPlan.resolutionRevision,
                spans: finalRawSpans,
              })}`,
              user_id: userId,
              metadata: {
                memoryId: `raw-evidence-${rawPlan.resolutionRevision.slice(0, 20)}`,
                memoryIds: finalRawSpans.flatMap((span) => span.memoryIds),
                evidence: `memory:raw-evidence/${rawPlan.resolutionRevision}`,
                evidences: finalRawSpans.map((span) => span.evidenceRef),
              },
            },
          ];
    const coverageDocuments =
      coveragePlan && coveragePlan.requirements.length > 0
        ? [
            {
              id: `evidence-coverage-${coveragePlan.planRevision.slice(0, 20)}`,
              content: `[Evidence requirements and bounded coverage]\n${JSON.stringify(
                {
                  schemaVersion: "paw.memory-evidence-coverage.v1",
                  instruction:
                    "Check required coverage before answering; state uncertainty when required evidence is partial or missing.",
                  planRevision: coveragePlan.planRevision,
                  requirements: coveragePlan.requirements.map((requirement) => {
                    const coverage = coveragePlan.coverage.find(
                      (item) =>
                        item.requirementId === requirement.requirementId,
                    );
                    return {
                      description: requirement.description,
                      priority: requirement.priority,
                      minimumEvidence: requirement.minimumEvidence,
                      status: coverage?.status ?? "missing",
                      selectedEvidenceCount: coverage?.memoryIds.length ?? 0,
                    };
                  }),
                  supplementalEvidence: coveragePlan.supplementalStates.map(
                    (state) => ({
                      state: state.state,
                      statement: state.statement,
                      validFrom: state.validFrom,
                      ...(state.validTo === undefined
                        ? {}
                        : { validTo: state.validTo }),
                      evidenceRefs: state.evidenceRefs,
                    }),
                  ),
                  boundedOriginalEvidence: coveragePlan.spans.map((span) => ({
                    evidenceRef: span.evidenceRef,
                    content: span.content,
                    contentHash: span.contentHash,
                  })),
                },
              )}`,
              user_id: userId,
              metadata: {
                memoryId: `evidence-coverage-${coveragePlan.planRevision.slice(0, 20)}`,
                memoryIds: coveragePlan.coverage.flatMap(
                  (item) => item.memoryIds,
                ),
                evidence: `memory:evidence-coverage/${coveragePlan.planRevision}`,
                evidences: coveragePlan.spans.map((span) => span.evidenceRef),
              },
            },
          ]
        : [];
    documents = [
      ...personaDocuments,
      indexDocument,
      ...atomDocuments,
      ...evidenceDocuments,
      ...rawEvidenceDocuments,
      ...coverageDocuments,
    ];
    topicIndexRevision = plan.indexRevision;
    topicIndexCount = plan.indexEntries.length;
    topicEvidenceStateCount = plan.evidenceStates.length;
    rawEvidenceSpanCount = finalRawSpans.length;
    rawEvidenceChars = finalRawSpans.reduce(
      (total, span) => total + span.content.length,
      0,
    );
    personaHash = persona.projectionKey;
    personaChars = personaDocuments.reduce(
      (total, document) => total + document.content.length,
      0,
    );
    personaClaims = persona.claims.length;
    personaInjected = personaDocuments.length > 0;
    stablePrefixHash = sha(
      `${personaDocuments.map((document) => document.content).join("\n")}\n${indexDocument.content}`,
    );
    stablePrefixChars = personaChars + indexDocument.content.length;
    dynamicMemoryChars = [
      ...evidenceDocuments,
      ...rawEvidenceDocuments,
      ...coverageDocuments,
    ].reduce((total, document) => total + document.content.length, 0);
  } else if (ingestMode === "atom" && atomContextMode === "tool_driven") {
    const signal = new AbortController().signal;
    const profileEntries = await engineFor(userId).query({
      kind: "profile",
      repo: scope.repositoryId,
      includeInvalidated: false,
      includeDegraded: false,
      limit: 256,
    });
    const persona = projectMemoryPersonaEvidenceV1({
      entries: profileEntries,
      minimumConfidence: 0.7,
      maxClaims: 12,
      maxChars: atomPersonaMaxChars,
    });
    const catalog = await topicEvidenceStoreFor(userId).load(signal);
    const navigationPlan = planMemoryTopicEvidenceV1({
      query: "memory topic index",
      scopeFingerprint: memoryScopeFingerprintV1(scope),
      catalog,
      maxIndexTopics: 96,
      maxSelectedTopics: 3,
      maxStates: 16,
      maxEvidenceChars: 8_000,
    });
    const personaContent =
      persona.claims.length === 0
        ? ""
        : JSON.stringify({
            schemaVersion: "paw.memory-persona-evidence.v1",
            scopeFingerprint: memoryScopeFingerprintV1(scope),
            projectionRevision: persona.projectionRevision,
            projectionKey: persona.projectionKey,
            claims: persona.claims,
            sourceCount: persona.sourceCount,
          });
    const indexContent = JSON.stringify({
      schemaVersion: "paw.memory-topic-index.v1",
      scopeFingerprint: navigationPlan.scopeFingerprint,
      indexRevision: navigationPlan.indexRevision,
      topics: navigationPlan.indexEntries,
    });
    stablePrefixHash = sha(`${personaContent}\n${indexContent}`);
    stablePrefixChars = personaContent.length + indexContent.length;
    personaHash = persona.projectionKey;
    personaChars = personaContent.length;
    personaClaims = persona.claims.length;
    topicIndexRevision = navigationPlan.indexRevision;
    topicIndexCount = navigationPlan.indexEntries.length;
    const navigationDocuments = [
      ...(personaContent
        ? [
            {
              id: `persona-${persona.projectionKey.slice(0, 20)}`,
              content: `[Stable user persona]\n${personaContent}`,
              user_id: userId,
              metadata: {
                memoryId: `persona-${persona.projectionKey.slice(0, 20)}`,
                evidence: `memory:persona/${persona.projectionKey}`,
                evidences: [`memory:persona/${persona.projectionKey}`],
              },
            },
          ]
        : []),
      {
        id: `topic-index-${navigationPlan.indexRevision.slice(0, 20)}`,
        content: `[Stable memory topic index]\n${indexContent}`,
        user_id: userId,
        metadata: {
          memoryId: `topic-index-${navigationPlan.indexRevision.slice(0, 20)}`,
          evidence: `memory:topic-index/${navigationPlan.indexRevision}`,
          evidences: [`memory:topic-index/${navigationPlan.indexRevision}`],
        },
      },
    ];
    if (toolMode === "resolve_context") {
      const packet = await contextResolverFor(userId).resolve(
        queryText,
        signal,
      );
      const packetView = projectMemoryResolvedContextToolV1(packet, 8_000);
      toolPayload = packetView;
      documents = [
        {
          id: `resolved-context-${packet.packetRevision.slice(0, 20)}`,
          content: `[Resolved memory context]\n${JSON.stringify(packetView)}`,
          user_id: userId,
          metadata: {
            memoryId: `resolved-context-${packet.packetRevision.slice(0, 20)}`,
            evidence: `memory:resolved-context/${packet.packetRevision}`,
            evidences: packet.spans.map((span) => span.evidenceRef),
          },
        },
      ];
      coverageStatus = packet.mode === "planned" ? "completed" : "failed";
      coverageRequirementCount = packet.requirements.length;
      coverageCoveredCount = packet.requirements.filter(
        (item) => item.status === "covered",
      ).length;
      coveragePartialCount = packet.requirements.filter(
        (item) => item.status === "partial",
      ).length;
      coverageMissingCount = packet.requirements.filter(
        (item) => item.status === "missing",
      ).length;
      coverageExpansionTopicCount = packet.topics.length;
      coverageSupplementalStateCount = packet.evidence.filter(
        (item) => item.layer === "L2",
      ).length;
      projectedSceneCount = packet.topics.length;
      projectedSceneAtomCount = packet.topics.reduce(
        (total, topic) =>
          total +
          topic.currentConclusions.length +
          topic.evolutions.length +
          topic.conflicts.length,
        0,
      );
      topicEvidenceStateCount = coverageSupplementalStateCount;
      rawEvidenceSpanCount = packet.spans.length;
      rawEvidenceChars = packet.spans.reduce(
        (total, span) => total + span.content.length,
        0,
      );
      dynamicMemoryChars = documents[0]?.content.length ?? 0;
    } else if (toolMode === "search_atoms") {
      documents = atomDocuments;
      toolPayload = Object.freeze({
        query: queryText,
        status: result.status,
        evidence: Object.freeze(
          result.cards.slice(0, k).map((card) =>
            Object.freeze({
              memoryId: card.id,
              kind: card.kind,
              statement: card.statement,
              confidence: card.confidence,
              sources: Object.freeze(card.sources.map((source) => source.ref)),
            }),
          ),
        ),
        reasonCode: result.reasonCode ?? null,
      });
      dynamicMemoryChars = documents.reduce(
        (total, document) => total + document.content.length,
        0,
      );
    } else if (toolMode === "read_topic") {
      const topicId = resolveMemoryTopicIdV1(
        queryText,
        catalog.map((item) => item.projection.topic.id),
      );
      const item = topicId
        ? catalog.find((candidate) => candidate.projection.topic.id === topicId)
        : undefined;
      const requestedMaxStates = Number(params.maxStates ?? 16);
      const maxStates = Number.isSafeInteger(requestedMaxStates)
        ? Math.max(1, Math.min(24, requestedMaxStates))
        : 16;
      const dossier =
        item && topicId
          ? await topicDossierStoreFor(userId).getCurrent(topicId, signal)
          : undefined;
      const dossierView = dossier
        ? projectMemoryTopicDossierToolV1(dossier, maxStates, 8_000)
        : undefined;
      const states =
        item && !dossierView
          ? projectMemoryTopicToolStatesV1(item, maxStates)
          : [];
      toolPayload = Object.freeze({
        ...(item && topicId
          ? {
              topic: Object.freeze({
                topicId,
                name: item.projection.topic.canonicalName,
                family: item.projection.topic.family,
              }),
            }
          : {}),
        ...(dossierView
          ? { dossier: dossierView }
          : { states: Object.freeze(states) }),
      });
      const stateEvidenceRefs = dossier
        ? [...dossier.evidenceRefs]
        : [
            ...new Set(
              states.flatMap((state) =>
                Array.isArray(state.evidenceRefs)
                  ? state.evidenceRefs.filter(
                      (ref): ref is string => typeof ref === "string",
                    )
                  : [],
              ),
            ),
          ];
      documents =
        item && topicId
          ? [
              {
                id: topicId,
                content: `[Memory topic body]\n${JSON.stringify({
                  schemaVersion: dossierView
                    ? "paw.memory-topic-dossier-read.v1"
                    : "paw.memory-topic-read.v1",
                  topic: {
                    topicId,
                    name: item.projection.topic.canonicalName,
                    family: item.projection.topic.family,
                  },
                  ...(dossierView ? { dossier: dossierView } : { states }),
                })}`,
                user_id: userId,
                metadata: {
                  memoryId:
                    dossier?.sourceMemoryIds[0] ??
                    (typeof states[0]?.memoryId === "string"
                      ? states[0].memoryId
                      : topicId),
                  evidence: stateEvidenceRefs[0] ?? `memory:topic/${topicId}`,
                  evidences:
                    stateEvidenceRefs.length > 0
                      ? stateEvidenceRefs
                      : [`memory:topic/${topicId}`],
                },
              },
            ]
          : [];
      projectedSceneCount = documents.length;
      const dossierItemCount = dossierView
        ? ["currentConclusions", "evolutions", "conflicts"].reduce(
            (total, key) => {
              const values = dossierView[key];
              return total + (Array.isArray(values) ? values.length : 0);
            },
            0,
          )
        : 0;
      projectedSceneAtomCount = dossierView ? dossierItemCount : states.length;
      topicEvidenceStateCount = projectedSceneAtomCount;
      dynamicMemoryChars = documents.reduce(
        (total, document) => total + document.content.length,
        0,
      );
    } else if (toolMode === "search_conversation") {
      documents = await buildL0FallbackDocuments();
      toolPayload = Object.freeze({
        query: queryText,
        spans: Object.freeze(
          documents.map((document) =>
            Object.freeze({
              evidenceRef: document.metadata.evidence,
              memoryIds:
                "memoryIds" in document.metadata
                  ? document.metadata.memoryIds
                  : [document.metadata.memoryId],
              content: document.content,
            }),
          ),
        ),
      });
      routedFallback = true;
      selectedSourceChunkCount = documents.length;
      dynamicMemoryChars = documents.reduce(
        (total, document) => total + document.content.length,
        0,
      );
    } else if (toolMode === "read_evidence") {
      const requests = requestedEvidenceRefs.map((evidenceRef) => ({
        evidenceRef,
        memoryIds: requestedMemoryIds,
      }));
      const resolved = await rawEvidenceArchiveFor(userId).resolve(
        requests,
        signal,
      );
      const bounded = boundMemoryRawEvidenceSpansV1({
        requests,
        resolved,
        maxSpans: 8,
        maxChars: 8_000,
      });
      documents = bounded.spans.map((span) => ({
        id: `evidence-${sha(span.evidenceRef).slice(0, 20)}`,
        content: `[Exact source evidence]\n${JSON.stringify({
          evidenceRef: span.evidenceRef,
          memoryIds: span.memoryIds,
          content: span.content,
          contentHash: span.contentHash,
        })}`,
        user_id: userId,
        metadata: {
          memoryId: span.memoryIds[0] ?? `evidence-${sha(span.evidenceRef)}`,
          evidence: span.evidenceRef,
          evidences: [span.evidenceRef],
        },
      }));
      toolPayload = Object.freeze({ spans: Object.freeze(bounded.spans) });
      rawEvidenceSpanCount = bounded.spans.length;
      rawEvidenceChars = bounded.spans.reduce(
        (total, span) => total + span.content.length,
        0,
      );
      dynamicMemoryChars = documents.reduce(
        (total, document) => total + document.content.length,
        0,
      );
    } else if (toolMode === "initial") {
      const packet = await contextResolverFor(userId).resolve(
        queryText,
        signal,
      );
      const packetView = projectMemoryResolvedContextToolV1(packet, 8_000);
      const resolvedDocument = {
        id: `resolved-context-${packet.packetRevision.slice(0, 20)}`,
        content: `[Resolved query evidence]\n${JSON.stringify(packetView)}`,
        user_id: userId,
        metadata: {
          memoryId: `resolved-context-${packet.packetRevision.slice(0, 20)}`,
          evidence: `memory:resolved-context/${packet.packetRevision}`,
          evidences: packet.spans.map((span) => span.evidenceRef),
        },
      };
      const missingRequired = packet.requirements.filter(
        (item) => item.priority === "required" && item.status !== "covered",
      );
      const focusedFallbackDocuments = (
        await Promise.all(
          missingRequired
            .slice(0, 3)
            .map((item) => buildL0FallbackDocuments(item.description, 2)),
        )
      ).flat();
      const fallbackDocuments = [
        ...new Map(
          focusedFallbackDocuments.map((document) => [
            `${document.id}\0${document.content}`,
            document,
          ]),
        ).values(),
      ].slice(0, 4);
      documents = [
        ...navigationDocuments,
        resolvedDocument,
        ...fallbackDocuments,
      ];
      toolPayload = packetView;
      coverageStatus = packet.mode === "planned" ? "completed" : "failed";
      coverageRequirementCount = packet.requirements.length;
      coverageCoveredCount = packet.requirements.filter(
        (item) => item.status === "covered",
      ).length;
      coveragePartialCount = packet.requirements.filter(
        (item) => item.status === "partial",
      ).length;
      coverageMissingCount = packet.requirements.filter(
        (item) => item.status === "missing",
      ).length;
      coverageExpansionTopicCount = packet.topics.length;
      coverageSupplementalStateCount = packet.evidence.filter(
        (item) => item.layer === "L2",
      ).length;
      rawEvidenceSpanCount = packet.spans.length;
      rawEvidenceChars = packet.spans.reduce(
        (total, span) => total + span.content.length,
        0,
      );
      dynamicMemoryChars = resolvedDocument.content.length;
      if (fallbackDocuments.length > 0) {
        routedFallback = true;
        selectedSourceChunkCount = fallbackDocuments.length;
        dynamicMemoryChars += fallbackDocuments.reduce(
          (total, document) => total + document.content.length,
          0,
        );
      }
      personaInjected = personaContent.length > 0;
    } else {
      documents = navigationDocuments;
      toolPayload = Object.freeze({
        topics: Object.freeze(
          navigationPlan.indexEntries.map((entry) =>
            Object.freeze({
              topicId: entry.topicId,
              name: entry.canonicalName,
              family: entry.family,
              memberCount: entry.memberCount,
              trajectoryCount: entry.trajectoryCount,
              projectionHash: entry.projectionHash,
            }),
          ),
        ),
      });
    }
    memoryRoute = `tool_${toolMode}`;
  } else if (ingestMode === "atom" && atomContextMode === "scene_routed") {
    const { snapshot, persona } = await sceneSnapshotForUser(userId);
    const route = routeMemoryQueryV1(queryText, {
      allowExploratoryScenes:
        persona.claims.length >= 4 && persona.sourceCount >= 1,
    });
    const selection = selectMemorySceneEvidenceV1({
      snapshot,
      query: queryText,
      route,
    });
    memoryRoute = route.route;
    stablePrefixHash = sha(`${persona.projectionKey}\n${snapshot.snapshotKey}`);
    stablePrefixChars = persona.text.length + snapshot.indexText.length;
    personaHash = persona.projectionKey;
    personaChars = persona.text.length;
    personaClaims = persona.claims.length;
    if (route.route === "l0_fallback" || selection.reads.length === 0) {
      routedFallback = true;
      routeStats.l0Fallback += 1;
      documents = await buildL0FallbackDocuments();
      dynamicMemoryChars = documents.reduce(
        (total, document) => total + document.content.length,
        0,
      );
      routeStats.dynamicChars += dynamicMemoryChars;
    } else {
      if (route.route === "scene_causal") routeStats.sceneCausal += 1;
      else routeStats.sceneExploratory += 1;
      const sceneDocuments = selection.reads.map((read) => ({
        id: read.sourceId,
        content: `[Memory scene body: ${read.path}]\n${read.text}`,
        user_id: userId,
        metadata: {
          memoryId: read.atomIds[0] ?? read.path,
          memoryIds: [...read.atomIds],
          evidence: `amb:document/${read.sourceId}#scene-read`,
          evidences: [`amb:document/${read.sourceId}#scene-read`],
        },
      }));
      const selectedSourceIds = selection.reads.map((read) => read.sourceId);
      const sourceCandidates = (
        await Promise.all(
          selectedSourceIds.map((documentId) =>
            sourceChunksForDocument(userId, documentId),
          ),
        )
      ).flat();
      const dynamicSceneChars = sceneDocuments.reduce(
        (total, document) => total + document.content.length,
        0,
      );
      const sourceBudget = Math.max(
        256,
        atomSourceContextMaxChars -
          persona.text.length -
          snapshot.indexText.length -
          dynamicSceneChars -
          512,
      );
      const selectedChunks = selectAmbSourceChunksV1({
        chunks: sourceCandidates,
        query: queryText,
        atomStatements: selection.reads.map((read) => read.text),
        maxChars: sourceBudget,
      }).slice(0, 1);
      const indexDocument = {
        id: `scene-index-${snapshot.snapshotKey.slice(0, 20)}`,
        content: `[Stable memory scene index]\n${snapshot.indexText}`,
        user_id: userId,
        metadata: {
          memoryId: `scene-index-${snapshot.snapshotKey.slice(0, 20)}`,
          memoryIds: [] as string[],
          evidence: `memory:scene-snapshot/${snapshot.snapshotKey}`,
          evidences: [`memory:scene-snapshot/${snapshot.snapshotKey}`],
        },
      };
      const personaDocument = {
        id: `persona-${persona.projectionKey.slice(0, 20)}`,
        content: `[Stable user persona]\n${persona.text}`,
        user_id: userId,
        metadata: {
          memoryId: `persona-${persona.projectionKey.slice(0, 20)}`,
          memoryIds: persona.claims.map((claim) => claim.atomId),
          evidence: `memory:persona/${persona.projectionKey}`,
          evidences: [`memory:persona/${persona.projectionKey}`],
        },
      };
      const chunkDocuments = selectedChunks.map((chunk) => ({
        id: chunk.documentId,
        content: `[Contiguous source evidence]\n${chunk.text}`,
        user_id: userId,
        metadata: {
          memoryId: `source-chunk-${chunk.index}`,
          memoryIds: [] as string[],
          evidence: `amb:document/${chunk.documentId}#source-chunk-${chunk.index}`,
          evidences: [
            `amb:document/${chunk.documentId}#source-chunk-${chunk.index}`,
          ],
        },
      }));
      documents = [
        personaDocument,
        indexDocument,
        ...sceneDocuments,
        ...chunkDocuments,
      ];
      personaInjected = true;
      projectedSceneCount = selection.reads.length;
      projectedSceneAtomCount = selection.telemetry.selectedAtomCount;
      selectedSourceChunkCount = selectedChunks.length;
      expandedSourceDocuments = new Set([
        ...selectedSourceIds,
        ...selectedChunks.map((chunk) => chunk.documentId),
      ]).size;
      dynamicMemoryChars =
        dynamicSceneChars +
        chunkDocuments.reduce(
          (total, document) => total + document.content.length,
          0,
        );
      routeStats.sceneReads += selection.telemetry.sceneReadCount;
      routeStats.selectedAtoms += selection.telemetry.selectedAtomCount;
      routeStats.dynamicChars += dynamicMemoryChars;
      routeStats.personaInjections += 1;
    }
  }
  const response = {
    documents,
    ...(toolPayload === undefined ? {} : { toolPayload }),
    rawResponse: {
      providerVersion,
      retrievalPolicy,
      ingestMode,
      atomContextMode: ingestMode === "atom" ? atomContextMode : null,
      toolMode:
        ingestMode === "atom" && atomContextMode === "tool_driven"
          ? toolMode
          : null,
      expandedSourceDocuments,
      projectedSceneCount,
      projectedSceneAtomCount,
      selectedSourceChunkCount,
      memoryRoute,
      stablePrefixHash,
      stablePrefixChars,
      dynamicMemoryChars,
      routedFallback,
      personaHash,
      personaChars,
      personaClaims,
      personaInjected,
      topicIndexRevision,
      topicIndexCount,
      topicEvidenceStateCount,
      rawEvidenceSpanCount,
      rawEvidenceChars,
      coverageStatus,
      coverageRequirementCount,
      coverageCoveredCount,
      coveragePartialCount,
      coverageMissingCount,
      coverageExpansionTopicCount,
      coverageSupplementalStateCount,
      evidenceFirstL0CandidateCount,
      evidenceFirstL0SpanCandidateCount,
      evidenceFirstConversationCandidateCount,
      evidenceFirstConfirmedDialogueCount,
      evidenceFirstAssistantRecallCount,
      evidenceFirstQueryExpansionCount,
      evidenceFirstQueryExpansionStatus,
      evidenceFirstSupportSelectorStatus,
      evidenceFirstDirectCertificateStatus,
      evidenceFirstClosureAuditStatus,
      evidenceFirstClosureVerdict,
      evidenceFirstClosureRepairCount,
      evidenceFirstContextStop,
      evidenceFirstVerificationStatus,
      evidenceFirstPlanAnswerShape,
      evidenceFirstPlanTemporalMode,
      evidenceFirstPlanRoleConstraint,
      evidenceFirstInitialRoleConstraint,
      evidenceFirstRoleResolutionStatus,
      evidenceFirstPlanRequirementCount,
      evidenceFirstNotebookCoveredCount,
      evidenceFirstNotebookPartialCount,
      evidenceFirstNotebookMissingCount,
      evidenceFirstNotebookHitCount,
      evidenceFirstNotebookIndependentEvidenceCount,
      evidenceFirstNotebookClosureEvidenceCount,
      evidenceFirstNotebookUnresolvedEvidenceCount,
      evidenceFirstNotebookChars,
      evidenceFirstEventIdentityMode,
      evidenceFirstEventKeyCoverageRate,
      evidenceFirstL1CandidateCount,
      evidenceFirstFusedCandidateCount,
      evidenceFirstDualChannelCount,
      evidenceFirstSelectedSourceCount,
      queryCutoffApplied: queryTimeCutoff !== undefined,
      queryCutoffHash:
        queryTimeCutoff === undefined
          ? null
          : sha(queryTimeCutoff.normalizedIso).slice(0, 20),
      futureExcludedDocumentCount: futureExcludedDocumentIds.size,
      evidenceFirstPolicyVersion:
        atomContextMode === "evidence_first"
          ? PAW_MEMORY_EVIDENCE_CANDIDATE_FUSION_VERSION_V2
          : null,
      evidenceFirstConversationBundlePolicyVersion:
        atomContextMode === "evidence_first"
          ? PAW_MEMORY_CONVERSATION_BUNDLE_POLICY_VERSION_V1
          : null,
      evidenceFirstNotebookPolicyVersion:
        atomContextMode === "evidence_first"
          ? PAW_MEMORY_EVIDENCE_NOTEBOOK_POLICY_VERSION_V1
          : null,
      contextChars: documents.reduce(
        (total, document) => total + document.content.length,
        0,
      ),
      status: result.status,
      reasonCode: result.reasonCode,
      queryHash,
      cacheEvents: pendingCacheEvents,
      cacheStats: cache.snapshot(),
      durationMs: Math.max(0, performance.now() - started),
    },
  };
  log("retrieve", {
    userFingerprint: sha(userId).slice(0, 20),
    queryHash,
    requestedK,
    returned: documents.length,
    atomContextMode: ingestMode === "atom" ? atomContextMode : null,
    toolMode:
      ingestMode === "atom" && atomContextMode === "tool_driven"
        ? toolMode
        : null,
    expandedSourceDocuments,
    projectedSceneCount,
    projectedSceneAtomCount,
    selectedSourceChunkCount,
    memoryRoute,
    stablePrefixHash,
    stablePrefixChars,
    dynamicMemoryChars,
    routedFallback,
    personaHash,
    personaChars,
    personaClaims,
    personaInjected,
    topicIndexRevision,
    topicIndexCount,
    topicEvidenceStateCount,
    rawEvidenceSpanCount,
    rawEvidenceChars,
    coverageStatus,
    coverageRequirementCount,
    coverageCoveredCount,
    coveragePartialCount,
    coverageMissingCount,
    coverageExpansionTopicCount,
    coverageSupplementalStateCount,
    evidenceFirstL0CandidateCount,
    evidenceFirstL0SpanCandidateCount,
    evidenceFirstConversationCandidateCount,
    evidenceFirstConfirmedDialogueCount,
    evidenceFirstAssistantRecallCount,
    evidenceFirstQueryExpansionCount,
    evidenceFirstQueryExpansionStatus,
    evidenceFirstSupportSelectorStatus,
    evidenceFirstDirectCertificateStatus,
    evidenceFirstClosureAuditStatus,
    evidenceFirstClosureVerdict,
    evidenceFirstClosureRepairCount,
    evidenceFirstContextStop,
    evidenceFirstVerificationStatus,
    evidenceFirstPlanAnswerShape,
    evidenceFirstPlanTemporalMode,
    evidenceFirstPlanRoleConstraint,
    evidenceFirstInitialRoleConstraint,
    evidenceFirstRoleResolutionStatus,
    evidenceFirstPlanRequirementCount,
    evidenceFirstNotebookCoveredCount,
    evidenceFirstNotebookPartialCount,
    evidenceFirstNotebookMissingCount,
    evidenceFirstNotebookHitCount,
    evidenceFirstNotebookIndependentEvidenceCount,
    evidenceFirstNotebookClosureEvidenceCount,
    evidenceFirstNotebookUnresolvedEvidenceCount,
    evidenceFirstNotebookChars,
    evidenceFirstEventIdentityMode,
    evidenceFirstEventKeyCoverageRate,
    evidenceFirstL1CandidateCount,
    evidenceFirstFusedCandidateCount,
    evidenceFirstDualChannelCount,
    evidenceFirstSelectedSourceCount,
    queryCutoffApplied: queryTimeCutoff !== undefined,
    queryCutoffHash:
      queryTimeCutoff === undefined
        ? null
        : sha(queryTimeCutoff.normalizedIso).slice(0, 20),
    futureExcludedDocumentCount: futureExcludedDocumentIds.size,
    evidenceFirstPolicyVersion:
      atomContextMode === "evidence_first"
        ? PAW_MEMORY_EVIDENCE_CANDIDATE_FUSION_VERSION_V2
        : null,
    evidenceFirstConversationBundlePolicyVersion:
      atomContextMode === "evidence_first"
        ? PAW_MEMORY_CONVERSATION_BUNDLE_POLICY_VERSION_V1
        : null,
    evidenceFirstNotebookPolicyVersion:
      atomContextMode === "evidence_first"
        ? PAW_MEMORY_EVIDENCE_NOTEBOOK_POLICY_VERSION_V1
        : null,
    contextChars: documents.reduce(
      (total, document) => total + document.content.length,
      0,
    ),
    returnedDocumentHashes: [
      ...new Set(documents.map((document) => sha(document.id))),
    ],
    returnedSourceDocumentHashes: [
      ...new Set(
        documents.flatMap((document) =>
          document.metadata.evidences.flatMap((ref) => {
            const documentId = sourceDocumentIdFromEvidenceV1(ref);
            return documentId ? [sha(documentId)] : [];
          }),
        ),
      ),
    ],
    status: result.status,
    cacheEvents: pendingCacheEvents.map((event) => event.event),
  });
  return response;
}

async function dispatch(request: BridgeRequestV1): Promise<unknown> {
  const params = request.params ?? {};
  switch (request.method) {
    case "prepare":
      return prepare(params);
    case "ingest":
      return ingest(params);
    case "retrieve":
      return retrieve(params);
    case "stats":
      return {
        ...cache.snapshot(),
        ...(embedding
          ? {
              embedding: embedding.snapshot(),
              embeddingIdentity: {
                mode: embeddingMode,
                indexLevel: denseIndexLevel,
                model: embedding.model,
                version: embedding.version,
                dimensions: embedding.dimensions,
              },
            }
          : { embeddingIdentity: { mode: "off" } }),
        ...(ingestMode === "atom"
          ? {
              atomBudget: memoryLlmBudgets.snapshot().aggregate,
              memoryLlmBudgetPortfolio: memoryLlmBudgets.snapshot(),
              atomCheckpoint: atomCheckpoint?.snapshot() ?? null,
              ...(atomContextMode === "scene_routed"
                ? { routeStats: { ...routeStats } }
                : {}),
            }
          : {}),
      };
    case "cleanup":
      await closeSql();
      return { closed: true };
  }
}

log("bridge_start", {
  pid: process.pid,
  upstreamCommit: "62364d7ead2dc1a7225d6daf4ae23f303b925b40",
  retrievalPolicy,
  ingestMode,
  atomContextMode: ingestMode === "atom" ? atomContextMode : null,
  atomSourceContextMaxChars:
    ingestMode === "atom" && atomContextMode !== "atom_only"
      ? atomSourceContextMaxChars
      : null,
  atomSceneContextMaxChars:
    ingestMode === "atom" && atomContextMode === "scene_hybrid"
      ? atomSceneContextMaxChars
      : null,
  atomSceneIndexMaxChars:
    ingestMode === "atom" &&
    (atomContextMode === "scene_routed" || atomContextMode === "tool_driven")
      ? atomSceneIndexMaxChars
      : null,
  atomPersonaMaxChars:
    ingestMode === "atom" &&
    (atomContextMode === "scene_routed" || atomContextMode === "tool_driven")
      ? atomPersonaMaxChars
      : null,
  providerVersion,
  embeddingMode,
  denseIndexLevel,
  atomControls:
    ingestMode === "atom"
      ? {
          limits: atomLimits,
          memoryLlmBudgetLimits,
          writeMode: atomWriteMode,
          resumeRequested: atomResume,
          reuseIndex,
          identityHash: atomWriterIdentityHash,
        }
      : null,
  fusionWeights:
    retrievalPolicy === "rrf"
      ? {
          text: MEMORY_RRF_TEXT_WEIGHT_V1,
          vector: MEMORY_RRF_VECTOR_WEIGHT_V1,
        }
      : null,
  embedding: embedding
    ? {
        model: embedding.model,
        version: embedding.version,
        dimensions: embedding.dimensions,
        cacheMaxEntries: embeddingCacheMaxEntries,
        streamBatchSize: embeddingStreamBatchSize,
        storeConcurrency: embeddingStoreConcurrency,
        maxAttempts: embeddingMaxAttempts,
        retryBaseDelayMs: embeddingRetryBaseDelayMs,
      }
    : null,
});

const lines = createInterface({
  input: process.stdin,
  crlfDelay: Number.POSITIVE_INFINITY,
});
for await (const line of lines) {
  if (!line.trim()) continue;
  let id = -1;
  let method = "parse";
  try {
    const request = JSON.parse(line) as BridgeRequestV1;
    id = request.id;
    method = request.method;
    const result = await dispatch(request);
    process.stdout.write(`${JSON.stringify({ id, ok: true, result })}\n`);
    if (request.method === "cleanup") break;
  } catch (error) {
    const code = error instanceof Error ? error.name : "UnknownError";
    const databaseError =
      error && typeof error === "object"
        ? (error as Readonly<Record<string, unknown>>)
        : undefined;
    log("bridge_error", {
      id,
      method,
      code,
      databaseCode:
        typeof databaseError?.code === "string" ? databaseError.code : null,
      databaseTable:
        typeof databaseError?.table_name === "string"
          ? databaseError.table_name
          : null,
      databaseConstraint:
        typeof databaseError?.constraint_name === "string"
          ? databaseError.constraint_name
          : null,
      errorFingerprint:
        error instanceof Error ? sha(error.message).slice(0, 20) : null,
      budget:
        ingestMode === "atom" ? memoryLlmBudgets.snapshot().aggregate : null,
      memoryLlmBudgetPortfolio:
        ingestMode === "atom" ? memoryLlmBudgets.snapshot() : null,
      checkpoint: atomCheckpoint?.snapshot() ?? null,
    });
    process.stdout.write(`${JSON.stringify({ id, ok: false, error: code })}\n`);
  }
}
await closeSql();
