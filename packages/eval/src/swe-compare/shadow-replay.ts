import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  type LoopV2ShadowArtifactPolicyV1,
  type LoopV2ShadowArtifactV1,
  type LoopV2ShadowAssessmentV1,
  type LoopV2ShadowReport,
  buildLoopV2ShadowArtifactV1,
  parseLoopV2ShadowArtifactV1,
  replayLegacyTraceToLoopV2ShadowV1,
  sha256Canonical,
} from "@paw/agent";

import { writeJsonAtomic } from "../swe-exp/checkpoint.js";

export const LOOP_V2_SHADOW_SUMMARY_SCHEMA_VERSION = 1 as const;

export interface LoopV2ShadowReplayEntryV1 {
  readonly runId: string;
  readonly tracePath: string;
  readonly traceSha256: string;
  readonly artifactPath: string;
  readonly artifactHash: string;
  readonly legacyTerminal: LoopV2ShadowAssessmentV1["legacyTerminal"];
  readonly coverage: LoopV2ShadowAssessmentV1["coverage"];
  readonly facts: LoopV2ShadowAssessmentV1["facts"];
  readonly artifactStatus: LoopV2ShadowAssessmentV1["artifact"]["status"];
  readonly readinessDisposition?: NonNullable<
    LoopV2ShadowAssessmentV1["readiness"]
  >["disposition"];
  readonly comparison: LoopV2ShadowAssessmentV1["comparison"];
  readonly v2Outcome: LoopV2ShadowAssessmentV1["v2Outcome"];
}

export interface LoopV2ShadowReplaySummaryV1 {
  readonly schemaVersion: typeof LOOP_V2_SHADOW_SUMMARY_SCHEMA_VERSION;
  readonly kind: "paw.loop-v2-shadow-summary";
  readonly policy: LoopV2ShadowArtifactPolicyV1;
  readonly runs: readonly LoopV2ShadowReplayEntryV1[];
  readonly totals: {
    readonly runs: number;
    readonly observed: number;
    readonly projected: number;
    readonly gaps: number;
    readonly ignored: number;
    readonly validArtifacts: number;
    readonly readyForReview: number;
  };
  readonly summaryHash: string;
}

export interface ReplayPawShadowTracesOptions {
  readonly repoRoot: string;
  readonly tracePaths: readonly string[];
  /** Basename only; written below benchmarks/swe-compare/shadow-reports. */
  readonly summaryName: string;
  readonly policy?: Parameters<typeof buildLoopV2ShadowArtifactV1>[1];
}

export interface PersistOnlineLoopV2ShadowOptions {
  readonly repoRoot: string;
  readonly runId: string;
  readonly report: LoopV2ShadowReport;
  readonly policy?: Parameters<typeof buildLoopV2ShadowArtifactV1>[1];
}

/**
 * Persists one report captured by the live orchestrator and proves that the
 * exact on-disk bytes still satisfy the strict artifact contract.
 */
export function persistOnlineLoopV2ShadowArtifact(
  options: PersistOnlineLoopV2ShadowOptions,
): Readonly<{
  artifactPath: string;
  artifact: LoopV2ShadowArtifactV1;
}> {
  const repoRoot = path.resolve(options.repoRoot);
  const runsRoot = path.join(repoRoot, "benchmarks", "swe-compare", "runs");
  if (
    !options.runId.trim() ||
    path.basename(options.runId) !== options.runId ||
    !options.runId.startsWith("paw-") ||
    options.runId.startsWith("paw-claude-")
  ) {
    throw new Error(`Invalid online Paw shadow run id: ${options.runId}`);
  }
  if (options.report.runId !== options.runId) {
    throw new Error(
      `Online Paw shadow report run mismatch: ${options.report.runId}`,
    );
  }
  const runDir = path.join(runsRoot, options.runId);
  assertWithin(runDir, runsRoot, "run output");
  const artifactPath = path.join(runDir, "loop-v2-shadow-v1.json");
  const artifact = buildLoopV2ShadowArtifactV1(options.report, options.policy);
  writeJsonAtomic(artifactPath, artifact);
  const persisted = parseLoopV2ShadowArtifactV1(
    readFileSync(artifactPath, "utf8"),
  );
  return {
    artifactPath: relativePortable(repoRoot, artifactPath),
    artifact: persisted,
  };
}

/**
 * Offline only: validates every input and builds every artifact before the
 * first write, then atomically replaces only the declared output files.
 */
export function replayPawShadowTraces(
  options: ReplayPawShadowTracesOptions,
): Readonly<{
  summaryPath: string;
  summary: LoopV2ShadowReplaySummaryV1;
}> {
  const repoRoot = path.resolve(options.repoRoot);
  const runsRoot = path.join(repoRoot, "benchmarks", "swe-compare", "runs");
  const reportsRoot = path.join(
    repoRoot,
    "benchmarks",
    "swe-compare",
    "shadow-reports",
  );
  if (
    !options.summaryName.trim() ||
    path.basename(options.summaryName) !== options.summaryName ||
    !options.summaryName.endsWith(".json")
  ) {
    throw new Error("Loop v2 shadow summaryName must be a JSON basename");
  }
  if (options.tracePaths.length === 0) {
    throw new Error("At least one Paw trace path is required");
  }

  const prepared = options.tracePaths.map((inputPath) => {
    const tracePath = path.resolve(repoRoot, inputPath);
    assertWithin(tracePath, runsRoot, "trace");
    if (path.basename(tracePath) !== "trace.json") {
      throw new Error(`Loop v2 shadow input must be trace.json: ${tracePath}`);
    }
    const runDir = path.dirname(tracePath);
    const runId = path.basename(runDir);
    if (!runId.startsWith("paw-") || runId.startsWith("paw-claude-")) {
      throw new Error(`Loop v2 shadow input is not a Paw run: ${runId}`);
    }
    const raw = readFileSync(tracePath);
    let trace: unknown;
    try {
      trace = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new Error(`Loop v2 shadow trace is not valid JSON: ${tracePath}`);
    }
    if (!Array.isArray(trace)) {
      throw new Error(
        `Loop v2 shadow trace must be an event array: ${tracePath}`,
      );
    }
    const report = replayLegacyTraceToLoopV2ShadowV1(runId, trace);
    const artifact = buildLoopV2ShadowArtifactV1(report, options.policy);
    const artifactPath = path.join(runDir, "loop-v2-shadow-v1.json");
    if (artifactPath === tracePath) {
      throw new Error("Loop v2 shadow output cannot overwrite its input trace");
    }
    return {
      runId,
      tracePath,
      traceSha256: sha256(raw),
      artifactPath,
      artifact,
    };
  });
  const seenRunIds = new Set<string>();
  for (const item of prepared) {
    if (seenRunIds.has(item.runId)) {
      throw new Error(`Duplicate loop v2 shadow run: ${item.runId}`);
    }
    seenRunIds.add(item.runId);
  }

  const runs = prepared
    .map((item): LoopV2ShadowReplayEntryV1 => {
      const assessment = item.artifact.assessment;
      return {
        runId: item.runId,
        tracePath: relativePortable(repoRoot, item.tracePath),
        traceSha256: item.traceSha256,
        artifactPath: relativePortable(repoRoot, item.artifactPath),
        artifactHash: item.artifact.artifactHash,
        legacyTerminal: assessment.legacyTerminal,
        coverage: assessment.coverage,
        facts: assessment.facts,
        artifactStatus: assessment.artifact.status,
        ...(assessment.readiness
          ? { readinessDisposition: assessment.readiness.disposition }
          : {}),
        comparison: assessment.comparison,
        v2Outcome: assessment.v2Outcome,
      };
    })
    .sort((left, right) => left.runId.localeCompare(right.runId));
  const totals = {
    runs: runs.length,
    observed: sum(runs, (entry) => entry.coverage.observed),
    projected: sum(runs, (entry) => entry.coverage.projected),
    gaps: sum(runs, (entry) => entry.coverage.gaps),
    ignored: sum(runs, (entry) => entry.coverage.ignored),
    validArtifacts: runs.filter((entry) => entry.artifactStatus === "valid")
      .length,
    readyForReview: runs.filter(
      (entry) => entry.readinessDisposition === "ready_for_review",
    ).length,
  };
  const summaryWithoutHash = {
    schemaVersion: LOOP_V2_SHADOW_SUMMARY_SCHEMA_VERSION,
    kind: "paw.loop-v2-shadow-summary" as const,
    policy: prepared[0]?.artifact.policy ?? {
      requireProductMutation: true,
      verificationAuthority: "local" as const,
      requiredVerificationScopes: [],
    },
    runs,
    totals,
  };
  const summary: LoopV2ShadowReplaySummaryV1 = {
    ...summaryWithoutHash,
    summaryHash: sha256Canonical(summaryWithoutHash),
  };
  const summaryPath = path.join(reportsRoot, options.summaryName);
  for (const item of prepared) {
    writeJsonAtomic(item.artifactPath, item.artifact);
    // Read through the strict parser so disk encoding cannot silently drift.
    parseLoopV2ShadowArtifactV1(readFileSync(item.artifactPath, "utf8"));
  }
  writeJsonAtomic(summaryPath, summary);
  return { summaryPath, summary };
}

function assertWithin(target: string, root: string, label: string): void {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Loop v2 shadow ${label} must be below ${root}: ${target}`);
  }
}

function relativePortable(root: string, target: string): string {
  return path.relative(root, target).replaceAll("\\", "/");
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sum<T>(items: readonly T[], select: (item: T) => number): number {
  return items.reduce((total, item) => total + select(item), 0);
}
