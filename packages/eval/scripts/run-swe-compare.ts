#!/usr/bin/env bun

import path from "node:path";

import { runSweCompareArm } from "../src/swe-compare/index.js";

function value(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const instanceId = value("--instance");
const runner = value("--runner");
if (!instanceId || (runner !== "paw" && runner !== "claude")) {
  throw new Error(
    "Usage: --instance <id> --runner paw|claude [--skip-verifier] [--keep]",
  );
}
const repoRoot = process.cwd();
const result = await runSweCompareArm({
  repoRoot,
  manifestPath: path.join(
    repoRoot,
    "benchmarks",
    "swe-compare",
    "manifests",
    "smoke-v1.json",
  ),
  instanceId,
  runner,
  keep: process.argv.includes("--keep"),
  skipVerifier: process.argv.includes("--skip-verifier"),
});
console.log(JSON.stringify(result, null, 2));
process.exit(result.status === "completed" ? 0 : 1);
