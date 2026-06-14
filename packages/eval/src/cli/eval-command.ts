/**
 * Eval CLI command — `paw eval run|list`.
 *
 * Wired into apps/cli/src/main.ts via the `eval` subcommand.
 */

import { writeFileSync } from "node:fs";
import { listBuiltinSuites, resolveSuite } from "../test-suite/loader.js";
import { EvalRunner, type EvalRunnerOptions } from "../runner.js";
import type { ReportFormat } from "../scorer/reporter.js";
import { exportSuccessfulRuns, toJsonl } from "../training-data-exporter.js";
import { createDefaultLanguageModel, OpenAICompatibleModel } from "@paw/models";
import {
  defaultSettingsPath,
  loadPawSettingsLocal,
  resolveApiKey,
  resolveBaseUrl,
  resolveModel,
} from "@paw/settings";
import type { LanguageModel } from "@paw/models";

export interface EvalCommandArgs {
  readonly subcommand: string;
  readonly suite?: string;
  readonly repetitions?: number;
  readonly model?: string;
  readonly output?: string; // console|markdown|json
  readonly parallel?: number;
  readonly workspaceRoot?: string;
  readonly sandbox?: boolean;
  readonly saveTraces?: string;
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

  // Resolve model from settings
  const model = resolveEvalModel(args.workspaceRoot ?? process.cwd(), args.model);

  const runnerOpts: EvalRunnerOptions = {
    model,
    workspaceRoot: args.workspaceRoot,
    sandbox: args.sandbox,
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

    // Export training data if requested
    if (args.saveTraces && result.allRecords.length > 0) {
      const conversations = exportSuccessfulRuns(
        result.allRecords,
        result.aggregateReports,
        100,  // only 100% perfect runs as training data
      );
      if (conversations.length > 0) {
        const jsonl = toJsonl(conversations);
        writeFileSync(args.saveTraces, jsonl + "\n", "utf-8");
        console.log(
          `\n[export] Saved ${conversations.length} training conversations to ${args.saveTraces}`,
        );
      }
    }

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
  const lines = ["Available test suites:"];
  let total = 0;
  for (const name of names) {
    const suite = resolveSuite(name);
    const count = suite?.length ?? 0;
    total += count;
    lines.push(`  - ${name} (${count} cases)`);
  }
  lines.push(`  - all (${total} cases total)`);
  return { ok: true, text: lines.join("\n") };
}

/** Resolve a LanguageModel from settings, optionally filtering by provider name. */
function resolveEvalModel(
  workspaceRoot: string,
  providerName?: string,
): LanguageModel {
  // No explicit provider → use default detection
  if (!providerName) {
    return createDefaultLanguageModel(workspaceRoot);
  }

  try {
    const settingsPath = defaultSettingsPath(workspaceRoot);
    const s = loadPawSettingsLocal(settingsPath);
    const provider = providerName.toLowerCase();

    // Look for provider-specific settings
    const providers = s.models as Record<string, Record<string, unknown>> | undefined;
    const providerConfig = providers?.[provider];

    if (providerConfig) {
      const apiKey = resolveApiKey(s, provider as never) || String(providerConfig.apiKey ?? "");
      const baseUrl = resolveBaseUrl(s, provider as never) || String(providerConfig.baseUrl ?? "https://api.deepseek.com");
      const modelId = resolveModel(s, provider as never, String(providerConfig.model ?? "deepseek-chat"));

      // Use OpenAICompatibleModel (works for DeepSeek, Qwen, and OpenAI)
      return new OpenAICompatibleModel({
        apiKey,
        baseUrl,
        model: modelId,
        capabilities: { contextWindow: 128_000, maxOutputTokens: 8_192 },
      });
    }

    // Provider not found in settings, fall back to default
    console.warn(`[paw eval] Provider "${providerName}" not found in settings. Using default model.`);
  } catch (e) {
    console.warn(`[paw eval] Failed to resolve model "${providerName}": ${e instanceof Error ? e.message : String(e)}. Using default.`);
  }

  return createDefaultLanguageModel(workspaceRoot);
}
