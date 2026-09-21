import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

import {
  PAW_NEXT_STARTUP_CLI_REPORT_SCHEMA_V1,
  runPawNextStartupCliV1,
} from "../src/paw-next/startup-cli.js";

const roots: string[] = [];
const USAGE =
  "Usage: paw-ts paw-next --startup-scan --root <absolute-workspace>";

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("Paw Next explicit startup CLI", () => {
  test("only the exact absolute-root argument shape reaches the scanner", async () => {
    const root = workspace();
    const invalid: readonly (readonly string[])[] = [
      [],
      ["--startup-scan"],
      ["--root", root, "--startup-scan"],
      ["--startup-scan", "--root"],
      ["--startup-scan", "--root", "."],
      ["--startup-scan", "--root", root, "extra"],
      ["--startup-scan", "--startup-scan", "--root", root],
      ["--startup-scan", "--root", root, "--root", root],
      ["--startup-scan=false", "--root", root],
    ];

    for (const args of invalid) {
      const result = await runPawNextStartupCliV1(args);
      expect(result, args.join(" ")).toEqual({
        exitCode: 2,
        stream: "stderr",
        text: USAGE,
      });
    }
  });

  test("all typed statuses are stable JSON and attention statuses exit one", () => {
    const child = runMockChild("all_statuses");
    expect(child.scanCalls).toBe(1);
    expect(child.resolverFactoryCalls).toBe(1);
    expect(child.resolverCalls).toBe(1);
    expect(child.timeoutCalls).toBe(0);
    expect(child.intervalCalls).toBe(0);
    expect(child.result.exitCode).toBe(1);
    expect(child.result.stream).toBe("stdout");
    expect(child.result.text).not.toContain(child.secret);
    const report = JSON.parse(child.result.text) as Report;
    expect(report.schemaVersion).toBe(PAW_NEXT_STARTUP_CLI_REPORT_SCHEMA_V1);
    expect(report.authorityIssues).toEqual([
      { entryName: "foreign-entry", reasonCode: "foreign_entry" },
    ]);
    expect(report.runs.map((run) => run.status)).toEqual([
      "terminal",
      "blocked_pending",
      "blocked_unconsumed",
      "deferred",
      "resumed",
      "busy",
      "anchor_conflict",
      "inventory_stale",
      "config_unavailable",
      "invalid",
      "ambiguous_session",
      "failed",
    ]);
    expect(
      report.runs
        .filter((run) => run.reasonCode !== undefined)
        .map((run) => [run.status, run.reasonCode]),
    ).toEqual([
      ["busy", "run_busy"],
      ["anchor_conflict", "run_anchor_conflict"],
      ["inventory_stale", "run_inventory_stale"],
      ["config_unavailable", "run_config_unavailable"],
      ["invalid", "run_invalid"],
      ["ambiguous_session", "run_ambiguous_session"],
      ["failed", "run_failed"],
    ]);
  });

  test("terminal, blocked, deferred and resumed are non-attention outcomes", () => {
    const child = runMockChild("clean");
    expect(child.result.exitCode).toBe(0);
    expect(child.scanCalls).toBe(1);
    expect(child.resolverFactoryCalls).toBe(1);
    expect(child.timeoutCalls + child.intervalCalls).toBe(0);
    const report = JSON.parse(child.result.text) as Report;
    expect(report.runs[1]).toMatchObject({
      status: "blocked_pending",
      inputIds: ["pending-input"],
    });
    expect(report.runs[4]).toMatchObject({ status: "resumed", tailSeq: 19 });
    expect(report.runs.every((run) => run.reasonCode === undefined)).toBeTrue();
  });

  test("missing profile still scans once with an unavailable resolver", () => {
    const child = runMockChild("configuration_throw");
    expect(child.resolverFactoryCalls).toBe(1);
    expect(child.resolverCalls).toBe(0);
    expect(child.scanCalls).toBe(1);
    expect(child.timeoutCalls + child.intervalCalls).toBe(0);
    expect(child.result.exitCode).toBe(1);
    expect(child.result.text).not.toContain(child.secret);
    expect(JSON.parse(child.result.text)).toEqual({
      schemaVersion: PAW_NEXT_STARTUP_CLI_REPORT_SCHEMA_V1,
      mode: "once",
      workspaceRoot: child.workspaceRoot,
      configurationIssue: { code: "profile_configuration_unavailable" },
      authorityIssues: [],
      runs: [
        {
          sessionId: "session-config_unavailable",
          runId: "run-config_unavailable",
          status: "config_unavailable",
          reasonCode: "run_config_unavailable",
        },
      ],
    });
  });

  test("a workspace alias reports and scans the canonical target identity", async () => {
    const root = workspace();
    const alias = path.join(
      os.tmpdir(),
      `paw-startup-cli-alias-${process.pid}-${Date.now()}`,
    );
    fs.symlinkSync(
      root,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    try {
      const result = await runPawNextStartupCliV1([
        "--startup-scan",
        "--root",
        alias,
      ]);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.text)).toMatchObject({
        schemaVersion: PAW_NEXT_STARTUP_CLI_REPORT_SCHEMA_V1,
        mode: "once",
        workspaceRoot: fs.realpathSync.native(root),
        configurationIssue: { code: "profile_configuration_unavailable" },
        authorityIssues: [],
        runs: [],
      });
      expect(fs.readdirSync(root)).toEqual([]);
    } finally {
      fs.unlinkSync(alias);
    }
  });

  test("a scanner failure is sanitized and never retried", () => {
    const child = runMockChild("scan_throw");
    expect(child.resolverFactoryCalls).toBe(1);
    expect(child.scanCalls).toBe(1);
    expect(child.timeoutCalls + child.intervalCalls).toBe(0);
    expect(child.result.exitCode).toBe(1);
    expect(child.result.text).not.toContain(child.secret);
    expect(JSON.parse(child.result.text)).toEqual({
      schemaVersion: PAW_NEXT_STARTUP_CLI_REPORT_SCHEMA_V1,
      mode: "once",
      workspaceRoot: child.workspaceRoot,
      executionIssue: { reasonCode: "startup_scan_failed" },
      authorityIssues: [],
      runs: [],
    });
  });

  test("an invalid absolute workspace fails generically before configuration or scan", async () => {
    const missing = path.join(
      os.tmpdir(),
      `paw-startup-cli-missing-${process.pid}-${Date.now()}`,
    );
    const result = await runPawNextStartupCliV1([
      "--startup-scan",
      "--root",
      missing,
    ]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.text)).toEqual({
      schemaVersion: PAW_NEXT_STARTUP_CLI_REPORT_SCHEMA_V1,
      mode: "once",
      workspaceRoot: path.normalize(missing),
      executionIssue: { reasonCode: "startup_scan_failed" },
      authorityIssues: [],
      runs: [],
    });
    expect(fs.existsSync(missing)).toBeFalse();
  });

  test("production command imports only the strict resolver and has no daemon primitive", () => {
    const source = fs.readFileSync(
      path.resolve(import.meta.dir, "../src/paw-next/startup-cli.ts"),
      "utf8",
    );
    expect(source).toContain("createPawNextProductProfileResolverV1");
    expect(source).not.toMatch(/createDefaultLanguageModel|FakeLanguageModel/);
    expect(source).not.toMatch(/setInterval|setTimeout|queueMicrotask/);
    expect(source.match(/await scanAndResumePawNextRunsV1\(/g)).toHaveLength(1);
  });
});

interface MockChildResult {
  readonly result: {
    readonly exitCode: number;
    readonly stream: string;
    readonly text: string;
  };
  readonly secret: string;
  readonly workspaceRoot: string;
  readonly resolverFactoryCalls: number;
  readonly resolverCalls: number;
  readonly scanCalls: number;
  readonly timeoutCalls: number;
  readonly intervalCalls: number;
}

interface Report {
  readonly schemaVersion: string;
  readonly authorityIssues: readonly unknown[];
  readonly runs: readonly {
    readonly status: string;
    readonly inputIds?: readonly string[];
    readonly tailSeq?: number;
    readonly reasonCode?: string;
  }[];
}

function runMockChild(scenario: string): MockChildResult {
  const root = workspace();
  const fixture = path.join(
    import.meta.dir,
    "fixtures",
    "paw-next-startup-cli-mock-child.ts",
  );
  const result = spawnSync(process.execPath, [fixture, scenario, root], {
    cwd: path.resolve(import.meta.dir, ".."),
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(
      `startup CLI mock child failed ${String(result.status)}: ${result.stderr}`,
    );
  }
  return {
    ...(JSON.parse(result.stdout) as MockChildResult),
    workspaceRoot: path.normalize(root),
  };
}

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-startup-cli-"));
  roots.push(root);
  return root;
}
