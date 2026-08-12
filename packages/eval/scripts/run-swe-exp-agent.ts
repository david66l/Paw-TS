#!/usr/bin/env bun
/**
 * SWE-Exp agent 模式入口
 *
 * Usage:
 *   bun run packages/eval/scripts/run-swe-exp-agent.ts --max-pairs 1 --skip-harness
 *   bun run packages/eval/scripts/run-swe-exp-agent.ts --max-pairs 1
 *   bun run packages/eval/scripts/run-swe-exp-agent.ts --suite-run-id agent-... --max-pairs 5
 *   bun run packages/eval/scripts/run-swe-exp-agent.ts --suite-run-id agent-... --eval-only
 */

import { runSweExpAgent } from "../src/swe-exp/agent-harness.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const maxPairs = Number(arg("--max-pairs") ?? "1");
const maxSteps = Number(arg("--max-steps") ?? "64");
const timeoutMs = Number(arg("--timeout-ms") ?? String(25 * 60_000));
const suiteRunId = arg("--suite-run-id");
const skipHarness = process.argv.includes("--skip-harness");
const evalOnly = process.argv.includes("--eval-only");
const keep = process.argv.includes("--keep");
const provider = arg("--provider");
const reposRaw = arg("--repos");
const repos = reposRaw
  ? reposRaw.split(",").map((s) => s.trim()).filter(Boolean)
  : undefined;

const report = await runSweExpAgent({
  repoRoot: process.cwd(),
  maxPairs: Number.isFinite(maxPairs) ? maxPairs : 1,
  maxSteps: Number.isFinite(maxSteps) ? maxSteps : 64,
  timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 25 * 60_000,
  suiteRunId,
  skipHarness,
  evalOnly,
  keep,
  modelProvider: provider,
  repos,
});

console.log(JSON.stringify(report, null, 2));
process.exit(report.passed === true ? 0 : 1);
