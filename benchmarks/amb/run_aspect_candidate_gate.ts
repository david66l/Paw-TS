import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

import {
  type MemoryAspectGraphSnapshotV1,
  type MemoryFacetShadowSnapshotV2,
  type PawNextMemoryScopeV1,
  buildMemoryAspectLinkCandidatesV1,
  deriveMemoryAspectLinkStatementHashV1,
  memoryEntryToFacetObservationV2,
  migrateMemoryFacetShadowToAspectGraphV1,
  parseMemoryAspectGraphGoldV1,
  resolveMemoryAspectIdsV1,
} from "@paw/memory-plugin";
import type { MemoryEntry } from "@paw/memory/longterm";

const startedAt = Date.now();
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
  process.env.PAW_AMB_ASPECT_CANDIDATE_OUTPUT ??
    "benchmarks/amb/runs/aspect-candidate-gate.json",
);
const logPath = resolve(
  process.env.PAW_AMB_ASPECT_CANDIDATE_LOG ??
    "logs/amb/aspect-candidate-gate.jsonl",
);
const observedAt = "2030-01-01T00:00:00.000Z";

try {
  const report = objectValue(readJson(facetReportPath));
  const source = report.snapshot as MemoryFacetShadowSnapshotV2;
  const reportScope = objectValue(report.scope);
  const userId = required(
    process.env.PAW_AMB_ASPECT_USER_ID,
    "PAW_AMB_ASPECT_USER_ID",
  );
  if (shortHash(userId) !== stringValue(reportScope.userIdHash)) {
    throw namedError("AspectCandidateGateUserScopeMismatch");
  }
  const scope: PawNextMemoryScopeV1 = Object.freeze({
    tenantId: stringValue(reportScope.tenantId),
    userId,
    workspaceId: stringValue(reportScope.workspaceId),
    repositoryId: stringValue(reportScope.repositoryId),
  });
  log("run_started", {
    schemaVersion: "paw.amb-aspect-candidate-gate-event.v1",
    sourceReportHash: fileHash(facetReportPath),
    goldFileHash: fileHash(goldPath),
    userIdHash: shortHash(userId),
  });
  const migrated = migrateMemoryFacetShadowToAspectGraphV1({ scope, source });
  const gold = parseMemoryAspectGraphGoldV1(
    readJson(goldPath),
    migrated.snapshot,
  );
  const evidence = new Map(
    source.entries.map((entry) => {
      const observation = memoryEntryToFacetObservationV2(entry as MemoryEntry);
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
  const aggregate = createAggregate();
  for (const pair of gold.pairs) {
    probePair(
      migrated.snapshot,
      scope,
      evidence,
      pair.leftClaimId,
      pair.rightClaimId,
      pair.sameAspect,
      aggregate,
    );
    probePair(
      migrated.snapshot,
      scope,
      evidence,
      pair.rightClaimId,
      pair.leftClaimId,
      pair.sameAspect,
      aggregate,
    );
  }
  for (const edge of gold.edges.filter((item) => item.present)) {
    const build = buildForClaim(
      migrated.snapshot,
      scope,
      evidence,
      edge.fromClaimId,
    );
    aggregate.edgeProbeCount += 1;
    const targetAspects = activeAspectIdsForClaim(
      migrated.snapshot,
      edge.toClaimId,
    );
    if (
      build.linkingInput.aspectCandidates.some((candidate) =>
        targetAspects.has(candidate.aspectId),
      )
    ) {
      aggregate.edgeAspectHitCount += 1;
    }
    if (
      build.linkingInput.aspectCandidates.some((candidate) =>
        candidate.representatives.some(
          (representative) => representative.claimId === edge.toClaimId,
        ),
      )
    ) {
      aggregate.edgeRepresentativeHitCount += 1;
    }
    if (
      build.linkingInput.relationCandidates[0]?.targetClaimIds.includes(
        edge.toClaimId,
      )
    ) {
      aggregate.edgeTargetHitCount += 1;
    }
    collectBuildMetrics(build.metrics, aggregate);
  }
  const output = Object.freeze({
    schemaVersion: "paw.amb-aspect-candidate-gate-report.v1",
    diagnosticOnly: true,
    persistenceWrites: false,
    modelCalls: 0,
    sourceReportHash: fileHash(facetReportPath),
    goldFileHash: fileHash(goldPath),
    annotationSetId: gold.annotationSetId,
    corpusRevision: gold.corpusRevision,
    graphRevision: migrated.snapshot.revision,
    pairDirectionCount: aggregate.pairDirectionCount,
    positivePairDirectionCount: aggregate.positivePairDirectionCount,
    positiveAspectHitCount: aggregate.positiveAspectHitCount,
    positiveAspectRecall: ratio(
      aggregate.positiveAspectHitCount,
      aggregate.positivePairDirectionCount,
    ),
    negativePairDirectionCount: aggregate.negativePairDirectionCount,
    negativeAspectExposureCount: aggregate.negativeAspectExposureCount,
    negativeAspectExposureRate: ratio(
      aggregate.negativeAspectExposureCount,
      aggregate.negativePairDirectionCount,
    ),
    edgeProbeCount: aggregate.edgeProbeCount,
    edgeAspectHitCount: aggregate.edgeAspectHitCount,
    edgeAspectRecall: ratio(
      aggregate.edgeAspectHitCount,
      aggregate.edgeProbeCount,
    ),
    edgeRepresentativeHitCount: aggregate.edgeRepresentativeHitCount,
    edgeRepresentativeRecall: ratio(
      aggregate.edgeRepresentativeHitCount,
      aggregate.edgeProbeCount,
    ),
    edgeTargetHitCount: aggregate.edgeTargetHitCount,
    edgeTargetRecall: ratio(
      aggregate.edgeTargetHitCount,
      aggregate.edgeProbeCount,
    ),
    buildCount: aggregate.buildCount,
    averagePromptChars: ratio(aggregate.totalPromptChars, aggregate.buildCount),
    maxPromptChars: aggregate.maxPromptChars,
    truncatedAspectCount: aggregate.truncatedAspectCount,
    truncatedRepresentativeCount: aggregate.truncatedRepresentativeCount,
    truncatedRelationTargetCount: aggregate.truncatedRelationTargetCount,
    durationMs: Math.max(0, Date.now() - startedAt),
  });
  atomicWriteJson(outputPath, output);
  log("run_completed", {
    schemaVersion: "paw.amb-aspect-candidate-gate-event.v1",
    outputPathHash: shortHash(outputPath),
    positivePairDirectionCount: output.positivePairDirectionCount,
    positiveAspectHitCount: output.positiveAspectHitCount,
    edgeProbeCount: output.edgeProbeCount,
    edgeAspectHitCount: output.edgeAspectHitCount,
    edgeRepresentativeHitCount: output.edgeRepresentativeHitCount,
    edgeTargetHitCount: output.edgeTargetHitCount,
    buildCount: output.buildCount,
    maxPromptChars: output.maxPromptChars,
    truncatedAspectCount: output.truncatedAspectCount,
    truncatedRepresentativeCount: output.truncatedRepresentativeCount,
    truncatedRelationTargetCount: output.truncatedRelationTargetCount,
    durationMs: output.durationMs,
  });
} catch (error) {
  log("run_failed", {
    schemaVersion: "paw.amb-aspect-candidate-gate-event.v1",
    reasonCode: error instanceof Error ? error.name : "UnknownFailure",
    durationMs: Math.max(0, Date.now() - startedAt),
  });
  throw error;
}

interface Aggregate {
  pairDirectionCount: number;
  positivePairDirectionCount: number;
  positiveAspectHitCount: number;
  negativePairDirectionCount: number;
  negativeAspectExposureCount: number;
  edgeProbeCount: number;
  edgeAspectHitCount: number;
  edgeRepresentativeHitCount: number;
  edgeTargetHitCount: number;
  buildCount: number;
  totalPromptChars: number;
  maxPromptChars: number;
  truncatedAspectCount: number;
  truncatedRepresentativeCount: number;
  truncatedRelationTargetCount: number;
}

function createAggregate(): Aggregate {
  return {
    pairDirectionCount: 0,
    positivePairDirectionCount: 0,
    positiveAspectHitCount: 0,
    negativePairDirectionCount: 0,
    negativeAspectExposureCount: 0,
    edgeProbeCount: 0,
    edgeAspectHitCount: 0,
    edgeRepresentativeHitCount: 0,
    edgeTargetHitCount: 0,
    buildCount: 0,
    totalPromptChars: 0,
    maxPromptChars: 0,
    truncatedAspectCount: 0,
    truncatedRepresentativeCount: 0,
    truncatedRelationTargetCount: 0,
  };
}

function probePair(
  snapshot: MemoryAspectGraphSnapshotV1,
  scope: PawNextMemoryScopeV1,
  evidence: ReadonlyMap<
    string,
    Readonly<{ claimId: string; statement: string; statementHash: string }>
  >,
  queryClaimId: string,
  targetClaimId: string,
  sameAspect: boolean,
  aggregate: Aggregate,
): void {
  const build = buildForClaim(snapshot, scope, evidence, queryClaimId);
  const targetAspects = activeAspectIdsForClaim(snapshot, targetClaimId);
  const selected = new Set(
    build.linkingInput.aspectCandidates.map((item) => item.aspectId),
  );
  const exposed = [...targetAspects].some((aspectId) => selected.has(aspectId));
  aggregate.pairDirectionCount += 1;
  if (sameAspect) {
    aggregate.positivePairDirectionCount += 1;
    if (exposed) aggregate.positiveAspectHitCount += 1;
  } else {
    aggregate.negativePairDirectionCount += 1;
    if (exposed) aggregate.negativeAspectExposureCount += 1;
  }
  collectBuildMetrics(build.metrics, aggregate);
}

function buildForClaim(
  snapshot: MemoryAspectGraphSnapshotV1,
  scope: PawNextMemoryScopeV1,
  evidence: ReadonlyMap<
    string,
    Readonly<{ claimId: string; statement: string; statementHash: string }>
  >,
  claimId: string,
) {
  const claim = evidence.get(claimId);
  if (claim === undefined)
    throw namedError("AspectCandidateGateEvidenceMissing");
  return buildMemoryAspectLinkCandidatesV1({
    scope,
    snapshot,
    observedAt,
    claims: [claim],
    catalog: [...evidence.values()].filter((item) => item.claimId !== claimId),
    maxNewAspects: 1,
  });
}

function activeAspectIdsForClaim(
  snapshot: MemoryAspectGraphSnapshotV1,
  claimId: string,
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const membership of snapshot.memberships) {
    if (membership.claimId !== claimId) continue;
    for (const aspectId of resolveMemoryAspectIdsV1(
      snapshot,
      membership.aspectId,
    )) {
      ids.add(aspectId);
    }
  }
  return ids;
}

function collectBuildMetrics(
  metrics: Readonly<{
    promptChars: number;
    truncatedAspectCount: number;
    truncatedRepresentativeCount: number;
    truncatedRelationTargetCount: number;
  }>,
  aggregate: Aggregate,
): void {
  aggregate.buildCount += 1;
  aggregate.totalPromptChars += metrics.promptChars;
  aggregate.maxPromptChars = Math.max(
    aggregate.maxPromptChars,
    metrics.promptChars,
  );
  aggregate.truncatedAspectCount += metrics.truncatedAspectCount;
  aggregate.truncatedRepresentativeCount +=
    metrics.truncatedRepresentativeCount;
  aggregate.truncatedRelationTargetCount +=
    metrics.truncatedRelationTargetCount;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

function log(event: string, detail: Readonly<Record<string, unknown>>): void {
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(
    logPath,
    `${JSON.stringify({ at: new Date().toISOString(), event, detail })}\n`,
    "utf8",
  );
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function fileHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw namedError("AspectCandidateGateObjectInvalid");
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw namedError("AspectCandidateGateStringInvalid");
  }
  return value;
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw namedError(`AspectCandidateGateMissing_${name}`);
  return value.trim();
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
