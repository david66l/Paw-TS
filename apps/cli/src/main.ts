#!/usr/bin/env bun
import {
  formatDoctorOutput,
  formatFsListOutput,
  formatFsReadOutput,
  runStubRun,
} from "@paw/agent";
import {
  defaultSettingsPath,
  loadPawSettingsLocal,
  redactSettingsForDisplay,
  savePawSettingsLocal,
} from "@paw/settings";
import { parseRootFromArgv, tailPositionalArgs } from "@paw/workspace";
import { gitCommit, gitStatus } from "@paw/workspace";

const argv = process.argv.slice(2);

function usage(): void {
  console.error(`paw-ts — Paw TypeScript CLI (canonical). Python \`paw\` is legacy/reference only.

Usage:
  paw-ts --version | -V
  paw-ts doctor [--root <dir>]
  paw-ts fs-read [--root <dir>] <relative-path>
  paw-ts fs-list [--root <dir>] [directory] [--recursive]
  paw-ts config [--root <dir>] [--get <key>] [--set <key> <value>]
  paw-ts commit [--root <dir>] [--message <text>]
  paw-ts stub-run [--goal <text>] [--max-steps <n>] [--worktree]
  paw-ts memory list|why|forget|stats|diff|mab|smoke|redteam [...]
  paw-ts eval run [--suite <name>] [--sandbox] [--repetitions <n>] [--output console|markdown|json]
  paw-ts eval list
  paw-ts eval swe-exp [--mode fake|deterministic|agent] [--max-samples N] [--max-steps N] [--suite-run-id ID] [--skip-harness|--eval-only] [--json] [--keep]
`);
  process.exit(2);
}

async function main(): Promise<void> {
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    usage();
  }

  if (argv[0] === "--version" || argv[0] === "-V") {
    console.log("0.0.1-ts.0");
    process.exit(0);
  }

  if (argv[0] === "paw-next" && argv[1] === "--startup-scan") {
    const { runPawNextStartupCliV1 } = await import(
      "./paw-next/startup-cli.js"
    );
    const result = await runPawNextStartupCliV1(argv.slice(1));
    if (result.stream === "stdout") console.log(result.text);
    else console.error(result.text);
    process.exit(result.exitCode);
  }

  if (argv[0] === "paw-next" && argv[1] === "--startup-scan-v2") {
    const { runPawNextStartupCliV2 } = await import(
      "./paw-next/startup-cli-v2.js"
    );
    const result = await runPawNextStartupCliV2(argv.slice(1));
    if (result.stream === "stdout") console.log(result.text);
    else console.error(result.text);
    process.exit(result.exitCode);
  }

  if (argv[0] === "paw-next" && argv[1] === "--startup-scan-v3") {
    const { runPawNextStartupCliV3 } = await import(
      "./paw-next/startup-cli-v3.js"
    );
    const result = await runPawNextStartupCliV3(argv.slice(1));
    if (result.stream === "stdout") console.log(result.text);
    else console.error(result.text);
    process.exit(result.exitCode);
  }

  if (argv[0] === "paw-next" && argv[1] === "--new-work-v3") {
    const { runPawNextNewWorkCliV3 } = await import(
      "./paw-next/new-work-cli-v3.js"
    );
    const result = await runPawNextNewWorkCliV3(argv.slice(1), {
      stdin: process.stdin,
      stdinIsTTY: process.stdin.isTTY === true,
    });
    if (result.stream === "stdout") console.log(result.text);
    else console.error(result.text);
    process.exit(result.exitCode);
  }

  if (argv[0] === "paw-next" && argv[1] === "--legacy-export-v1") {
    const { runPawNextLegacyExportCliV1 } = await import(
      "./paw-next/legacy-run-cli.js"
    );
    const result = await runPawNextLegacyExportCliV1(argv.slice(1));
    if (result.stream === "stdout") console.log(result.text);
    else console.error(result.text);
    process.exit(result.exitCode);
  }

  if (argv[0] === "doctor") {
    const root = parseRootFromArgv(process.cwd(), argv);
    const r = await formatDoctorOutput(root);
    if (r.ok) {
      console.log(r.text);
      process.exit(0);
    }
    console.error(r.text);
    process.exit(1);
  }

  if (argv[0] === "fs-read") {
    const root = parseRootFromArgv(process.cwd(), argv);
    const rel = tailPositionalArgs(argv, "fs-read")[0];
    if (!rel) {
      console.error("fs-read: missing <relative-path>");
      process.exit(2);
    }
    const r = formatFsReadOutput(root, rel);
    console.log(r.text);
    process.exit(r.ok ? 0 : 1);
  }

  if (argv[0] === "fs-list") {
    const root = parseRootFromArgv(process.cwd(), argv);
    const recursive = argv.includes("--recursive");
    const dir = tailPositionalArgs(argv, "fs-list")[0] ?? ".";
    const r = formatFsListOutput(root, dir, recursive);
    console.log(r.text);
    process.exit(r.ok ? 0 : 1);
  }

  if (argv[0] === "config") {
    const root = parseRootFromArgv(process.cwd(), argv);
    const settingsPath = defaultSettingsPath(root);
    const getIdx = argv.indexOf("--get");
    const setIdx = argv.indexOf("--set");
    const getKey = getIdx === -1 ? undefined : argv[getIdx + 1];
    const setKey = setIdx === -1 ? undefined : argv[setIdx + 1];
    const setRawValue = setIdx === -1 ? undefined : argv[setIdx + 2];

    if (getKey) {
      try {
        const s = loadPawSettingsLocal(settingsPath);
        const value = (s as Record<string, unknown>)[getKey];
        console.log(value !== undefined ? JSON.stringify(value) : "(not set)");
        process.exit(0);
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        process.exit(1);
      }
    }

    if (setKey && setRawValue) {
      const rawValue = setRawValue;
      let value: unknown = rawValue;
      // Try to parse as JSON for numbers, booleans, arrays, objects
      try {
        value = JSON.parse(rawValue);
      } catch {
        // keep as string
      }
      try {
        let s: Record<string, unknown>;
        try {
          s = loadPawSettingsLocal(settingsPath) as Record<string, unknown>;
        } catch {
          s = {};
        }
        s[setKey] = value;
        savePawSettingsLocal(
          settingsPath,
          s as Parameters<typeof savePawSettingsLocal>[1],
        );
        console.log(`Set ${setKey}`);
        process.exit(0);
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        process.exit(1);
      }
    }

    // Default: show all settings (redacted)
    try {
      const s = loadPawSettingsLocal(settingsPath);
      console.log(JSON.stringify(redactSettingsForDisplay(s), null, 2));
      process.exit(0);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
  }

  if (argv[0] === "commit") {
    const root = parseRootFromArgv(process.cwd(), argv);
    const status = gitStatus(root);
    if (status.error) {
      console.error(`git status failed: ${status.error}`);
      process.exit(1);
    }
    const hasStaged = (status.staged?.length ?? 0) > 0;
    if (!hasStaged) {
      console.error("No staged changes. Stage files with `git add` first.");
      process.exit(1);
    }
    const msgIdx = argv.indexOf("--message");
    const messageArg = msgIdx === -1 ? undefined : argv[msgIdx + 1];
    const message = messageArg || "chore: update";
    const result = gitCommit(root, message);
    if (!result.ok) {
      console.error(`git commit failed: ${result.error}`);
      process.exit(1);
    }
    console.log(result.message ?? "Committed.");
    process.exit(0);
  }

  if (argv[0] === "eval") {
    const { runEvalCommand } = await import("@paw/eval");
    const subcommand = argv[1] ?? "list";
    const suiteIdx = argv.indexOf("--suite");
    const suite = suiteIdx !== -1 ? argv[suiteIdx + 1] : undefined;
    const repIdx = argv.indexOf("--repetitions");
    const repetitions = repIdx !== -1 ? Number(argv[repIdx + 1]) : undefined;
    const outIdx = argv.indexOf("--output");
    const output = outIdx !== -1 ? argv[outIdx + 1] : undefined;
    const modelIdx = argv.indexOf("--model");
    const providerIdx = argv.indexOf("--provider");
    const model =
      modelIdx !== -1
        ? argv[modelIdx + 1]
        : providerIdx !== -1
          ? argv[providerIdx + 1]
          : undefined;
    const parIdx = argv.indexOf("--parallel");
    const parallel = parIdx !== -1 ? Number(argv[parIdx + 1]) : undefined;
    const sandbox = argv.includes("--sandbox");
    const saveTracesIdx = argv.indexOf("--save-traces");
    const saveTraces =
      saveTracesIdx !== -1 ? argv[saveTracesIdx + 1] : undefined;
    // M10 memory-adversarial flags
    const judgeProviderIdx = argv.indexOf("--judge-provider");
    const judgeProvider =
      judgeProviderIdx !== -1 ? argv[judgeProviderIdx + 1] : undefined;
    const json = argv.includes("--json");
    const keep = argv.includes("--keep");
    const maxSamplesIdx = argv.indexOf("--max-samples");
    const maxSamples =
      maxSamplesIdx !== -1 ? Number(argv[maxSamplesIdx + 1]) : undefined;
    const timeoutMsIdx = argv.indexOf("--timeout-ms");
    const timeoutMs =
      timeoutMsIdx !== -1 ? Number(argv[timeoutMsIdx + 1]) : undefined;
    const modeIdx = argv.indexOf("--mode");
    const sweExpModeRaw = modeIdx !== -1 ? argv[modeIdx + 1] : undefined;
    const sweExpMode =
      sweExpModeRaw === "fake" ||
      sweExpModeRaw === "deterministic" ||
      sweExpModeRaw === "agent"
        ? sweExpModeRaw
        : undefined;
    const reportIdx = argv.indexOf("--report");
    const reportPath = reportIdx !== -1 ? argv[reportIdx + 1] : undefined;
    const suiteRunIdx = argv.indexOf("--suite-run-id");
    const suiteRunId = suiteRunIdx !== -1 ? argv[suiteRunIdx + 1] : undefined;
    const skipHarness = argv.includes("--skip-harness");
    const maxStepsIdx = argv.indexOf("--max-steps");
    const maxStepsRaw =
      maxStepsIdx !== -1 ? Number(argv[maxStepsIdx + 1]) : undefined;
    const maxSteps = Number.isFinite(maxStepsRaw) ? maxStepsRaw : undefined;
    const root = parseRootFromArgv(process.cwd(), argv);

    const r = await runEvalCommand({
      subcommand,
      suite,
      repetitions: Number.isFinite(repetitions) ? repetitions : undefined,
      model,
      output,
      parallel: Number.isFinite(parallel) ? parallel : undefined,
      workspaceRoot: root,
      sandbox,
      saveTraces,
      judgeProvider,
      json,
      keep,
      maxSamples: Number.isFinite(maxSamples) ? maxSamples : undefined,
      timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : undefined,
      sweExpMode,
      reportPath,
      suiteRunId,
      skipHarness,
      maxSteps,
    });
    if (r.ok) {
      console.log(r.text);
      process.exit(0);
    }
    console.error(r.text);
    process.exit(1);
  }

  if (argv[0] === "memory") {
    const { runMemoryCommand } = await import("@paw/memory/longterm");
    const r = await runMemoryCommand(argv.slice(1));
    if (r.ok) {
      console.log(r.text);
      process.exit(0);
    }
    console.error(r.text);
    process.exit(1);
  }

  if (argv[0] === "stub-run") {
    let goal = "stub";
    const gIdx = argv.indexOf("--goal");
    if (gIdx !== -1 && argv[gIdx + 1]) {
      goal = argv[gIdx + 1] ?? goal;
    }
    let maxSteps: number | undefined;
    const msIdx = argv.indexOf("--max-steps");
    if (msIdx !== -1 && argv[msIdx + 1]) {
      const n = Number(argv[msIdx + 1]);
      if (Number.isFinite(n)) {
        maxSteps = n;
      }
    }
    const useWorktree = argv.includes("--worktree");
    const root = parseRootFromArgv(process.cwd(), argv);
    const r = await runStubRun(goal, {
      workspaceRoot: root,
      maxSteps,
      useWorktree,
    });
    console.log(r.text);
    process.exit(r.exitCode);
  }

  usage();
}

await main();
