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
  type MemoryAspectGraphSnapshotV1,
  type MemoryAspectLinkerEventV1,
  type MemoryFacetShadowSnapshotV2,
  type MemoryWriterModelV1,
  type PawNextMemoryScopeV1,
  applyMemoryAspectGraphMutationV1,
  applyMemoryAspectLinkingV1,
  buildMemoryAspectLinkCandidatesV1,
  createEmptyMemoryAspectGraphSnapshotV1,
  createJsonMemoryAspectLinkerV1,
  createMemoryAspectGraphGoldV1,
  createMemoryFacetEvidenceBatchesV2,
  deriveMemoryAspectLinkStatementHashV1,
  evaluateMemoryAspectGraphGoldV1,
  measureMemoryAspectGraphV1,
  memoryEntryToFacetObservationV2,
  migrateMemoryFacetShadowToAspectGraphV1,
  parseMemoryAspectGraphGoldV1,
} from "@paw/memory-plugin";
import type { MemoryEntry } from "@paw/memory/longterm";

const MAX_OUTPUT_TOKENS = 4_096;
const facetReportPath = resolve(
  required(
    process.env.PAW_AMB_ASPECT_FACET_REPORT,
    "PAW_AMB_ASPECT_FACET_REPORT",
  ),
);
const goldPath = resolve(
  required(process.env.PAW_AMB_ASPECT_GOLD, "PAW_AMB_ASPECT_GOLD"),
);
const outputPath = resolve(
  process.env.PAW_AMB_ASPECT_LINKER_OUTPUT ??
    "benchmarks/amb/runs/aspect-linker-shadow.json",
);
const logPath = resolve(
  process.env.PAW_AMB_ASPECT_LINKER_LOG ??
    "logs/amb/aspect-linker-shadow.jsonl",
);
const checkpointPath = resolve(
  process.env.PAW_AMB_ASPECT_LINKER_CHECKPOINT ??
    `${outputPath}.checkpoint.json`,
);
const cacheDir = resolve(
  process.env.PAW_AMB_ASPECT_LINKER_CACHE_DIR ??
    "benchmarks/amb/runs/.llm-cache-t0/aspect-linker-v1",
);
const batchSize = boundedInteger(
  process.env.PAW_AMB_ASPECT_LINKER_BATCH_SIZE,
  1,
  1,
  8,
  "PAW_AMB_ASPECT_LINKER_BATCH_SIZE",
);
const stats = {
  modelCalls: 0,
  localCacheHits: 0,
  promptTokens: 0,
  completionTokens: 0,
  providerCacheHitTokens: 0,
  providerCacheMissTokens: 0,
  linkedBatches: 0,
  deferredBatches: 0,
  retryCalls: 0,
  enrichmentCalls: 0,
  recoveryCalls: 0,
};

mkdirSync(dirname(outputPath), { recursive: true });
mkdirSync(dirname(logPath), { recursive: true });
mkdirSync(dirname(checkpointPath), { recursive: true });
mkdirSync(cacheDir, { recursive: true });

await main();

async function main(): Promise<void> {
  const startedAt = Date.now();
  const report = objectValue(readJson(facetReportPath));
  const source = report.snapshot as MemoryFacetShadowSnapshotV2;
  const reportScope = objectValue(report.scope);
  const userId = required(
    process.env.PAW_AMB_ASPECT_USER_ID,
    "PAW_AMB_ASPECT_USER_ID",
  );
  if (shortHash(userId) !== stringValue(reportScope.userIdHash)) {
    throw namedError("AspectLinkerShadowUserScopeMismatch");
  }
  const scope: PawNextMemoryScopeV1 = Object.freeze({
    tenantId: stringValue(reportScope.tenantId),
    userId,
    workspaceId: stringValue(reportScope.workspaceId),
    repositoryId: stringValue(reportScope.repositoryId),
  });
  const sourceHash = fileHash(facetReportPath);
  const goldHash = fileHash(goldPath);
  const migrated = migrateMemoryFacetShadowToAspectGraphV1({ scope, source });
  const gold = parseMemoryAspectGraphGoldV1(
    readJson(goldPath),
    migrated.snapshot,
  );
  const entries = [...source.entries]
    .map((entry) => entry as MemoryEntry)
    .sort(compareEntries);
  const evidence = new Map(
    entries.map((entry) => {
      const observation = memoryEntryToFacetObservationV2(entry);
      return [
        observation.id,
        Object.freeze({
          claimId: observation.id,
          statement: observation.statement,
          statementHash: deriveMemoryAspectLinkStatementHashV1(
            observation.statement,
          ),
        }),
      ] as const;
    }),
  );
  const resumed = loadCheckpoint({ sourceHash, goldHash });
  let snapshot =
    resumed?.snapshot ??
    applyMemoryAspectGraphMutationV1({
      snapshot: createEmptyMemoryAspectGraphSnapshotV1(scope),
      claims: migrated.snapshot.claims,
    });
  const processed = new Set(resumed?.processedClaimIds ?? []);
  const retried = new Set(resumed?.retriedClaimIds ?? []);
  const enriched = new Set(resumed?.enrichedClaimIds ?? []);
  const recovered = new Set(resumed?.recoveredClaimIds ?? []);
  const candidateTotals = {
    buildCount: 0,
    promptChars: 0,
    maxPromptChars: 0,
    truncatedAspects: 0,
    truncatedRepresentatives: 0,
    truncatedRelations: 0,
  };
  if (resumed !== null) {
    hydrateCumulativeStats(candidateTotals);
    stats.retryCalls = retried.size;
    stats.enrichmentCalls = enriched.size;
    stats.recoveryCalls = recovered.size;
  }
  const model = createDeepSeekModel();
  const linker = createJsonMemoryAspectLinkerV1({
    model,
    onEvent: logLinker,
  });
  log("run_started", {
    schemaVersion: "paw.amb-aspect-linker-shadow-event.v1",
    sourceReportHash: sourceHash,
    goldFileHash: goldHash,
    userIdHash: shortHash(userId),
    claimCount: entries.length,
    batchSize,
    resumed: resumed !== null,
    processedCount: processed.size,
  });

  const batches = createMemoryFacetEvidenceBatchesV2(entries, batchSize);
  for (const batch of batches) {
    const pending = batch.filter((entry) => !processed.has(entry.id));
    if (pending.length === 0) continue;
    snapshot = await linkBatch({
      scope,
      snapshot,
      batch: pending,
      evidence,
      processed,
      linker,
      candidateTotals,
      mode: "initial",
    });
    for (const entry of pending) processed.add(entry.id);
    saveCheckpoint({
      sourceHash,
      goldHash,
      snapshot,
      processed,
      retried,
      enriched,
      recovered,
    });
  }

  const unassigned = unassignedClaimIds(snapshot);
  for (const claimId of unassigned) {
    if (retried.has(claimId)) continue;
    const entry = entries.find((item) => item.id === claimId);
    if (entry === undefined) throw namedError("AspectLinkerRetryEntryMissing");
    stats.retryCalls += 1;
    snapshot = await linkBatch({
      scope,
      snapshot,
      batch: [entry],
      evidence,
      processed,
      linker,
      candidateTotals,
      mode: "initial",
    });
    retried.add(claimId);
    saveCheckpoint({
      sourceHash,
      goldHash,
      snapshot,
      processed,
      retried,
      enriched,
      recovered,
    });
  }

  if (process.env.PAW_AMB_ASPECT_LINKER_ENRICH === "1") {
    for (const entry of entries) {
      if (
        enriched.has(entry.id) ||
        unassignedClaimIds(snapshot).includes(entry.id)
      ) {
        continue;
      }
      stats.enrichmentCalls += 1;
      snapshot = await linkBatch({
        scope,
        snapshot,
        batch: [entry],
        evidence,
        processed,
        linker,
        candidateTotals,
        mode: "enrichment",
      });
      enriched.add(entry.id);
      saveCheckpoint({
        sourceHash,
        goldHash,
        snapshot,
        processed,
        retried,
        enriched,
        recovered,
      });
    }
  }

  if (process.env.PAW_AMB_ASPECT_LINKER_RECOVER === "1") {
    for (const claimId of unassignedClaimIds(snapshot)) {
      if (recovered.has(claimId)) continue;
      const entry = entries.find((item) => item.id === claimId);
      if (entry === undefined)
        throw namedError("AspectLinkerRecoveryEntryMissing");
      stats.recoveryCalls += 1;
      snapshot = await linkBatch({
        scope,
        snapshot,
        batch: [entry],
        evidence,
        processed,
        linker,
        candidateTotals,
        mode: "initial",
      });
      recovered.add(claimId);
      saveCheckpoint({
        sourceHash,
        goldHash,
        snapshot,
        processed,
        retried,
        enriched,
        recovered,
      });
    }
  }

  const evaluation = evaluateGoldWithIsolatedCurrentCases(snapshot, gold);
  const metrics = measureMemoryAspectGraphV1(snapshot);
  const output = Object.freeze({
    schemaVersion: "paw.amb-aspect-linker-shadow-report.v1",
    diagnosticOnly: true,
    persistenceWrites: false,
    sourceArm: "aspect-linker-v1-claim-only-cold-rebuild",
    sourceReportHash: sourceHash,
    goldFileHash: goldHash,
    annotationSetId: gold.annotationSetId,
    corpusRevision: gold.corpusRevision,
    graphRevision: snapshot.revision,
    batchSize,
    stats,
    candidateTotals,
    metrics,
    unassignedClaimCount: unassignedClaimIds(snapshot).length,
    evaluation,
    durationMs: Math.max(0, Date.now() - startedAt),
    snapshot,
  });
  atomicWriteJson(outputPath, output);
  log("run_completed", {
    schemaVersion: "paw.amb-aspect-linker-shadow-event.v1",
    outputPathHash: shortHash(outputPath),
    graphRevision: snapshot.revision,
    claimCount: metrics.claimCount,
    aspectCount: metrics.aspectCount,
    membershipCount: metrics.membershipCount,
    edgeCount: metrics.edgeCount,
    unassignedClaimCount: output.unassignedClaimCount,
    pairAccuracy: evaluation.pairwise.accuracy,
    edgeAccuracy: evaluation.evidenceEdges.accuracy,
    currentStateExactMatch: evaluation.currentStateExactMatch,
    currentStateAmbiguousCaseCount: evaluation.currentStateAmbiguousCaseCount,
    stats,
    candidateTotals,
    durationMs: output.durationMs,
  });
}

function hydrateCumulativeStats(candidateTotals: {
  buildCount: number;
  promptChars: number;
  maxPromptChars: number;
  truncatedAspects: number;
  truncatedRepresentatives: number;
  truncatedRelations: number;
}): void {
  if (!existsSync(logPath)) return;
  for (const line of readFileSync(logPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const record = objectValue(JSON.parse(line));
    const event = stringValue(record.event);
    const detail = objectValue(record.detail);
    if (event === "model_settlement") {
      if (detail.cacheHit === true) stats.localCacheHits += 1;
      else stats.modelCalls += 1;
      stats.promptTokens += numberValue(detail.promptTokens);
      stats.completionTokens += numberValue(detail.completionTokens);
      stats.providerCacheHitTokens += numberValue(
        detail.providerCacheHitTokens,
      );
      stats.providerCacheMissTokens += numberValue(
        detail.providerCacheMissTokens,
      );
    } else if (event === "linker_settlement") {
      if (detail.settlement === "linked") stats.linkedBatches += 1;
      else stats.deferredBatches += 1;
    } else if (event === "candidate_built") {
      candidateTotals.buildCount += 1;
      candidateTotals.promptChars += numberValue(detail.promptChars);
      candidateTotals.maxPromptChars = Math.max(
        candidateTotals.maxPromptChars,
        numberValue(detail.promptChars),
      );
      candidateTotals.truncatedAspects += numberValue(
        detail.truncatedAspectCount,
      );
      candidateTotals.truncatedRepresentatives += numberValue(
        detail.truncatedRepresentativeCount,
      );
      candidateTotals.truncatedRelations += numberValue(
        detail.truncatedRelationTargetCount,
      );
    }
  }
}

function evaluateGoldWithIsolatedCurrentCases(
  snapshot: MemoryAspectGraphSnapshotV1,
  gold: ReturnType<typeof parseMemoryAspectGraphGoldV1>,
) {
  const relationGold = createMemoryAspectGraphGoldV1({
    snapshot,
    annotationSetId: `${gold.annotationSetId}:relations`,
    pairs: gold.pairs,
    edges: gold.edges,
  });
  const relationEvaluation = evaluateMemoryAspectGraphGoldV1(
    snapshot,
    relationGold,
  );
  let evaluatedCaseCount = 0;
  let ambiguousCaseCount = 0;
  let exactCaseCount = 0;
  const current = {
    total: 0,
    correct: 0,
    truePositive: 0,
    trueNegative: 0,
    falsePositive: 0,
    falseNegative: 0,
  };
  for (const currentState of gold.currentStates) {
    try {
      const caseGold = createMemoryAspectGraphGoldV1({
        snapshot,
        annotationSetId: `${gold.annotationSetId}:current-case`,
        currentStates: [currentState],
      });
      const result = evaluateMemoryAspectGraphGoldV1(snapshot, caseGold);
      evaluatedCaseCount += 1;
      exactCaseCount += result.currentStateExactMatch === 1 ? 1 : 0;
      current.total += result.currentState.total;
      current.correct += result.currentState.correct;
      current.truePositive += result.currentState.truePositive;
      current.trueNegative += result.currentState.trueNegative;
      current.falsePositive += result.currentState.falsePositive;
      current.falseNegative += result.currentState.falseNegative;
    } catch (error) {
      if (
        stableReason(error) !== "MemoryAspectGoldCurrentStateAnchorAmbiguous"
      ) {
        throw error;
      }
      ambiguousCaseCount += 1;
    }
  }
  return Object.freeze({
    schemaVersion: "paw.memory-aspect-graph-gold-eval-isolated.v1",
    annotationSetId: gold.annotationSetId,
    corpusRevision: gold.corpusRevision,
    pairwise: relationEvaluation.pairwise,
    evidenceEdges: relationEvaluation.evidenceEdges,
    currentState: Object.freeze({
      ...current,
      accuracy: ratio(current.correct, current.total),
      precision: ratio(
        current.truePositive,
        current.truePositive + current.falsePositive,
      ),
      recall: ratio(
        current.truePositive,
        current.truePositive + current.falseNegative,
      ),
      f1: f1(
        ratio(
          current.truePositive,
          current.truePositive + current.falsePositive,
        ),
        ratio(
          current.truePositive,
          current.truePositive + current.falseNegative,
        ),
      ),
    }),
    currentStateCaseCount: gold.currentStates.length,
    currentStateEvaluatedCaseCount: evaluatedCaseCount,
    currentStateAmbiguousCaseCount: ambiguousCaseCount,
    currentStateExactMatch: ratio(exactCaseCount, gold.currentStates.length),
  });
}

async function linkBatch(
  input: Readonly<{
    scope: PawNextMemoryScopeV1;
    snapshot: MemoryAspectGraphSnapshotV1;
    batch: readonly MemoryEntry[];
    evidence: ReadonlyMap<
      string,
      Readonly<{ claimId: string; statement: string; statementHash: string }>
    >;
    processed: ReadonlySet<string>;
    linker: ReturnType<typeof createJsonMemoryAspectLinkerV1>;
    candidateTotals: {
      buildCount: number;
      promptChars: number;
      maxPromptChars: number;
      truncatedAspects: number;
      truncatedRepresentatives: number;
      truncatedRelations: number;
    };
    mode: "initial" | "enrichment";
  }>,
): Promise<MemoryAspectGraphSnapshotV1> {
  const claims = input.batch.map((entry) =>
    requiredEvidence(input.evidence, entry.id),
  );
  const catalog = [...input.processed]
    .filter((claimId) => !claims.some((claim) => claim.claimId === claimId))
    .map((claimId) => requiredEvidence(input.evidence, claimId));
  const built = buildMemoryAspectLinkCandidatesV1({
    scope: input.scope,
    snapshot: input.snapshot,
    observedAt: latestTimestamp(input.batch),
    claims,
    catalog,
    maxNewAspects: input.mode === "enrichment" ? 0 : 4,
    includeRelations: false,
    excludeExistingMemberships: input.mode === "enrichment",
  });
  input.candidateTotals.buildCount += 1;
  input.candidateTotals.promptChars += built.metrics.promptChars;
  input.candidateTotals.maxPromptChars = Math.max(
    input.candidateTotals.maxPromptChars,
    built.metrics.promptChars,
  );
  input.candidateTotals.truncatedAspects += built.metrics.truncatedAspectCount;
  input.candidateTotals.truncatedRepresentatives +=
    built.metrics.truncatedRepresentativeCount;
  input.candidateTotals.truncatedRelations +=
    built.metrics.truncatedRelationTargetCount;
  log("candidate_built", {
    schemaVersion: "paw.amb-aspect-linker-shadow-event.v1",
    sourceGraphRevision: input.snapshot.revision,
    candidateRevision: built.candidateRevision,
    claimCount: claims.length,
    ...built.metrics,
  });
  if (
    input.mode === "enrichment" &&
    built.linkingInput.aspectCandidates.length === 0
  ) {
    return input.snapshot;
  }
  const linking = await input.linker.link(
    built.linkingInput,
    new AbortController().signal,
  );
  if (linking.settlement === "linked") {
    stats.linkedBatches += 1;
    return applyMemoryAspectLinkingV1(input.snapshot, linking);
  }
  stats.deferredBatches += 1;
  return input.snapshot;
}

function createDeepSeekModel(): MemoryWriterModelV1 {
  const apiKey = required(process.env.DEEPSEEK_API_KEY, "DEEPSEEK_API_KEY");
  const model = optional(process.env.DEEPSEEK_MODEL) ?? "deepseek-v4-flash";
  const baseUrl = (
    optional(process.env.DEEPSEEK_BASE_URL) ?? "https://api.deepseek.com"
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
          policy: "paw.amb-aspect-linker-cache.v1",
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
          const cached = objectValue(readJson(cachePath));
          if (typeof cached.text === "string" && cached.text.trim()) {
            stats.localCacheHits += 1;
            logModel({
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
          // Ignore corrupt cache entries and replace them atomically.
        }
      }
      stats.modelCalls += 1;
      const startedAt = performance.now();
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
        if (!response.ok)
          throw namedError(`AspectLinkerModelHttp${response.status}`);
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
          logModel({
            model,
            promptHash,
            cacheHit: false,
            status: "truncated",
            durationMs: Math.max(0, performance.now() - startedAt),
            ...usage,
          });
          return { status: "truncated" as const, errorCode: "OutputLimit" };
        }
        const text = choice?.message?.content;
        if (typeof text !== "string" || !text.trim()) {
          throw namedError("AspectLinkerModelEmptyResponse");
        }
        atomicWriteJson(cachePath, { text });
        logModel({
          model,
          promptHash,
          cacheHit: false,
          status: "completed",
          durationMs: Math.max(0, performance.now() - startedAt),
          ...usage,
        });
        return { status: "completed" as const, text };
      } catch (error) {
        if (options.signal.aborted) {
          return { status: "cancelled" as const, errorCode: "Cancelled" };
        }
        logModel({
          model,
          promptHash,
          cacheHit: false,
          status: "failed",
          durationMs: Math.max(0, performance.now() - startedAt),
          promptTokens: 0,
          completionTokens: 0,
          providerCacheHitTokens: 0,
          providerCacheMissTokens: 0,
          reasonCode: stableReason(error),
        });
        return { status: "failed" as const, errorCode: stableReason(error) };
      }
    },
  });
}

function loadCheckpoint(
  input: Readonly<{ sourceHash: string; goldHash: string }>,
): {
  snapshot: MemoryAspectGraphSnapshotV1;
  processedClaimIds: readonly string[];
  retriedClaimIds: readonly string[];
  enrichedClaimIds: readonly string[];
  recoveredClaimIds: readonly string[];
} | null {
  if (!existsSync(checkpointPath)) return null;
  const value = objectValue(readJson(checkpointPath));
  if (
    value.schemaVersion !== "paw.amb-aspect-linker-shadow-checkpoint.v1" ||
    value.sourceReportHash !== input.sourceHash ||
    value.goldFileHash !== input.goldHash ||
    !Array.isArray(value.processedClaimIds) ||
    !Array.isArray(value.retriedClaimIds)
  ) {
    throw namedError("AspectLinkerCheckpointInvalid");
  }
  const snapshot = value.snapshot as MemoryAspectGraphSnapshotV1;
  measureMemoryAspectGraphV1(snapshot);
  return {
    snapshot,
    processedClaimIds: value.processedClaimIds.map(stringValue),
    retriedClaimIds: value.retriedClaimIds.map(stringValue),
    enrichedClaimIds: Array.isArray(value.enrichedClaimIds)
      ? value.enrichedClaimIds.map(stringValue)
      : [],
    recoveredClaimIds: Array.isArray(value.recoveredClaimIds)
      ? value.recoveredClaimIds.map(stringValue)
      : [],
  };
}

function saveCheckpoint(
  input: Readonly<{
    sourceHash: string;
    goldHash: string;
    snapshot: MemoryAspectGraphSnapshotV1;
    processed: ReadonlySet<string>;
    retried: ReadonlySet<string>;
    enriched: ReadonlySet<string>;
    recovered: ReadonlySet<string>;
  }>,
): void {
  atomicWriteJson(checkpointPath, {
    schemaVersion: "paw.amb-aspect-linker-shadow-checkpoint.v1",
    sourceReportHash: input.sourceHash,
    goldFileHash: input.goldHash,
    processedClaimIds: [...input.processed].sort(),
    retriedClaimIds: [...input.retried].sort(),
    enrichedClaimIds: [...input.enriched].sort(),
    recoveredClaimIds: [...input.recovered].sort(),
    snapshot: input.snapshot,
  });
}

function unassignedClaimIds(snapshot: MemoryAspectGraphSnapshotV1): string[] {
  const assigned = new Set(snapshot.memberships.map((item) => item.claimId));
  return snapshot.claims
    .map((claim) => claim.id)
    .filter((claimId) => !assigned.has(claimId))
    .sort();
}

function latestTimestamp(entries: readonly MemoryEntry[]): string {
  const value = Math.max(
    ...entries.map((entry) => Date.parse(entry.tValid ?? entry.created)),
  );
  return new Date(value).toISOString();
}

function compareEntries(left: MemoryEntry, right: MemoryEntry): number {
  return (
    Date.parse(left.tValid ?? left.created) -
      Date.parse(right.tValid ?? right.created) ||
    left.id.localeCompare(right.id)
  );
}

function requiredEvidence<T>(map: ReadonlyMap<string, T>, id: string): T {
  const value = map.get(id);
  if (value === undefined) throw namedError("AspectLinkerEvidenceMissing");
  return value;
}

function logLinker(event: MemoryAspectLinkerEventV1): void {
  log("linker_settlement", { ...event });
}

function logModel(event: Readonly<Record<string, unknown>>): void {
  log("model_settlement", {
    schemaVersion: "paw.amb-aspect-linker-model-settlement.v1",
    ...event,
  });
}

function addUsage(
  usage: Readonly<{
    promptTokens: number;
    completionTokens: number;
    providerCacheHitTokens: number;
    providerCacheMissTokens: number;
  }>,
): void {
  stats.promptTokens += usage.promptTokens;
  stats.completionTokens += usage.completionTokens;
  stats.providerCacheHitTokens += usage.providerCacheHitTokens;
  stats.providerCacheMissTokens += usage.providerCacheMissTokens;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

function log(event: string, detail: Readonly<Record<string, unknown>>): void {
  appendFileSync(
    logPath,
    `${JSON.stringify({ at: new Date().toISOString(), event, detail })}\n`,
    "utf8",
  );
}

function fileHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function shortHash(value: string): string {
  return sha(value).slice(0, 16);
}

function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw namedError("AspectLinkerObjectInvalid");
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw namedError("AspectLinkerStringInvalid");
  }
  return value;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function required(value: string | undefined, name: string): string {
  const result = optional(value);
  if (result === undefined) throw namedError(`AspectLinkerMissing_${name}`);
  return result;
}

function optional(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result ? result : undefined;
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw namedError(name);
  }
  return parsed;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function f1(precision: number, recall: number): number {
  return precision + recall === 0
    ? 0
    : (2 * precision * recall) / (precision + recall);
}

function stableReason(error: unknown): string {
  return error instanceof Error && error.name ? error.name : "UnknownFailure";
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
