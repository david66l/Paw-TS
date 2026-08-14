#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import path from "node:path";

import {
  findPawResumeInstanceId,
  loadPawQualificationResults,
  runSweCompareArm,
  summarizePawQualification,
  verifySweCompareResult,
} from "../src/swe-compare/index.js";
import type { SweCompareManifest } from "../src/swe-compare/types.js";

function value(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const repoRoot = process.cwd();
const manifestName = value("--manifest") ?? "paw-fresh-qualification-v9.json";
const manifestPath = path.join(
  repoRoot,
  "benchmarks",
  "swe-compare",
  "manifests",
  manifestName,
);
const manifest = JSON.parse(
  readFileSync(manifestPath, "utf8"),
) as SweCompareManifest;
const existingResults = loadPawQualificationResults(repoRoot, manifest);
const before = summarizePawQualification(manifest, existingResults);
const resumeRunId = value("--resume-run");
const runNext = process.argv.includes("--next");

if (resumeRunId && runNext) {
  throw new Error("use either --next or --resume-run, not both");
}
if ((!runNext && !resumeRunId) || before.complete) {
  console.log(JSON.stringify(before, null, 2));
  process.exit(before.complete && !before.passed ? 1 : 0);
}

const instanceId = resumeRunId
  ? findPawResumeInstanceId(manifest, resumeRunId)
  : before.pendingInstanceIds[0];
if (!instanceId) throw new Error("qualification batch has no pending instance");
if (!before.pendingInstanceIds.includes(instanceId)) {
  throw new Error(`resume instance is not pending: ${instanceId}`);
}
console.error(
  `[paw-qualification] ${before.samples + 1}/10 ${
    resumeRunId
      ? "resume"
      : before.verificationErrorInstanceIds.includes(instanceId)
        ? "retry-verifier"
        : "start"
  } ${instanceId}${resumeRunId ? ` run=${resumeRunId}` : ""}`,
);
const retryResult = existingResults.find(
  (candidate) => candidate.instanceId === instanceId,
);
const result = resumeRunId
  ? await runSweCompareArm({
      repoRoot,
      manifestPath,
      instanceId,
      runner: "paw",
      resumeRunId,
    })
  : retryResult && before.verificationErrorInstanceIds.includes(instanceId)
    ? verifySweCompareResult({
        repoRoot,
        resultPath: path.join(
          repoRoot,
          "benchmarks",
          "swe-compare",
          "runs",
          retryResult.runId,
          "result.json",
        ),
        timeoutSec: Math.max(
          600,
          Math.floor(manifest.budget.sharedTimeoutMs / 1000),
        ),
      })
    : await runSweCompareArm({
        repoRoot,
        manifestPath,
        instanceId,
        runner: "paw",
      });
const after = summarizePawQualification(
  manifest,
  loadPawQualificationResults(repoRoot, manifest),
);
console.log(JSON.stringify({ result, batch: after }, null, 2));
// An unresolved task is a valid frozen sample; only batch infrastructure throws.
process.exit(0);
