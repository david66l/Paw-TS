import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { PAW_FRESH_QUALIFICATION_RULE } from "./manifest.js";
import type { SweCompareRunResult } from "./runner.js";
import type { SweCompareManifest } from "./types.js";

export const PAW_QUALIFICATION_GATE = {
  version: "paw-fresh-qualification-gate-v1" as const,
  ruleVersion: PAW_FRESH_QUALIFICATION_RULE.version,
  expectedSamples: 10,
  minOfficialResolved: 7,
  maxIntegrityViolations: 0,
  maxInvalidArtifacts: 0,
} as const;

/** The frozen Paw qualification measures the authoritative Loop v2 path. */
export const PAW_QUALIFICATION_LOOP_KERNEL = "v2" as const;

export interface PawQualificationSummary {
  readonly gateVersion: typeof PAW_QUALIFICATION_GATE.version;
  readonly state: "in_progress" | "passed" | "failed";
  readonly complete: boolean;
  readonly passed: boolean;
  readonly samples: number;
  readonly officialResolved: number;
  readonly integrityViolations: number;
  readonly invalidArtifacts: number;
  readonly verificationErrors: number;
  readonly pendingInstanceIds: readonly string[];
  readonly verificationErrorInstanceIds: readonly string[];
  readonly resolvedInstanceIds: readonly string[];
  readonly failedInstanceIds: readonly string[];
}

export function summarizePawQualification(
  manifest: SweCompareManifest,
  results: readonly SweCompareRunResult[],
): PawQualificationSummary {
  const gate = PAW_QUALIFICATION_GATE;
  if (
    manifest.selection.ruleVersion !== gate.ruleVersion ||
    manifest.selection.ids.length !== gate.expectedSamples
  ) {
    throw new Error("qualification manifest does not match the frozen gate");
  }
  const selected = new Set(manifest.selection.ids);
  const byInstance = new Map<string, SweCompareRunResult>();
  for (const result of results) {
    if (
      result.runner !== "paw" ||
      result.loopKernelVersion !== PAW_QUALIFICATION_LOOP_KERNEL ||
      result.sourceCommit !== manifest.sourceTree.gitCommit ||
      !selected.has(result.instanceId)
    ) {
      throw new Error(`result is outside the frozen batch: ${result.runId}`);
    }
    if (byInstance.has(result.instanceId)) {
      throw new Error(`duplicate qualification sample: ${result.instanceId}`);
    }
    byInstance.set(result.instanceId, result);
  }

  const pendingInstanceIds = manifest.selection.ids.filter((id) => {
    const result = byInstance.get(id);
    return !result || isRetryableVerificationFailure(result);
  });
  const acceptedResults = results.filter(
    (result) => !isRetryableVerificationFailure(result),
  );
  const verificationErrorInstanceIds = results
    .filter(isRetryableVerificationFailure)
    .map((result) => result.instanceId);
  const officialResolved = acceptedResults.filter(
    (result) => result.resolved && result.resolvedSource === "swebench_harness",
  );
  const integrityViolations = acceptedResults.filter(
    (result) => result.integrity?.valid !== true,
  ).length;
  const invalidArtifacts = acceptedResults.filter(
    (result) => result.artifactStatus !== "valid" || !result.tracePath?.trim(),
  ).length;
  const complete = pendingInstanceIds.length === 0;
  const passed =
    complete &&
    officialResolved.length >= gate.minOfficialResolved &&
    integrityViolations <= gate.maxIntegrityViolations &&
    invalidArtifacts <= gate.maxInvalidArtifacts;
  return {
    gateVersion: gate.version,
    state: complete ? (passed ? "passed" : "failed") : "in_progress",
    complete,
    passed,
    samples: acceptedResults.length,
    officialResolved: officialResolved.length,
    integrityViolations,
    invalidArtifacts,
    verificationErrors: verificationErrorInstanceIds.length,
    pendingInstanceIds,
    verificationErrorInstanceIds,
    resolvedInstanceIds: officialResolved.map((result) => result.instanceId),
    failedInstanceIds: acceptedResults
      .filter(
        (result) =>
          !result.resolved || result.resolvedSource !== "swebench_harness",
      )
      .map((result) => result.instanceId),
  };
}

export function isRetryableVerificationFailure(
  result: SweCompareRunResult,
): boolean {
  return (
    result.artifactStatus === "valid" &&
    result.integrity?.valid === true &&
    Boolean(result.tracePath?.trim()) &&
    Boolean(result.patch.trim()) &&
    result.resolvedSource !== "swebench_harness"
  );
}

export function loadPawQualificationResults(
  repoRoot: string,
  manifest: SweCompareManifest,
): SweCompareRunResult[] {
  const runsRoot = path.join(repoRoot, "benchmarks", "swe-compare", "runs");
  if (!existsSync(runsRoot)) return [];
  const selected = new Set(manifest.selection.ids);
  const results: SweCompareRunResult[] = [];
  for (const entry of readdirSync(runsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const resultPath = path.join(runsRoot, entry.name, "result.json");
    if (!existsSync(resultPath)) continue;
    let result: SweCompareRunResult;
    try {
      result = JSON.parse(
        readFileSync(resultPath, "utf8"),
      ) as SweCompareRunResult;
    } catch {
      continue;
    }
    if (
      result.runner === "paw" &&
      result.loopKernelVersion === PAW_QUALIFICATION_LOOP_KERNEL &&
      result.sourceCommit === manifest.sourceTree.gitCommit &&
      selected.has(result.instanceId)
    ) {
      results.push(result);
    }
  }
  return results;
}
