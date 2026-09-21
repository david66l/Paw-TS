/**
 * Single SWE-bench Lite issue probe (unfamiliar large repo).
 *
 * bun run benchmarks/longrun-probe/run-swe-issue.ts
 *
 * Defaults to a Sphinx Lite issue; override with SWE_INSTANCE_ID.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { runAgentArm } from "../../packages/eval/src/swe-exp/agent-arm.ts";
import type { SweBenchLiteInstance } from "../../packages/eval/src/swe-exp/agent-types.ts";
import {
  runSwebenchHarness,
  writePredictionsJsonl,
} from "../../packages/eval/src/swe-exp/evaluate.ts";

const repoRoot = path.resolve("E:/A_Louis/paw-ts");
const jsonl = path.join(repoRoot, "benchmarks/swe-bench/swe-bench-lite.jsonl");
const INSTANCE_ID = process.env.SWE_INSTANCE_ID ?? "sphinx-doc__sphinx-11445";
const MAX_STEPS = Number(process.env.SWE_MAX_STEPS ?? "64");
const TIMEOUT_MS = Number(process.env.SWE_TIMEOUT_MS ?? String(25 * 60_000));
const suiteRunId = `swe-issue-${Date.now().toString(36)}`;
const outDir = path.join(repoRoot, "benchmarks/swe-exp/runs", suiteRunId);
mkdirSync(outDir, { recursive: true });

function loadInstance(id: string): SweBenchLiteInstance {
  const lines = readFileSync(jsonl, "utf8").trim().split(/\n+/);
  for (const line of lines) {
    const j = JSON.parse(line) as SweBenchLiteInstance;
    if (j.instance_id === id) {
      return {
        ...j,
        FAIL_TO_PASS: parseList(j.FAIL_TO_PASS),
        PASS_TO_PASS: parseList(j.PASS_TO_PASS),
      };
    }
  }
  throw new Error(`instance not found: ${id}`);
}

function parseList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v);
      if (Array.isArray(p)) return p.map(String);
    } catch {
      /* ignore */
    }
  }
  return [];
}

const probe = loadInstance(INSTANCE_ID);
const failToPass = parseList(probe.FAIL_TO_PASS);
const passToPass = parseList(probe.PASS_TO_PASS);

console.log(
  JSON.stringify(
    {
      suiteRunId,
      instance: probe.instance_id,
      repo: probe.repo,
      base: probe.base_commit.slice(0, 12),
      failToPass,
      passToPassCount: passToPass.length,
      problemHead: probe.problem_statement.slice(0, 240),
    },
    null,
    2,
  ),
);

const t0 = Date.now();
const cp = await runAgentArm({
  suiteRunId,
  pairId: probe.instance_id,
  arm: "off",
  probe,
  cacheDir: path.join(repoRoot, "benchmarks/swe-exp"),
  checkpointDir: path.join(repoRoot, "benchmarks/swe-exp"),
  hostWorkspaceRoot: repoRoot,
  maxSteps: MAX_STEPS,
  timeoutMs: TIMEOUT_MS,
  keep: true,
  skipEval: true,
});

let official:
  | ReturnType<typeof runSwebenchHarness>
  | { resolved: false; source: "none"; detail: string } = {
  resolved: false,
  source: "none",
  detail: "no model patch",
};
if (cp.result?.patch) {
  const predictionsPath = path.join(outDir, "predictions.jsonl");
  writePredictionsJsonl(predictionsPath, [
    {
      instance_id: probe.instance_id,
      model_name_or_path: "paw-capability-first",
      model_patch: cp.result.patch,
    },
  ]);
  console.log(`[swe-issue] running official harness for ${probe.instance_id}`);
  official = runSwebenchHarness({
    predictionsPath,
    instanceIds: [probe.instance_id],
    runId: suiteRunId,
    cwd: repoRoot,
    timeoutSec: 3600,
  });
}

const report = {
  suiteRunId,
  instance_id: probe.instance_id,
  repo: probe.repo,
  elapsedMs: Date.now() - t0,
  checkpoint: {
    status: cp.status,
    runId: cp.runId,
    workspaceRoot: cp.workspaceRoot,
    error: cp.error,
  },
  result: cp.result
    ? {
        runStatus: cp.result.runStatus,
        failureReason: cp.result.failureReason,
        patchChars: cp.result.patchChars,
        steps: cp.result.steps,
        durationMs: cp.result.durationMs,
        modelCalls: cp.result.modelCalls,
        totalTokens: cp.result.totalTokens,
        warnings: cp.result.warnings,
        patchPreview: (cp.result.patch ?? "").slice(0, 4000),
      }
    : null,
  official,
  goldPatchPreview: probe.patch.slice(0, 1500),
  failToPass,
};

const outPath = path.join(outDir, "report.json");
writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");
if (cp.result?.patch) {
  writeFileSync(path.join(outDir, "model.patch"), cp.result.patch, "utf8");
}
writeFileSync(path.join(outDir, "gold.patch"), probe.patch, "utf8");

console.log(
  JSON.stringify(
    {
      outPath,
      status: cp.status,
      runStatus: cp.result?.runStatus,
      patchChars: cp.result?.patchChars,
      steps: cp.result?.steps,
      warnings: cp.result?.warnings,
      official,
      workspaceRoot: cp.workspaceRoot,
      elapsedMs: report.elapsedMs,
      patchPreview: (cp.result?.patch ?? "").slice(0, 1500),
    },
    null,
    2,
  ),
);

process.exit(official.resolved ? 0 : 1);
