#!/usr/bin/env bun

import { replayPawShadowTraces } from "../src/swe-compare/index.js";

function values(name: string): string[] {
  const found: string[] = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] !== name) continue;
    const value = process.argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value after ${name}`);
    }
    found.push(value);
    index += 1;
  }
  return found;
}

function value(name: string): string | undefined {
  const found = values(name);
  if (found.length > 1) throw new Error(`${name} may be specified only once`);
  return found[0];
}

const tracePaths = values("--trace");
const summaryName = value("--summary");
if (!summaryName || tracePaths.length === 0) {
  throw new Error(
    "Usage: bun run packages/eval/scripts/replay-loop-v2-shadow.ts --summary <name.json> --trace <paw-run/trace.json> [--trace <...>]",
  );
}

const result = replayPawShadowTraces({
  repoRoot: process.cwd(),
  tracePaths,
  summaryName,
});
console.log(
  JSON.stringify(
    {
      summaryPath: result.summaryPath,
      summaryHash: result.summary.summaryHash,
      totals: result.summary.totals,
      runs: result.summary.runs.map((run) => ({
        runId: run.runId,
        terminal: run.legacyTerminal?.status ?? "missing",
        coverage: run.coverage,
        artifactStatus: run.artifactStatus,
        readinessDisposition: run.readinessDisposition ?? "none",
        comparison: run.comparison,
        v2Outcome: run.v2Outcome,
      })),
    },
    null,
    2,
  ),
);
