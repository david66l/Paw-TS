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

import {
  type MemoryFacetQueryEvidenceV2,
  type MemoryFacetQueryPlanV2,
  type MemoryFacetQueryPlannerEventV2,
  type MemoryFacetQuerySelectorEventV2,
  type MemoryFacetReconcilerEventV2,
  type MemoryFacetReconcilerV2,
  type MemoryFacetShadowEventV2,
  type MemoryFacetShadowSnapshotV2,
  type MemoryWriterModelV1,
  type PawNextMemoryScopeV1,
  applyMemoryFacetShadowReconciliationV2,
  compactMemoryFacetReconcileCatalogV2,
  createEmptyMemoryFacetShadowSnapshotV2,
  createJsonMemoryEvidenceCoveragePlannerV1,
  createJsonMemoryEvidenceSupportVerifierV1,
  createJsonMemoryFacetQueryPlannerV2,
  createJsonMemoryFacetReconcilerV2,
  createMemoryFacetEvidenceBatchesV2,
  createMemoryFacetReconcileCatalogFromSnapshotV2,
  createPostgresMemoryRawEvidenceArchiveV1,
  isMemoryFacetSourceEntryV2,
  memoryEntryToFacetObservationV2,
  selectMemoryFacetQueryEvidenceV2,
} from "@paw/memory-plugin";
import {
  type MemoryEntry,
  PostgresMemoryStoreEngine,
} from "@paw/memory/longterm";
import { closeSql } from "../../packages/memory/src/db/connection.js";

const DEFAULT_RUN_KEY = "e62649f4907e5d94ee15";
const DEFAULT_DATABASE_URL =
  "postgresql://postgres@127.0.0.1:54329/paw_memory_test";
const MAX_OUTPUT_TOKENS = 4_096;

interface ModelSettlementV2 {
  readonly schemaVersion: "paw.amb-facet-model-settlement.v2";
  readonly model: string;
  readonly promptHash: string;
  readonly cacheHit: boolean;
  readonly status: "completed" | "failed" | "truncated";
  readonly durationMs: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly providerCacheHitTokens: number;
  readonly providerCacheMissTokens: number;
  readonly reasonCode?: string;
}

interface RunStatsV2 {
  modelCalls: number;
  localCacheHits: number;
  promptTokens: number;
  completionTokens: number;
  providerCacheHitTokens: number;
  providerCacheMissTokens: number;
  repairs: number;
  salvages: number;
  deferredRetryBatches: number;
}

const runKey =
  optionalText(process.env.PAW_AMB_FACET_RUN_KEY) ?? DEFAULT_RUN_KEY;
const userId = requiredText(
  process.env.PAW_AMB_FACET_USER_ID,
  "PAW_AMB_FACET_USER_ID",
);
const scope: PawNextMemoryScopeV1 = Object.freeze({
  tenantId: "amb",
  userId,
  workspaceId: `amb-run-${runKey}`,
  repositoryId: `amb-personamem-${runKey}`,
});
const batchSize = boundedInteger(
  process.env.PAW_AMB_FACET_BATCH_SIZE,
  16,
  1,
  32,
  "PAW_AMB_FACET_BATCH_SIZE",
);
const outputPath = resolve(
  process.env.PAW_AMB_FACET_OUTPUT ??
    `benchmarks/amb/runs/facet-shadow-${runKey}-${shortHash(userId)}.json`,
);
const logPath = resolve(
  process.env.PAW_AMB_FACET_LOG ??
    `logs/amb/facet-shadow-${runKey}-${shortHash(userId)}.jsonl`,
);
const cacheDir = resolve(
  process.env.PAW_AMB_FACET_CACHE_DIR ??
    "benchmarks/amb/runs/.llm-cache-t0/facet-reconcile-v2",
);
const selectedIds = parseSelectedIds(process.env.PAW_AMB_FACET_MEMORY_IDS);
const decisionQuery = optionalText(process.env.PAW_AMB_FACET_DECISION_QUERY);
const stats: RunStatsV2 = {
  modelCalls: 0,
  localCacheHits: 0,
  promptTokens: 0,
  completionTokens: 0,
  providerCacheHitTokens: 0,
  providerCacheMissTokens: 0,
  repairs: 0,
  salvages: 0,
  deferredRetryBatches: 0,
};

process.env.DATABASE_URL =
  optionalText(process.env.DATABASE_URL) ?? DEFAULT_DATABASE_URL;
mkdirSync(dirname(outputPath), { recursive: true });
mkdirSync(dirname(logPath), { recursive: true });
mkdirSync(cacheDir, { recursive: true });

await main().finally(closeSql);

async function main(): Promise<void> {
  const started = Date.now();
  const model = createDeepSeekFacetModel();
  const store = new PostgresMemoryStoreEngine(scope);
  const queried = await store.query({
    repo: scope.repositoryId,
    includeInvalidated: true,
    includeDegraded: false,
    limit: 1_000,
  });
  const facetCandidates = queried.filter(isFacetCandidateEntry);
  const eligible = facetCandidates.filter(isMemoryFacetSourceEntryV2);
  const excludedDerivedProfileCount = facetCandidates.length - eligible.length;
  const entries = selectEntries(eligible, selectedIds).sort(compareEntries);
  if (entries.length === 0) throw namedError("FacetShadowNoEntries");

  log("run_started", {
    schemaVersion: "paw.amb-facet-shadow-run-event.v2",
    runKeyHash: shortHash(runKey),
    userIdHash: shortHash(userId),
    selectedById: selectedIds.length > 0,
    entryCount: entries.length,
    excludedDerivedProfileCount,
    batchSize,
  });

  const reconciler = createJsonMemoryFacetReconcilerV2({
    model,
    onEvent(event) {
      if (event.repaired) stats.repairs += 1;
      if (event.salvaged) stats.salvages += 1;
      logReconciler(event);
    },
  });
  let snapshot = createEmptyMemoryFacetShadowSnapshotV2(scope);
  const evidenceBatches = createMemoryFacetEvidenceBatchesV2(
    entries,
    batchSize,
  );
  for (const batch of evidenceBatches) {
    snapshot = await reconcileBatch(snapshot, batch, reconciler, 0);
  }
  const entryById = new Map(entries.map((entry) => [entry.id, entry]));
  if (snapshot.unassignedMemoryIds.length > 0) {
    const retryEntries = snapshot.unassignedMemoryIds.map((memoryId) => {
      const entry = entryById.get(memoryId);
      if (!entry) throw namedError("FacetShadowRetryEntryMissing");
      return entry;
    });
    for (let offset = 0; offset < retryEntries.length; offset += batchSize) {
      stats.deferredRetryBatches += 1;
      snapshot = await reconcileBatch(
        snapshot,
        retryEntries.slice(offset, offset + batchSize),
        reconciler,
        1,
      );
    }
  }

  const query = optionalText(process.env.PAW_AMB_FACET_QUERY);
  let queryDiagnostic: unknown;
  if (query) {
    const planner = createJsonMemoryFacetQueryPlannerV2({
      model,
      onEvent(event) {
        if (event.repaired) stats.repairs += 1;
        logQueryPlanner(event);
      },
    });
    const plan = await planner.plan(
      {
        query,
        snapshotRevision: snapshot.revision,
        facets: snapshot.projections,
        maxSelectedFacets: 4,
      },
      new AbortController().signal,
    );
    const selection = selectMemoryFacetQueryEvidenceV2(
      {
        query,
        plan,
        projections: snapshot.projections,
        maxEvidence: 12,
        maxChars: 8_000,
      },
      { onEvent: logQuerySelector },
    );
    const decisionSupport = decisionQuery
      ? await planAndVerifyDecisionEvidence(
          decisionQuery,
          plan,
          selection.evidence,
          snapshot,
          model,
        )
      : undefined;
    queryDiagnostic = Object.freeze({
      query,
      plan,
      selection,
      ...(decisionSupport === undefined ? {} : { decisionSupport }),
    });
  }

  const report = buildReport(
    snapshot,
    entries,
    started,
    queryDiagnostic,
    excludedDerivedProfileCount,
  );
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  log("run_completed", {
    schemaVersion: "paw.amb-facet-shadow-run-event.v2",
    runKeyHash: shortHash(runKey),
    userIdHash: shortHash(userId),
    sourceEntryCount: entries.length,
    excludedDerivedProfileCount,
    facetCount: snapshot.facets.length,
    membershipCount: snapshot.memberships.length,
    unassignedCount: snapshot.unassignedMemoryIds.length,
    queryExecuted: query !== undefined,
    stats,
    reportPathHash: shortHash(outputPath),
    durationMs: Math.max(0, Date.now() - started),
  });
  process.stdout.write(
    `${JSON.stringify({
      outputPath,
      logPath,
      sourceEntryCount: entries.length,
      facetCount: snapshot.facets.length,
      membershipCount: snapshot.memberships.length,
      unassignedCount: snapshot.unassignedMemoryIds.length,
      stats,
    })}\n`,
  );
}

async function planAndVerifyDecisionEvidence(
  query: string,
  initialPlan: MemoryFacetQueryPlanV2,
  initialEvidence: readonly MemoryFacetQueryEvidenceV2[],
  snapshot: MemoryFacetShadowSnapshotV2,
  model: MemoryWriterModelV1,
) {
  const signal = new AbortController().signal;
  const planner = createJsonMemoryEvidenceCoveragePlannerV1({ model });
  const proposals = await planner.plan(
    {
      query,
      evidence: initialEvidence.map((item) => ({
        memoryId: item.state.memoryId,
        layer: "L1" as const,
        statement: item.state.statement,
      })),
      topics: snapshot.projections.map((projection) => ({
        topicId: projection.facet.id,
        family: projection.facet.canonicalKey.split(".")[0] ?? "memory",
        name: projection.facet.displayName,
      })),
      maxRequirements: 6,
      maxExpansionTopics: 4,
    },
    signal,
  );
  const expansionFacetIds = [
    ...new Set(proposals.flatMap((proposal) => proposal.expandTopicIds)),
  ].filter((facetId) => !initialPlan.facetIds.includes(facetId));
  let expandedEvidence: readonly MemoryFacetQueryEvidenceV2[] = [];
  if (expansionFacetIds.length > 0) {
    const expansionPlan: MemoryFacetQueryPlanV2 = Object.freeze({
      plannerVersion: initialPlan.plannerVersion,
      planRevision: sha(
        JSON.stringify({
          schemaVersion: "paw.amb-facet-expansion-plan.v1",
          query,
          snapshotRevision: snapshot.revision,
          facetIds: expansionFacetIds,
          view: initialPlan.view,
        }),
      ),
      snapshotRevision: snapshot.revision,
      view: initialPlan.view,
      facetIds: Object.freeze(expansionFacetIds),
      confidence: 1,
    });
    expandedEvidence = selectMemoryFacetQueryEvidenceV2({
      query,
      plan: expansionPlan,
      projections: snapshot.projections,
      maxEvidence: 16,
      maxChars: 8_000,
    }).evidence;
  }
  const evidence = uniqueDecisionEvidence([
    ...initialEvidence,
    ...expandedEvidence,
  ]).slice(0, 16);
  const expandedIdsByFacet = new Map<string, string[]>();
  for (const item of evidence) {
    const ids = expandedIdsByFacet.get(item.facetId) ?? [];
    ids.push(item.state.memoryId);
    expandedIdsByFacet.set(item.facetId, ids);
  }
  const requirements = proposals.map((proposal, index) => {
    const candidateMemoryIds = [
      ...new Set([
        ...proposal.coveredMemoryIds,
        ...proposal.expandTopicIds.flatMap(
          (facetId) => expandedIdsByFacet.get(facetId) ?? [],
        ),
      ]),
    ].filter((memoryId) =>
      evidence.some((item) => item.state.memoryId === memoryId),
    );
    return Object.freeze({
      requirementId: sha(
        JSON.stringify({
          schemaVersion: "paw.amb-facet-decision-requirement.v1",
          query,
          index,
          description: proposal.description,
        }),
      ),
      description: proposal.description,
      priority: proposal.priority,
      minimumEvidence: proposal.minimumEvidence,
      candidateMemoryIds: Object.freeze(candidateMemoryIds),
      expandedFacetIds: proposal.expandTopicIds,
    });
  });
  const archive = createPostgresMemoryRawEvidenceArchiveV1({ scope });
  const requests = uniqueRawEvidenceRequests(evidence).slice(0, 16);
  const spans = await archive.resolve(requests, signal);
  let assessments: readonly unknown[] = [];
  if (requirements.length > 0 && evidence.length > 0 && spans.length > 0) {
    const verifier = createJsonMemoryEvidenceSupportVerifierV1({ model });
    const verification = await verifier.verify(
      {
        query,
        requirements: requirements.map(
          ({ expandedFacetIds: _expanded, ...requirement }) => requirement,
        ),
        evidence: evidence.map((item) => ({
          memoryId: item.state.memoryId,
          layer: "L1" as const,
          statement: item.state.statement,
          ...(item.bucket === "current" || item.bucket === "historical"
            ? { state: item.bucket }
            : {}),
          validFrom: item.state.validFrom,
        })),
        spans,
      },
      signal,
    );
    assessments = verification.assessments;
  }
  log("decision_support_completed", {
    schemaVersion: "paw.amb-facet-decision-support-event.v1",
    requirementCount: requirements.length,
    initialEvidenceCount: initialEvidence.length,
    expansionFacetCount: expansionFacetIds.length,
    evidenceCount: evidence.length,
    spanCount: spans.length,
    assessmentCount: assessments.length,
  });
  return Object.freeze({
    schemaVersion: "paw.amb-facet-decision-support.v1",
    requirements,
    expansionFacetIds: Object.freeze(expansionFacetIds),
    evidence: Object.freeze(evidence),
    spanCount: spans.length,
    assessments: Object.freeze(assessments),
  });
}

function uniqueDecisionEvidence(
  values: readonly MemoryFacetQueryEvidenceV2[],
): MemoryFacetQueryEvidenceV2[] {
  const seen = new Set<string>();
  return values.filter((item) => {
    if (seen.has(item.state.memoryId)) return false;
    seen.add(item.state.memoryId);
    return true;
  });
}

function uniqueRawEvidenceRequests(
  evidence: readonly MemoryFacetQueryEvidenceV2[],
) {
  const byRef = new Map<string, Set<string>>();
  for (const item of evidence) {
    for (const evidenceRef of item.state.evidenceRefs) {
      const ids = byRef.get(evidenceRef) ?? new Set<string>();
      ids.add(item.state.memoryId);
      byRef.set(evidenceRef, ids);
    }
  }
  return [...byRef].map(([evidenceRef, memoryIds]) => ({
    evidenceRef,
    memoryIds: [...memoryIds],
  }));
}

async function reconcileBatch(
  previous: MemoryFacetShadowSnapshotV2,
  batch: readonly MemoryEntry[],
  reconciler: MemoryFacetReconcilerV2,
  attempt: number,
): Promise<MemoryFacetShadowSnapshotV2> {
  const observations = batch.map(memoryEntryToFacetObservationV2);
  const sourceRevision = sha(
    JSON.stringify({
      schemaVersion: "paw.amb-facet-shadow-source.v2",
      runKey,
      ...(attempt === 0 ? {} : { attempt }),
      ids: batch.map((entry) => entry.id),
      entries: batch.map(entryRevisionMaterial),
    }),
  );
  const reconciliation = await reconciler.reconcile(
    {
      scope,
      sourceRevision,
      observedAt: latestTimestamp(batch),
      observations,
      catalog: compactMemoryFacetReconcileCatalogV2({
        observations,
        catalog: createMemoryFacetReconcileCatalogFromSnapshotV2(previous),
        maxFacetsWithMembers: 16,
        maxMembersPerFacet: 8,
      }),
      maxNewFacets: 16,
    },
    new AbortController().signal,
  );
  return applyMemoryFacetShadowReconciliationV2(
    { scope, previous, observations: batch, reconciliation },
    { onEvent: logShadow },
  );
}

function createDeepSeekFacetModel(): MemoryWriterModelV1 {
  const apiKey = requiredText(process.env.DEEPSEEK_API_KEY, "DEEPSEEK_API_KEY");
  const model = optionalText(process.env.DEEPSEEK_MODEL) ?? "deepseek-v4-flash";
  const baseUrl = (
    optionalText(process.env.DEEPSEEK_BASE_URL) ?? "https://api.deepseek.com"
  ).replace(/\/+$/, "");
  return Object.freeze({
    async complete(
      request: Parameters<MemoryWriterModelV1["complete"]>[0],
      options: Parameters<MemoryWriterModelV1["complete"]>[1],
    ) {
      const promptHash = sha(
        JSON.stringify({ system: request.system, user: request.user }),
      );
      const cacheKey = sha(
        JSON.stringify({
          policy: "paw.amb-facet-reconcile-cache.v2",
          model,
          baseUrl,
          promptHash,
          temperature: 0,
          thinking: "disabled",
          maxTokens: MAX_OUTPUT_TOKENS,
        }),
      );
      const cachePath = resolve(cacheDir, `${cacheKey}.json`);
      if (existsSync(cachePath)) {
        try {
          const cached = JSON.parse(readFileSync(cachePath, "utf8")) as {
            text?: unknown;
          };
          if (typeof cached.text === "string" && cached.text.trim()) {
            stats.localCacheHits += 1;
            settleModel({
              schemaVersion: "paw.amb-facet-model-settlement.v2",
              model,
              promptHash,
              cacheHit: true,
              status: "completed",
              durationMs: 0,
              promptTokens: 0,
              completionTokens: 0,
              providerCacheHitTokens: 0,
              providerCacheMissTokens: 0,
            });
            return { status: "completed" as const, text: cached.text };
          }
        } catch {
          // Corrupt local cache entries are ignored and replaced atomically.
        }
      }

      const started = performance.now();
      stats.modelCalls += 1;
      try {
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
            max_tokens: MAX_OUTPUT_TOKENS,
            thinking: { type: "disabled" },
          }),
          signal: options.signal,
        });
        if (!response.ok) {
          throw namedError(`FacetModelHttp${response.status}`);
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
        const usage = {
          promptTokens: payload.usage?.prompt_tokens ?? 0,
          completionTokens: payload.usage?.completion_tokens ?? 0,
          providerCacheHitTokens: payload.usage?.prompt_cache_hit_tokens ?? 0,
          providerCacheMissTokens: payload.usage?.prompt_cache_miss_tokens ?? 0,
        };
        addUsage(usage);
        if (
          choice?.finish_reason === "length" ||
          choice?.finish_reason === "max_tokens"
        ) {
          settleModel({
            schemaVersion: "paw.amb-facet-model-settlement.v2",
            model,
            promptHash,
            cacheHit: false,
            status: "truncated",
            durationMs: Math.max(0, performance.now() - started),
            ...usage,
          });
          return {
            status: "truncated" as const,
            errorCode: "FacetModelTruncated",
          };
        }
        if (typeof text !== "string" || !text.trim()) {
          throw namedError("FacetModelEmptyResponse");
        }
        const tempPath = `${cachePath}.${process.pid}.tmp`;
        writeFileSync(tempPath, JSON.stringify({ text }), "utf8");
        renameSync(tempPath, cachePath);
        settleModel({
          schemaVersion: "paw.amb-facet-model-settlement.v2",
          model,
          promptHash,
          cacheHit: false,
          status: "completed",
          durationMs: Math.max(0, performance.now() - started),
          ...usage,
        });
        return { status: "completed" as const, text };
      } catch (error) {
        if (options.signal.aborted) {
          return {
            status: "cancelled" as const,
            errorCode: "FacetModelCancelled",
          };
        }
        settleModel({
          schemaVersion: "paw.amb-facet-model-settlement.v2",
          model,
          promptHash,
          cacheHit: false,
          status: "failed",
          durationMs: Math.max(0, performance.now() - started),
          promptTokens: 0,
          completionTokens: 0,
          providerCacheHitTokens: 0,
          providerCacheMissTokens: 0,
          reasonCode: stableReason(error),
        });
        return {
          status: "failed" as const,
          errorCode: stableReason(error),
        };
      }
    },
  });
}

function buildReport(
  snapshot: MemoryFacetShadowSnapshotV2,
  entries: readonly MemoryEntry[],
  started: number,
  queryDiagnostic: unknown,
  excludedDerivedProfileCount: number,
) {
  return {
    schemaVersion: "paw.amb-facet-shadow-report.v2",
    diagnosticOnly: true,
    persistenceWrites: false,
    scope: {
      tenantId: scope.tenantId,
      userIdHash: shortHash(scope.userId),
      workspaceId: scope.workspaceId,
      repositoryId: scope.repositoryId,
    },
    runKey,
    selectedMemoryIds: entries.map((entry) => entry.id),
    sourceEntryCount: entries.length,
    excludedDerivedProfileCount,
    batchSize,
    stats,
    durationMs: Math.max(0, Date.now() - started),
    snapshot,
    ...(queryDiagnostic === undefined ? {} : { queryDiagnostic }),
  };
}

function selectEntries(
  entries: readonly MemoryEntry[],
  ids: readonly string[],
): MemoryEntry[] {
  if (ids.length === 0) return [...entries];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw namedError(`FacetShadowSelectedIdsMissing_${missing.length}`);
  }
  return ids.map((id) => {
    const entry = byId.get(id);
    if (!entry) throw namedError("FacetShadowSelectedIdMissing");
    return entry;
  });
}

function isFacetCandidateEntry(
  entry: MemoryEntry,
): entry is Extract<
  MemoryEntry,
  { kind: "semantic" | "episodic" | "profile" }
> {
  return (
    entry.kind === "semantic" ||
    entry.kind === "episodic" ||
    entry.kind === "profile"
  );
}

function compareEntries(left: MemoryEntry, right: MemoryEntry): number {
  return (
    Date.parse(left.tValid) - Date.parse(right.tValid) ||
    left.id.localeCompare(right.id)
  );
}

function entryRevisionMaterial(entry: MemoryEntry) {
  return {
    id: entry.id,
    kind: entry.kind,
    tValid: entry.tValid,
    tInvalid: entry.tInvalid,
    statement:
      entry.kind === "semantic"
        ? entry.fact
        : entry.kind === "profile"
          ? entry.insight
          : entry.kind === "episodic"
            ? entry.perspective || entry.whenToUse
            : "",
  };
}

function latestTimestamp(entries: readonly MemoryEntry[]): string {
  const first = entries[0];
  if (!first) throw namedError("FacetShadowNoEntries");
  return entries.reduce(
    (latest, entry) =>
      Date.parse(entry.tValid) > Date.parse(latest) ? entry.tValid : latest,
    first.tValid,
  );
}

function settleModel(event: ModelSettlementV2): void {
  log("model_settlement", event);
}

function addUsage(
  input: Readonly<{
    promptTokens: number;
    completionTokens: number;
    providerCacheHitTokens: number;
    providerCacheMissTokens: number;
  }>,
): void {
  stats.promptTokens += input.promptTokens;
  stats.completionTokens += input.completionTokens;
  stats.providerCacheHitTokens += input.providerCacheHitTokens;
  stats.providerCacheMissTokens += input.providerCacheMissTokens;
}

function logReconciler(event: MemoryFacetReconcilerEventV2): void {
  log("reconciler", event);
}

function logShadow(event: MemoryFacetShadowEventV2): void {
  log("shadow", event);
}

function logQueryPlanner(event: MemoryFacetQueryPlannerEventV2): void {
  log("query_planner", event);
}

function logQuerySelector(event: MemoryFacetQuerySelectorEventV2): void {
  log("query_selector", event);
}

function log(event: string, detail: unknown): void {
  appendFileSync(
    logPath,
    `${JSON.stringify({ at: new Date().toISOString(), event, detail })}\n`,
    "utf8",
  );
}

function parseSelectedIds(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  const ids = [...new Set(value.split(",").map((item) => item.trim()))].filter(
    Boolean,
  );
  if (ids.some((id) => id.length > 256)) {
    throw namedError("PAW_AMB_FACET_MEMORY_IDSInvalid");
  }
  return ids;
}

function requiredText(value: string | undefined, name: string): string {
  const result = optionalText(value);
  if (!result) throw namedError(`${name}Required`);
  return result;
}

function optionalText(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result ? result : undefined;
}

function boundedInteger(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (!raw?.trim()) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw namedError(`${name}Invalid`);
  }
  return value;
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function shortHash(value: string): string {
  return sha(value).slice(0, 16);
}

function stableReason(error: unknown): string {
  const name = error instanceof Error ? error.name : "Unknown";
  return name.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 160) || "Unknown";
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
