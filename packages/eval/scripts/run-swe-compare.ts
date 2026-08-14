#!/usr/bin/env bun

import path from "node:path";

import {
  auditSweCompareResult,
  recoverClaudeResultPatch,
  recoverPawResultPatch,
  runSweCompareArm,
  verifySweCompareResult,
} from "../src/swe-compare/index.js";

function value(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const instanceId = value("--instance");
const runner = value("--runner");
const verifyResult = value("--verify-result");
const recoverResult = value("--recover-result-patch");
const recoverPawResult = value("--recover-paw-result-patch");
const manifestName = value("--manifest") ?? "formal-dev-v1.json";
if (recoverPawResult) {
  const result = recoverPawResultPatch({
    repoRoot: process.cwd(),
    resultPath: path.resolve(recoverPawResult),
    replaceReplayedPatch: process.argv.includes("--replace-replayed-patch"),
  });
  console.log(
    JSON.stringify(
      {
        runId: result.runId,
        patchChars: result.patchChars,
        patchSource: result.patchSource,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}
const auditResult = value("--audit-result");
if (auditResult) {
  const result = auditSweCompareResult({
    repoRoot: process.cwd(),
    resultPath: path.resolve(auditResult),
  });
  console.log(JSON.stringify(result.integrity, null, 2));
  process.exit(result.integrity?.valid === false ? 1 : 0);
}
if (recoverResult) {
  const result = recoverClaudeResultPatch({
    repoRoot: process.cwd(),
    resultPath: path.resolve(recoverResult),
  });
  console.log(
    JSON.stringify(
      {
        runId: result.runId,
        patchChars: result.patchChars,
        patchSource: result.patchSource,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}
if (verifyResult) {
  const result = verifySweCompareResult({
    repoRoot: process.cwd(),
    resultPath: path.resolve(verifyResult),
  });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.resolved ? 0 : 1);
}
if (!instanceId || (runner !== "paw" && runner !== "claude")) {
  throw new Error(
    "Usage: --instance <id> --runner paw|claude [--manifest <name.json>] [--skip-verifier] [--keep] OR --verify-result <result.json> OR --recover-result-patch <result.json> OR --recover-paw-result-patch <result.json> [--replace-replayed-patch] OR --audit-result <result.json>",
  );
}
if (manifestName === "paw-seen-dev-v1.json" && runner !== "paw") {
  throw new Error(
    "paw-seen-dev-v1 is a Paw-only architecture diagnostic; Claude runs are forbidden",
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
    manifestName,
  ),
  instanceId,
  runner,
  keep: process.argv.includes("--keep"),
  skipVerifier: process.argv.includes("--skip-verifier"),
});
console.log(JSON.stringify(result, null, 2));
process.exit(
  result.artifactStatus === "patch_collection_failed"
    ? 2
    : result.status === "completed"
      ? 0
      : 1,
);
