/**
 * Eval CLI command — `paw eval run|list`.
 *
 * Wired into apps/cli/src/main.ts via the `eval` subcommand.
 */

import { listBuiltinSuites, resolveSuite } from "../test-suite/loader.js";
import { EvalRunner, type EvalRunnerOptions } from "../runner.js";
import type { ReportFormat } from "../scorer/reporter.js";

export interface EvalCommandArgs {
  readonly subcommand: string;
  readonly suite?: string;
  readonly repetitions?: number;
  readonly model?: string;
  readonly output?: string; // console|markdown|json
  readonly parallel?: number;
  readonly workspaceRoot?: string;
}

export async function runEvalCommand(
  args: EvalCommandArgs,
): Promise<{ ok: boolean; text: string }> {
  switch (args.subcommand) {
    case "run":
      return runEval(args);
    case "list":
      return listSuites();
    default:
      return {
        ok: false,
        text: `Unknown eval subcommand: ${args.subcommand}\nUsage: paw eval run|list`,
      };
  }
}

async function runEval(
  args: EvalCommandArgs,
): Promise<{ ok: boolean; text: string }> {
  const suiteName = args.suite;
  if (!suiteName) {
    return { ok: false, text: "Usage: paw eval run --suite <name>" };
  }

  const cases = resolveSuite(suiteName);
  if (!cases || cases.length === 0) {
    const available = listBuiltinSuites().join(", ");
    return {
      ok: false,
      text: `Suite "${suiteName}" not found. Available: ${available || "(none)"}`,
    };
  }

  const reportFormat: ReportFormat = (() => {
    switch (args.output) {
      case "markdown":
        return "markdown";
      case "json":
        return "json";
      default:
        return "console";
    }
  })();

  const runnerOpts: EvalRunnerOptions = {
    workspaceRoot: args.workspaceRoot,
    settings: {
      default_repetitions: args.repetitions,
      ...(args.parallel ? { parallel_runs: args.parallel } : {}),
    },
    reportFormat,
    onProgress: (testCaseId, rep, _total) => {
      // Minimal progress output
      process.stderr.write(`  ${testCaseId} rep ${rep}...\n`);
    },
  };

  const runner = new EvalRunner(runnerOpts);

  try {
    const result = await runner.runSuite(suiteName, cases);
    return { ok: result.overallPassRate >= 70, text: result.formattedReport };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, text: `Eval run failed: ${msg}` };
  }
}

function listSuites(): { ok: boolean; text: string } {
  const names = listBuiltinSuites();
  if (names.length === 0) {
    return { ok: true, text: "No built-in test suites available." };
  }
  return {
    ok: true,
    text: `Available test suites:\n${names.map((n) => `  - ${n}`).join("\n")}`,
  };
}
