import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mainTs = path.resolve(__dirname, "../src/main.ts");
const LEGACY_USAGE = `paw-ts — Paw TypeScript CLI (canonical). Python \`paw\` is legacy/reference only.

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
`;

describe("paw-ts CLI", () => {
  test("--version exits 0 with expected line", () => {
    const r = spawnSync(process.execPath, [mainTs, "--version"], {
      encoding: "utf8",
      env: process.env,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("0.0.1-ts.0\n");
    expect(r.stderr).toBe("");
  });

  test("--help preserves the pre-feature usage bytes", () => {
    const r = spawnSync(process.execPath, [mainTs, "--help"], {
      encoding: "utf8",
      env: process.env,
    });
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(`${LEGACY_USAGE}\n`);
  });

  test("a bare paw-next command remains on the legacy usage path", () => {
    const r = spawnSync(process.execPath, [mainTs, "paw-next"], {
      encoding: "utf8",
      env: process.env,
    });
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(`${LEGACY_USAGE}\n`);
  });

  test("the explicit absolute-root gate scans once and leaves an empty workspace unchanged", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-cli-startup-"));
    const before = fs.readdirSync(root);
    try {
      const r = spawnSync(
        process.execPath,
        [mainTs, "paw-next", "--startup-scan", "--root", root],
        { encoding: "utf8", env: process.env },
      );
      expect(r.status).toBe(1);
      expect(r.stderr).toBe("");
      expect(JSON.parse(r.stdout) as unknown).toEqual({
        schemaVersion: "paw.next-startup-cli-report.v1",
        mode: "once",
        workspaceRoot: path.normalize(root),
        configurationIssue: {
          code: "profile_configuration_unavailable",
        },
        authorityIssues: [],
        runs: [],
      });
      expect(fs.readdirSync(root)).toEqual(before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("the explicit V2-only gate scans once and preserves an empty workspace", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-cli-startup-v2-"));
    const before = fs.readdirSync(root);
    try {
      const r = spawnSync(
        process.execPath,
        [mainTs, "paw-next", "--startup-scan-v2", "--root", root],
        { encoding: "utf8", env: process.env },
      );
      expect(r.status).toBe(1);
      expect(r.stderr).toBe("");
      expect(JSON.parse(r.stdout) as unknown).toEqual({
        schemaVersion: "paw.next-startup-cli-report.v2",
        productCatalog: "v2",
        mode: "once",
        workspaceRoot: path.normalize(root),
        configurationIssue: {
          code: "v2_profile_configuration_unavailable",
        },
        authorityIssues: [],
        runs: [],
      });
      expect(fs.readdirSync(root)).toEqual(before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("the explicit V3-only gate scans once without reporting the workspace path", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-cli-startup-v3-"));
    const before = fs.readdirSync(root);
    try {
      const r = spawnSync(
        process.execPath,
        [mainTs, "paw-next", "--startup-scan-v3", "--root", root],
        { encoding: "utf8", env: process.env },
      );
      expect(r.status).toBe(1);
      expect(r.stderr).toBe("");
      expect(JSON.parse(r.stdout) as unknown).toEqual({
        schemaVersion: "paw.next-startup-cli-report.v3",
        productCatalog: "v3",
        mode: "once",
        configurationIssue: {
          code: "v3_profile_configuration_unavailable",
        },
        authorityIssues: [],
        runs: [],
      });
      expect(r.stdout).not.toContain(root);
      expect(fs.readdirSync(root)).toEqual(before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("the explicit V3 new-work gate reads only stdin JSON and reports no body or path", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-cli-new-work-v3-"));
    const before = fs.readdirSync(root);
    const privateContent = "private new work body";
    try {
      const r = spawnSync(
        process.execPath,
        [
          mainTs,
          "paw-next",
          "--new-work-v3",
          "--root",
          root,
          "--session-id",
          "session-v3",
          "--run-id",
          "run-v3",
          "--input-id",
          "input-v3",
          "--caller-id",
          "caller-v3",
          "--stdin-json",
        ],
        {
          encoding: "utf8",
          env: process.env,
          input: JSON.stringify({ content: privateContent }),
        },
      );
      expect(r.status).toBe(1);
      expect(r.stderr).toBe("");
      expect(JSON.parse(r.stdout) as unknown).toEqual({
        schemaVersion: "paw.next-new-work-cli-report.v1",
        productCatalog: "v3",
        mode: "once",
        sessionId: "session-v3",
        runId: "run-v3",
        inputId: "input-v3",
        outcome: "failed",
        reasonCode: "configuration_unavailable",
      });
      expect(r.stdout).not.toContain(root);
      expect(r.stdout).not.toContain("caller-v3");
      expect(r.stdout).not.toContain(privateContent);
      expect(fs.readdirSync(root)).toEqual(before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("main keeps all exact Paw Next gates behind distinct lazy imports", () => {
    const source = fs.readFileSync(mainTs, "utf8");
    expect(source).not.toMatch(/^import .*paw-next/m);
    expect(
      source.match(/import\(\s*["']\.\/paw-next\/startup-cli\.js["']\s*\)/g),
    ).toHaveLength(1);
    expect(
      source.match(/import\(\s*["']\.\/paw-next\/startup-cli-v2\.js["']\s*\)/g),
    ).toHaveLength(1);
    expect(
      source.match(/import\(\s*["']\.\/paw-next\/startup-cli-v3\.js["']\s*\)/g),
    ).toHaveLength(1);
    expect(
      source.match(
        /import\(\s*["']\.\/paw-next\/new-work-cli-v3\.js["']\s*\)/g,
      ),
    ).toHaveLength(1);
    expect(source).toContain(
      'argv[0] === "paw-next" && argv[1] === "--startup-scan-v2"',
    );
    expect(source).toContain(
      'argv[0] === "paw-next" && argv[1] === "--startup-scan-v3"',
    );
    expect(source).toContain(
      'argv[0] === "paw-next" && argv[1] === "--new-work-v3"',
    );
  });
});
