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
  type MemoryFacetShadowSnapshotV2,
  type PawNextMemoryScopeV1,
  evaluateMemoryAspectGraphGoldV1,
  measureMemoryAspectGraphV1,
  migrateMemoryFacetShadowToAspectGraphV1,
  parseMemoryAspectGraphGoldV1,
} from "@paw/memory-plugin";

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
  process.env.PAW_AMB_ASPECT_OUTPUT ??
    "benchmarks/amb/runs/aspect-graph-structure-gate.json",
);
const logPath = resolve(
  process.env.PAW_AMB_ASPECT_LOG ??
    "logs/amb/aspect-graph-structure-gate.jsonl",
);

try {
  const report = objectValue(readJson(facetReportPath));
  const source = report.snapshot as MemoryFacetShadowSnapshotV2;
  const reportScope = objectValue(report.scope);
  const userId = required(
    process.env.PAW_AMB_ASPECT_USER_ID,
    "PAW_AMB_ASPECT_USER_ID",
  );
  if (shortHash(userId) !== stringValue(reportScope.userIdHash)) {
    throw namedError("AspectGraphStructureGateUserScopeMismatch");
  }
  const scope: PawNextMemoryScopeV1 = Object.freeze({
    tenantId: stringValue(reportScope.tenantId),
    userId,
    workspaceId: stringValue(reportScope.workspaceId),
    repositoryId: stringValue(reportScope.repositoryId),
  });
  log("run_started", {
    schemaVersion: "paw.amb-aspect-graph-structure-event.v1",
    sourceReportHash: fileHash(facetReportPath),
    goldFileHash: fileHash(goldPath),
    userIdHash: shortHash(userId),
  });
  const migrated = migrateMemoryFacetShadowToAspectGraphV1({ scope, source });
  const gold = parseMemoryAspectGraphGoldV1(
    readJson(goldPath),
    migrated.snapshot,
  );
  const evaluation = evaluateMemoryAspectGraphGoldV1(migrated.snapshot, gold);
  const metrics = measureMemoryAspectGraphV1(migrated.snapshot);
  const output = Object.freeze({
    schemaVersion: "paw.amb-aspect-graph-structure-gate-report.v1",
    diagnosticOnly: true,
    persistenceWrites: false,
    sourceArm: "facet-v2-migrated-baseline",
    sourceReportHash: fileHash(facetReportPath),
    goldFileHash: fileHash(goldPath),
    annotationSetId: gold.annotationSetId,
    corpusRevision: gold.corpusRevision,
    graphRevision: migrated.snapshot.revision,
    metrics,
    evaluation,
    durationMs: Math.max(0, Date.now() - startedAt),
  });
  atomicWriteJson(outputPath, output);
  log("run_completed", {
    schemaVersion: "paw.amb-aspect-graph-structure-event.v1",
    outputPathHash: shortHash(outputPath),
    claimCount: metrics.claimCount,
    aspectCount: metrics.aspectCount,
    membershipCount: metrics.membershipCount,
    edgeCount: metrics.edgeCount,
    pairCount: evaluation.pairwise.total,
    pairAccuracy: evaluation.pairwise.accuracy,
    edgeAnnotationCount: evaluation.evidenceEdges.total,
    edgeAccuracy: evaluation.evidenceEdges.accuracy,
    currentStateCaseCount: evaluation.currentStateCaseCount,
    currentStateExactMatch: evaluation.currentStateExactMatch,
    durationMs: Math.max(0, Date.now() - startedAt),
  });
} catch (error) {
  log("run_failed", {
    schemaVersion: "paw.amb-aspect-graph-structure-event.v1",
    reasonCode: error instanceof Error ? error.name : "UnknownFailure",
    durationMs: Math.max(0, Date.now() - startedAt),
  });
  throw error;
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

function fileHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw namedError("AspectGraphStructureGateObjectInvalid");
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw namedError("AspectGraphStructureGateStringInvalid");
  }
  return value;
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim())
    throw namedError(`AspectGraphStructureGateMissing_${name}`);
  return value.trim();
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
