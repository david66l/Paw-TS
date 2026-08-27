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
  type MemoryAspectEdgeLinkerEventV1,
  type MemoryAspectEdgeLinkingV1,
  type MemoryAspectGraphSnapshotV1,
  type MemoryFacetShadowSnapshotV2,
  type MemoryWriterModelV1,
  type PawNextMemoryScopeV1,
  buildMemoryAspectEdgeCandidatesV1,
  buildMemoryAspectEdgeRecoveryCandidatesV1,
  createJsonMemoryAspectEdgeLinkerV1,
  createMemoryAspectGraphGoldV1,
  deriveMemoryAspectEdgeInputRevisionV1,
  deriveMemoryAspectLinkStatementHashV1,
  evaluateMemoryAspectEdgeAdmissionV1,
  evaluateMemoryAspectGraphGoldV1,
  measureMemoryAspectGraphV1,
  memoryEntryToFacetObservationV2,
  parseMemoryAspectGraphGoldV1,
  projectMemoryAspectStateLineageV1,
  reconcileMemoryAspectEdgeLinkingsV1,
} from "@paw/memory-plugin";
import type { MemoryEntry } from "@paw/memory/longterm";

const MAX_OUTPUT_TOKENS = 4_096;
const sourcePath = resolve(
  process.env.PAW_AMB_ASPECT_EDGE_SOURCE ??
    "benchmarks/amb/runs/aspect-linker-malia-recovered-v6.json",
);
const facetReportPath = resolve(
  process.env.PAW_AMB_ASPECT_FACET_REPORT ??
    "benchmarks/amb/runs/facet-shadow-malia-full-v5.json",
);
const goldPath = resolve(
  process.env.PAW_AMB_ASPECT_GOLD ??
    "benchmarks/amb/gold/aspect-graph/malia-structure-v1.json",
);
const outputPath = resolve(
  process.env.PAW_AMB_ASPECT_EDGE_OUTPUT ??
    "benchmarks/amb/runs/aspect-edge-linker-malia-adjudication-v6.json",
);
const logPath = resolve(
  process.env.PAW_AMB_ASPECT_EDGE_LOG ??
    "logs/amb/aspect-edge-linker-malia-adjudication-v6.jsonl",
);
const checkpointPath = resolve(
  process.env.PAW_AMB_ASPECT_EDGE_CHECKPOINT ?? `${outputPath}.checkpoint.json`,
);
const cacheDir = resolve(
  process.env.PAW_AMB_ASPECT_EDGE_CACHE_DIR ??
    "benchmarks/amb/runs/.llm-cache-t0/aspect-edge-linker-v1",
);
const stats = {
  modelCalls: 0,
  localCacheHits: 0,
  promptTokens: 0,
  completionTokens: 0,
  providerCacheHitTokens: 0,
  providerCacheMissTokens: 0,
  settledPackets: 0,
  deferredPackets: 0,
  recoveryPackets: 0,
};
const maxTargetsPerPacket = boundedInteger(
  process.env.PAW_AMB_ASPECT_EDGE_MAX_TARGETS,
  5,
  1,
  12,
);

mkdirSync(dirname(outputPath), { recursive: true });
mkdirSync(dirname(logPath), { recursive: true });
mkdirSync(dirname(checkpointPath), { recursive: true });
mkdirSync(cacheDir, { recursive: true });
await main();

async function main(): Promise<void> {
  const startedAt = Date.now();
  const sourceHash = fileHash(sourcePath);
  const facetHash = fileHash(facetReportPath);
  const goldHash = fileHash(goldPath);
  const sourceReport = objectValue(readJson(sourcePath));
  const baseSnapshot = sourceReport.snapshot as MemoryAspectGraphSnapshotV1;
  measureMemoryAspectGraphV1(baseSnapshot);
  const facetReport = objectValue(readJson(facetReportPath));
  const facetSnapshot = facetReport.snapshot as MemoryFacetShadowSnapshotV2;
  const facetScope = objectValue(facetReport.scope);
  const userId = required(
    process.env.PAW_AMB_ASPECT_USER_ID,
    "PAW_AMB_ASPECT_USER_ID",
  );
  if (shortHash(userId) !== stringValue(facetScope.userIdHash)) {
    throw namedError("AspectEdgeShadowUserScopeMismatch");
  }
  const scope: PawNextMemoryScopeV1 = Object.freeze({
    tenantId: stringValue(facetScope.tenantId),
    userId,
    workspaceId: stringValue(facetScope.workspaceId),
    repositoryId: stringValue(facetScope.repositoryId),
  });
  const catalog = facetSnapshot.entries
    .map((entry) => memoryEntryToFacetObservationV2(entry as MemoryEntry))
    .map((observation) =>
      Object.freeze({
        claimId: observation.id,
        statement: observation.statement,
        statementHash: deriveMemoryAspectLinkStatementHashV1(
          observation.statement,
        ),
      }),
    );
  const observedAt = latestGraphTime(baseSnapshot);
  const build = buildMemoryAspectEdgeCandidatesV1({
    scope,
    snapshot: baseSnapshot,
    observedAt,
    catalog,
    maxTargetsPerPacket,
  });
  const checkpoint = loadCheckpoint({
    sourceHash,
    facetHash,
    goldHash,
    candidateRevision: build.candidateRevision,
  });
  const linkings = new Map(
    (checkpoint?.linkings ?? []).map((linking) => [
      linking.edgeInputRevision,
      linking,
    ]),
  );
  const recoveryLinkings = new Map(
    (checkpoint?.recoveryLinkings ?? []).map((linking) => [
      linking.edgeInputRevision,
      linking,
    ]),
  );
  if (checkpoint !== null) Object.assign(stats, checkpoint.stats);
  const model = createDeepSeekModel();
  const linker = createJsonMemoryAspectEdgeLinkerV1({
    model,
    onEvent: logLinker,
  });
  const adjudicator = createJsonMemoryAspectEdgeLinkerV1({
    model,
    onEvent: logLinker,
    promptMode: "relation_adjudication",
  });
  log("run_started", {
    schemaVersion: "paw.amb-aspect-edge-shadow-event.v1",
    sourceReportHash: sourceHash,
    facetReportHash: facetHash,
    goldFileHash: goldHash,
    sourceGraphRevision: baseSnapshot.revision,
    candidateRevision: build.candidateRevision,
    packetCount: build.packets.length,
    resumed: checkpoint !== null,
    completedPacketCount: linkings.size,
  });
  for (const packet of build.packets) {
    const edgeInputRevision = deriveMemoryAspectEdgeInputRevisionV1(packet);
    if (linkings.has(edgeInputRevision)) continue;
    const linking = await linker.link(packet, new AbortController().signal);
    linkings.set(linking.edgeInputRevision, linking);
    if (linking.settlement === "settled") stats.settledPackets += 1;
    else stats.deferredPackets += 1;
    saveCheckpoint({
      sourceHash,
      facetHash,
      goldHash,
      candidateRevision: build.candidateRevision,
      linkings: [...linkings.values()],
      recoveryLinkings: [...recoveryLinkings.values()],
    });
  }
  const recovery = buildMemoryAspectEdgeRecoveryCandidatesV1({
    packets: build.packets,
    linkings: [...linkings.values()],
    maxPackets: 32,
  });
  if (
    checkpoint?.recoveryRevision !== undefined &&
    checkpoint.recoveryRevision !== recovery.recoveryRevision
  ) {
    throw namedError("AspectEdgeShadowRecoveryCheckpointInvalid");
  }
  for (const packet of recovery.packets) {
    const edgeInputRevision = deriveMemoryAspectEdgeInputRevisionV1(packet);
    if (recoveryLinkings.has(edgeInputRevision)) continue;
    const linking = await adjudicator.link(
      packet,
      new AbortController().signal,
    );
    recoveryLinkings.set(linking.edgeInputRevision, linking);
    stats.recoveryPackets += 1;
    if (linking.settlement === "settled") stats.settledPackets += 1;
    else stats.deferredPackets += 1;
    saveCheckpoint({
      sourceHash,
      facetHash,
      goldHash,
      candidateRevision: build.candidateRevision,
      linkings: [...linkings.values()],
      recoveryLinkings: [...recoveryLinkings.values()],
      recoveryRevision: recovery.recoveryRevision,
    });
  }
  const allLinkings = [...linkings.values(), ...recoveryLinkings.values()];
  const primaryEdgeIds = new Set(
    [...linkings.values()].flatMap((linking) =>
      linking.edges.map((edge) => edge.id),
    ),
  );
  const recoveryEdgeIds = new Set(
    [...recoveryLinkings.values()].flatMap((linking) =>
      linking.edges.map((edge) => edge.id),
    ),
  );
  const proposedEdges = [
    ...new Map(
      allLinkings
        .flatMap((linking) => linking.edges)
        .map((edge) => [edge.id, edge]),
    ).values(),
  ];
  const admission = evaluateMemoryAspectEdgeAdmissionV1({
    snapshot: baseSnapshot,
    edges: proposedEdges,
    catalog,
  });
  const recoveryPacketByRevision = new Map(
    recovery.packets.map((packet) => [
      deriveMemoryAspectEdgeInputRevisionV1(packet),
      packet,
    ]),
  );
  const adjudicatedPairKeys = new Set<string>();
  for (const linking of recoveryLinkings.values()) {
    if (linking.settlement !== "settled") continue;
    const packet = recoveryPacketByRevision.get(linking.edgeInputRevision);
    if (packet === undefined) continue;
    for (const decision of linking.decisions) {
      if (decision.disposition === "defer") continue;
      adjudicatedPairKeys.add(
        unorderedPairKey(packet.source.claimId, decision.targetClaimId),
      );
    }
  }
  const suppressedPrimaryEdgeIds = new Set(
    [...linkings.values()]
      .flatMap((linking) => linking.edges)
      .filter(
        (edge) =>
          !recoveryEdgeIds.has(edge.id) &&
          adjudicatedPairKeys.has(
            unorderedPairKey(edge.fromClaimId, edge.toClaimId),
          ),
      )
      .map((edge) => edge.id),
  );
  const admittedEdgeIds = admission.admittedEdgeIds.filter(
    (edgeId) => !suppressedPrimaryEdgeIds.has(edgeId),
  );
  const reconciliationLinkings = [
    ...linkings.values(),
    ...[...recoveryLinkings.values()].filter(
      (linking) =>
        linking.edges.length === 0 ||
        linking.edges.some((edge) => !primaryEdgeIds.has(edge.id)),
    ),
  ];
  const reconciliation = reconcileMemoryAspectEdgeLinkingsV1(
    baseSnapshot,
    reconciliationLinkings,
    { admittedEdgeIds },
  );
  const snapshot = reconciliation.snapshot;
  const gold = parseMemoryAspectGraphGoldV1(readJson(goldPath), snapshot);
  const relationGold = createMemoryAspectGraphGoldV1({
    snapshot,
    annotationSetId: `${gold.annotationSetId}:edge-shadow`,
    pairs: gold.pairs,
    edges: gold.edges,
  });
  const evaluation = evaluateMemoryAspectGraphGoldV1(snapshot, relationGold);
  const lineageCurrent = evaluateLineageCurrent(snapshot, gold.currentStates);
  const output = Object.freeze({
    schemaVersion: "paw.amb-aspect-edge-shadow-report.v1",
    diagnosticOnly: true,
    persistenceWrites: false,
    sourceArm: "aspect-linker-recovered-v6-independent-edge-linker-v1",
    sourceReportHash: sourceHash,
    facetReportHash: facetHash,
    goldFileHash: goldHash,
    annotationSetId: gold.annotationSetId,
    sourceGraphRevision: baseSnapshot.revision,
    graphRevision: snapshot.revision,
    candidateRevision: build.candidateRevision,
    maxTargetsPerPacket,
    recovery: {
      recoveryRevision: recovery.recoveryRevision,
      ...recovery.metrics,
    },
    stats,
    candidateMetrics: build.metrics,
    reconciliation: {
      reconciliationRevision: reconciliation.reconciliationRevision,
      acceptedCount: reconciliation.acceptedLinkingRevisions.length,
      rejected: reconciliation.rejected,
    },
    admission: {
      policyVersion: admission.policyVersion,
      admissionRevision: admission.admissionRevision,
      proposedCount: proposedEdges.length,
      admittedCount: admission.admittedEdgeIds.length,
      rejectedCount: admission.rejectedEdgeIds.length,
      deferredCount: admission.deferredEdgeIds.length,
      reasonCounts: countReasons(admission.decisions),
    },
    adjudication: {
      adjudicatedPairCount: adjudicatedPairKeys.size,
      suppressedPrimaryEdgeCount: suppressedPrimaryEdgeIds.size,
      committedEdgeCount: admittedEdgeIds.length,
    },
    metrics: measureMemoryAspectGraphV1(snapshot),
    evaluation: {
      pairwise: evaluation.pairwise,
      evidenceEdges: evaluation.evidenceEdges,
      lineageCurrent,
    },
    durationMs: Math.max(0, Date.now() - startedAt),
    snapshot,
  });
  atomicWriteJson(outputPath, output);
  log("run_completed", {
    schemaVersion: "paw.amb-aspect-edge-shadow-event.v1",
    sourceGraphRevision: baseSnapshot.revision,
    graphRevision: snapshot.revision,
    edgeCount: output.metrics.edgeCount,
    pairAccuracy: evaluation.pairwise.accuracy,
    edgeAccuracy: evaluation.evidenceEdges.accuracy,
    edgePrecision: evaluation.evidenceEdges.precision,
    edgeRecall: evaluation.evidenceEdges.recall,
    lineageCurrentExactMatch: lineageCurrent.exactMatch,
    lineageCurrentAmbiguousCaseCount: lineageCurrent.ambiguousCaseCount,
    stats,
    outputPathHash: shortHash(outputPath),
    durationMs: output.durationMs,
  });
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
          policy: "paw.amb-aspect-edge-linker-cache.v1",
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
          // A corrupt cache entry is replaced by a validated provider result.
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
          throw namedError(`AspectEdgeModelHttp${response.status}`);
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
        const text = choice?.message?.content?.trim() ?? "";
        const usage = {
          promptTokens: payload.usage?.prompt_tokens ?? 0,
          completionTokens: payload.usage?.completion_tokens ?? 0,
          providerCacheHitTokens: payload.usage?.prompt_cache_hit_tokens ?? 0,
          providerCacheMissTokens: payload.usage?.prompt_cache_miss_tokens ?? 0,
        };
        addUsage(usage);
        const status =
          choice?.finish_reason === "length"
            ? ("truncated" as const)
            : text
              ? ("completed" as const)
              : ("failed" as const);
        logModel({
          model,
          promptHash,
          cacheHit: false,
          status,
          durationMs: Math.max(0, performance.now() - startedAt),
          ...usage,
        });
        if (status !== "completed") {
          return {
            status,
            errorCode: `Finish_${choice?.finish_reason ?? "empty"}`,
          };
        }
        atomicWriteJson(cachePath, {
          schemaVersion: "paw.amb-aspect-edge-linker-cache-entry.v1",
          model,
          promptHash,
          text,
        });
        return { status: "completed" as const, text };
      } catch (error) {
        if (options.signal.aborted) {
          return { status: "cancelled" as const, errorCode: "AbortError" };
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

function evaluateLineageCurrent(
  snapshot: MemoryAspectGraphSnapshotV1,
  currentStates: readonly Readonly<{
    anchorClaimIds: readonly string[];
    asOf: string;
    currentClaimIds: readonly string[];
  }>[],
) {
  let exactCount = 0;
  let ambiguousCaseCount = 0;
  const cases = currentStates.map((item) => {
    try {
      const projection = projectMemoryAspectStateLineageV1({
        snapshot,
        anchorClaimIds: item.anchorClaimIds,
        asOf: new Date(item.asOf).toISOString(),
      });
      const actual = [...projection.currentClaimIds].sort();
      const expected = [...item.currentClaimIds].sort();
      const exact = sameStrings(actual, expected);
      if (exact) exactCount += 1;
      return { status: "evaluated" as const, exact, actual, expected };
    } catch (error) {
      ambiguousCaseCount += 1;
      return {
        status: "ambiguous" as const,
        exact: false,
        expected: [...item.currentClaimIds].sort(),
        reasonCode: stableReason(error),
      };
    }
  });
  return Object.freeze({
    caseCount: currentStates.length,
    evaluatedCaseCount: currentStates.length - ambiguousCaseCount,
    ambiguousCaseCount,
    exactCount,
    exactMatch: ratio(exactCount, currentStates.length),
    cases,
  });
}

function loadCheckpoint(input: {
  sourceHash: string;
  facetHash: string;
  goldHash: string;
  candidateRevision: string;
}): {
  linkings: readonly MemoryAspectEdgeLinkingV1[];
  recoveryLinkings: readonly MemoryAspectEdgeLinkingV1[];
  recoveryRevision?: string;
  stats: typeof stats;
} | null {
  if (!existsSync(checkpointPath)) return null;
  const value = objectValue(readJson(checkpointPath));
  if (
    value.schemaVersion !== "paw.amb-aspect-edge-shadow-checkpoint.v1" ||
    value.sourceReportHash !== input.sourceHash ||
    value.facetReportHash !== input.facetHash ||
    value.goldFileHash !== input.goldHash ||
    value.candidateRevision !== input.candidateRevision ||
    !Array.isArray(value.linkings)
  ) {
    throw namedError("AspectEdgeShadowCheckpointInvalid");
  }
  return {
    linkings: value.linkings as MemoryAspectEdgeLinkingV1[],
    recoveryLinkings: Array.isArray(value.recoveryLinkings)
      ? (value.recoveryLinkings as MemoryAspectEdgeLinkingV1[])
      : [],
    recoveryRevision:
      typeof value.recoveryRevision === "string"
        ? value.recoveryRevision
        : undefined,
    stats: { ...stats, ...objectValue(value.stats) } as typeof stats,
  };
}

function saveCheckpoint(input: {
  sourceHash: string;
  facetHash: string;
  goldHash: string;
  candidateRevision: string;
  linkings: readonly MemoryAspectEdgeLinkingV1[];
  recoveryLinkings: readonly MemoryAspectEdgeLinkingV1[];
  recoveryRevision?: string;
}): void {
  atomicWriteJson(checkpointPath, {
    schemaVersion: "paw.amb-aspect-edge-shadow-checkpoint.v1",
    sourceReportHash: input.sourceHash,
    facetReportHash: input.facetHash,
    goldFileHash: input.goldHash,
    candidateRevision: input.candidateRevision,
    stats,
    linkings: input.linkings,
    recoveryLinkings: input.recoveryLinkings,
    recoveryRevision: input.recoveryRevision ?? null,
  });
}

function logLinker(event: MemoryAspectEdgeLinkerEventV1): void {
  log("linker_settlement", { ...event });
}

function countReasons(
  decisions: readonly Readonly<{ reasonCode: string }>[],
): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const decision of decisions) {
    counts[decision.reasonCode] = (counts[decision.reasonCode] ?? 0) + 1;
  }
  return Object.freeze(counts);
}

function logModel(event: Readonly<Record<string, unknown>>): void {
  log("model_settlement", {
    schemaVersion: "paw.amb-aspect-edge-model-settlement.v1",
    ...event,
  });
}

function addUsage(usage: {
  promptTokens: number;
  completionTokens: number;
  providerCacheHitTokens: number;
  providerCacheMissTokens: number;
}): void {
  stats.promptTokens += usage.promptTokens;
  stats.completionTokens += usage.completionTokens;
  stats.providerCacheHitTokens += usage.providerCacheHitTokens;
  stats.providerCacheMissTokens += usage.providerCacheMissTokens;
}

function latestGraphTime(snapshot: MemoryAspectGraphSnapshotV1): string {
  const values = [
    ...snapshot.claims.flatMap((claim) => [claim.validFrom, claim.ingestedAt]),
    ...snapshot.memberships.map((membership) => membership.createdAt),
  ];
  return new Date(
    Math.max(...values.map((value) => Date.parse(value))),
  ).toISOString();
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
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

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function unorderedPairKey(left: string, right: string): string {
  return left.localeCompare(right) <= 0
    ? `${left}\u0000${right}`
    : `${right}\u0000${left}`;
}

function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw namedError("AspectEdgeShadowObjectInvalid");
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw namedError("AspectEdgeShadowStringInvalid");
  }
  return value;
}

function optional(value: string | undefined): string | null {
  return value?.trim() || null;
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || !value.trim()) throw namedError(`${name}Missing`);
  return value.trim();
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw namedError("AspectEdgeShadowIntegerInvalid");
  }
  return parsed;
}

function stableReason(error: unknown): string {
  return error instanceof Error && error.name
    ? error.name
    : "AspectEdgeShadowUnknownFailure";
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
