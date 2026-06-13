#!/usr/bin/env bun
import {
  formatDoctorOutput,
  formatFsListOutput,
  formatFsReadOutput,
  parseRootFromArgv,
  runStubRun,
  tailPositionalArgs,
} from "@paw/cli-core";
import {
  defaultSettingsPath,
  loadPawSettingsLocal,
  redactSettingsForDisplay,
  savePawSettingsLocal,
} from "@paw/settings";
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
  paw-ts eval run [--suite <name>] [--sandbox] [--repetitions <n>] [--output console|markdown|json]
  paw-ts eval list
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

  if (argv[0] === "doctor") {
    const root = parseRootFromArgv(process.cwd(), argv);
    const r = formatDoctorOutput(root);
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

    if (getIdx !== -1 && argv[getIdx + 1]) {
      const key = argv[getIdx + 1]!;
      try {
        const s = loadPawSettingsLocal(settingsPath);
        const value = (s as Record<string, unknown>)[key];
        console.log(value !== undefined ? JSON.stringify(value) : "(not set)");
        process.exit(0);
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        process.exit(1);
      }
    }

    if (setIdx !== -1 && argv[setIdx + 1] && argv[setIdx + 2]) {
      const key = argv[setIdx + 1]!;
      const rawValue = argv[setIdx + 2]!;
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
        s[key] = value;
        savePawSettingsLocal(
          settingsPath,
          s as Parameters<typeof savePawSettingsLocal>[1],
        );
        console.log(`Set ${key}`);
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
    const message =
      msgIdx !== -1 && argv[msgIdx + 1] ? argv[msgIdx + 1]! : "chore: update";
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
    const model = modelIdx !== -1 ? argv[modelIdx + 1] : undefined;
    const parIdx = argv.indexOf("--parallel");
    const parallel = parIdx !== -1 ? Number(argv[parIdx + 1]) : undefined;
    const sandbox = argv.includes("--sandbox");
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
    });
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
