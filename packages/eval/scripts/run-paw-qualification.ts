#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import path from "node:path";

import {
  loadPawQualificationResults,
  runSweCompareArm,
  summarizePawQualification,
} from "../src/swe-compare/index.js";
import type { SweCompareManifest } from "../src/swe-compare/types.js";

function value(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const repoRoot = process.cwd();
const manifestName = value("--manifest") ?? "paw-fresh-qualification-v5.json";
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
const before = summarizePawQualification(
  manifest,
  loadPawQualificationResults(repoRoot, manifest),
);

if (!process.argv.includes("--next") || before.complete) {
  console.log(JSON.stringify(before, null, 2));
  process.exit(before.complete && !before.passed ? 1 : 0);
}

const instanceId = before.pendingInstanceIds[0];
if (!instanceId) throw new Error("qualification batch has no pending instance");
console.error(
  `[paw-qualification] ${before.samples + 1}/10 start ${instanceId}`,
);
const result = await runSweCompareArm({
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
