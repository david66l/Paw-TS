#!/usr/bin/env bun

import path from "node:path";

import { preflightSweCompareInstance } from "../src/swe-compare/index.js";

const index = process.argv.indexOf("--instance");
const instanceId = index >= 0 ? process.argv[index + 1] : undefined;
const manifestIndex = process.argv.indexOf("--manifest");
const manifestName =
  manifestIndex >= 0 ? process.argv[manifestIndex + 1] : "formal-dev-v1.json";
if (!instanceId)
  throw new Error(
    "Usage: --instance <SWE-bench instance id> [--manifest <name.json>]",
  );
const repoRoot = process.cwd();
const manifestPath = path.join(
  repoRoot,
  "benchmarks",
  "swe-compare",
  "manifests",
  manifestName,
);
const manifest = preflightSweCompareInstance({
  repoRoot,
  manifestPath,
  instanceId,
});
const result = manifest.instances.find(
  (item) => item.instanceId === instanceId,
);
console.log(JSON.stringify(result, null, 2));
process.exit(result?.qualification === "eligible" ? 0 : 1);
