import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  PAW_NEXT_STARTUP_CLI_REPORT_SCHEMA_V2,
  runPawNextStartupCliV2,
} from "../src/paw-next/startup-cli-v2.js";

const roots: string[] = [];
const USAGE =
  "Usage: paw-ts paw-next --startup-scan-v2 --root <absolute-workspace>";

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("Paw Next explicit V2 startup CLI", () => {
  test("rejects every non-exact argument shape before catalog or scan", async () => {
    const root = workspace();
    const before = fs.readdirSync(root);
    const invalid: readonly (readonly string[])[] = [
      [],
      ["--startup-scan-v2"],
      ["--root", root, "--startup-scan-v2"],
      ["--startup-scan-v2", "--root"],
      ["--startup-scan-v2", "--root", "."],
      ["--startup-scan-v2", "--root", root, "extra"],
      ["--startup-scan", "--root", root],
      ["--startup-scan-v2=false", "--root", root],
    ];

    for (const args of invalid) {
      expect(await runPawNextStartupCliV2(args), args.join(" ")).toEqual({
        exitCode: 2,
        stream: "stderr",
        text: USAGE,
      });
    }
    expect(fs.readdirSync(root)).toEqual(before);

    const child = runMockChild("invalid_args");
    expect(child.result.exitCode).toBe(2);
    expect(child.catalogFactoryCalls).toBe(0);
    expect(child.scanCalls).toBe(0);
    expect(child.resolverCalls).toBe(0);
  });

  test("a missing V2 profile still performs one read-only scan with a fixed report", async () => {
    const root = workspace();
    const before = fs.readdirSync(root);
    const result = await runPawNextStartupCliV2([
      "--startup-scan-v2",
      "--root",
      root,
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stream).toBe("stdout");
    expect(JSON.parse(result.text)).toEqual({
      schemaVersion: PAW_NEXT_STARTUP_CLI_REPORT_SCHEMA_V2,
      mode: "once",
      productCatalog: "v2",
      workspaceRoot: path.normalize(root),
      configurationIssue: {
        code: "v2_profile_configuration_unavailable",
      },
      authorityIssues: [],
      runs: [],
    });
    expect(fs.readdirSync(root)).toEqual(before);
  });

  test("an invalid absolute root reports the V2 catalog identity before creating anything", async () => {
    const missing = path.join(
      os.tmpdir(),
      `paw-startup-cli-v2-missing-${process.pid}-${Date.now()}`,
    );
    const result = await runPawNextStartupCliV2([
      "--startup-scan-v2",
      "--root",
      missing,
    ]);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.text)).toEqual({
      schemaVersion: PAW_NEXT_STARTUP_CLI_REPORT_SCHEMA_V2,
      productCatalog: "v2",
      mode: "once",
      workspaceRoot: path.normalize(missing),
      executionIssue: { reasonCode: "startup_scan_v2_failed" },
      authorityIssues: [],
      runs: [],
    });
    expect(fs.existsSync(missing)).toBeFalse();
  });

  test("uses exactly one V2-only catalog and scanner without timers", () => {
    const child = runMockChild("clean");
    expect(child.catalogFactoryCalls).toBe(1);
    expect(child.scanCalls).toBe(1);
    expect(child.resolverCalls).toBe(1);
    expect(child.sourceWasV2Only).toBeTrue();
    expect(child.timeoutCalls + child.intervalCalls).toBe(0);
    expect(child.result.exitCode).toBe(0);
    expect(JSON.parse(child.result.text)).toMatchObject({
      schemaVersion: PAW_NEXT_STARTUP_CLI_REPORT_SCHEMA_V2,
      mode: "once",
      productCatalog: "v2",
      runs: [
        { status: "terminal" },
        { status: "blocked_pending", inputIds: ["pending-input"] },
        { status: "blocked_unconsumed" },
        { status: "deferred" },
        { status: "resumed", tailSeq: 21 },
      ],
    });
  });

  test("maps every status to safe JSON and strips raw run errors", () => {
    const child = runMockChild("all_statuses");
    expect(child.result.exitCode).toBe(1);
    expect(child.result.text).not.toContain(child.secret);
    const report = JSON.parse(child.result.text) as Report;
    expect(report.productCatalog).toBe("v2");
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
        .map((run) => run.reasonCode),
    ).toEqual([
      "run_busy",
      "run_anchor_conflict",
      "run_inventory_stale",
      "run_config_unavailable",
      "run_invalid",
      "run_ambiguous_session",
      "run_failed",
    ]);
  });

  test("sanitizes catalog and scanner failures and never retries", () => {
    const configuration = runMockChild("configuration_throw");
    expect(configuration.catalogFactoryCalls).toBe(1);
    expect(configuration.scanCalls).toBe(1);
    expect(configuration.resolverCalls).toBe(0);
    expect(configuration.result.text).not.toContain(configuration.secret);
    expect(JSON.parse(configuration.result.text)).toMatchObject({
      productCatalog: "v2",
      configurationIssue: {
        code: "v2_profile_configuration_unavailable",
      },
      runs: [{ status: "config_unavailable" }],
    });

    const failed = runMockChild("scan_throw");
    expect(failed.catalogFactoryCalls).toBe(1);
    expect(failed.scanCalls).toBe(1);
    expect(failed.result.text).not.toContain(failed.secret);
    expect(JSON.parse(failed.result.text)).toEqual({
      schemaVersion: PAW_NEXT_STARTUP_CLI_REPORT_SCHEMA_V2,
      mode: "once",
      productCatalog: "v2",
      workspaceRoot: failed.workspaceRoot,
      executionIssue: { reasonCode: "startup_scan_v2_failed" },
      authorityIssues: [],
      runs: [],
    });
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
  readonly catalogFactoryCalls: number;
  readonly resolverCalls: number;
  readonly scanCalls: number;
  readonly sourceWasV2Only: boolean;
  readonly timeoutCalls: number;
  readonly intervalCalls: number;
}

interface Report {
  readonly productCatalog: string;
  readonly runs: readonly {
    readonly status: string;
    readonly reasonCode?: string;
  }[];
}

function runMockChild(scenario: string): MockChildResult {
  const root = workspace();
  const fixture = path.join(
    import.meta.dir,
    "fixtures",
    "paw-next-startup-cli-v2-mock-child.ts",
  );
  const result = spawnSync(process.execPath, [fixture, scenario, root], {
    cwd: path.resolve(import.meta.dir, ".."),
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(
      `V2 startup CLI mock child failed ${String(result.status)}: ${result.stderr}`,
    );
  }
  return {
    ...(JSON.parse(result.stdout) as MockChildResult),
    workspaceRoot: path.normalize(root),
  };
}

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-startup-cli-v2-"));
  roots.push(root);
  return root;
}
