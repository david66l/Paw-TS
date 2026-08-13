import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  auditClaudeTraceIntegrity,
  auditPawTraceIntegrity,
  auditSweCompareResult,
  claudeCodeArgs,
  extractClaudePatchFromTrace,
  parseClaudeStream,
  recoverClaudeResultPatch,
  validateCompareRun,
} from "../src/swe-compare/runner.js";
import type { SweCompareManifest } from "../src/swe-compare/types.js";
import { createCommitWorktree } from "../src/swe-exp/repo-cache.js";

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "git failed").trim());
  }
  return (result.stdout ?? "").trim();
}

describe("SWE compare runner", () => {
  test("Claude Code command freezes clean 1M max-effort mode", () => {
    const goal = "neutral task";
    const args = claudeCodeArgs(goal);
    expect(args).toContain("--bare");
    expect(args).toContain("deepseek-v4-flash[1m]");
    expect(args).toContain("max");
    expect(args).toContain("1m");
    expect(args).toContain("--no-session-persistence");
    expect(args).toContain("--disable-slash-commands");
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).toContain("stream-json");
    expect(args).toContain("--verbose");
    const toolsIndex = args.indexOf("--tools");
    expect(args[toolsIndex + 2]?.startsWith("--")).toBe(true);
    expect(args.at(-1)).toBe(goal);
  });

  test("Claude stream keeps tool events but never persists thinking", () => {
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init", model: "deepseek" }),
      JSON.stringify({
        type: "system",
        subtype: "thinking_tokens",
        estimated_tokens: 10,
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "private chain" },
            { type: "tool_use", name: "Read", input: { file_path: "x" } },
          ],
        },
      }),
      JSON.stringify({
        type: "result",
        is_error: false,
        num_turns: 1,
        terminal_reason: "completed",
      }),
    ].join("\n");
    const parsed = parseClaudeStream(stdout);
    expect(parsed.result.terminal_reason).toBe("completed");
    expect(JSON.stringify(parsed.trace)).toContain("tool_use");
    expect(JSON.stringify(parsed.trace)).not.toContain("private chain");
    expect(JSON.stringify(parsed.trace)).not.toContain("thinking_tokens");
  });

  test("recovers only a diff returned by a paired git diff tool call", () => {
    const trace = [
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "wrong",
              name: "Bash",
              input: { command: "cat patch.txt" },
            },
            {
              type: "tool_use",
              id: "right",
              name: "Bash",
              input: { command: "git diff --binary" },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "wrong",
              content: "diff --git fake",
            },
            {
              type: "tool_result",
              tool_use_id: "right",
              content: "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py",
            },
          ],
        },
      },
    ];
    expect(extractClaudePatchFromTrace(trace)).toBe(
      "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py",
    );
  });

  test("invalidates a trace that fetches and inspects an upstream fix", () => {
    const trace = [
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "fetch",
              name: "Bash",
              input: {
                command:
                  "git fetch origin main && git show origin/main:src/fix.py",
              },
            },
          ],
        },
      },
    ];
    expect(auditClaudeTraceIntegrity(trace)).toEqual({
      valid: false,
      violations: [
        "upstream_network_git_access",
        "upstream_history_inspection",
      ],
    });
    expect(
      auditClaudeTraceIntegrity([
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "local",
                name: "Bash",
                input: { command: "git diff -- src/fix.py" },
              },
            ],
          },
        },
      ]),
    ).toEqual({ valid: true, violations: [] });
  });

  test("audits Paw shell calls with the same no-network rule", () => {
    expect(
      auditPawTraceIntegrity([
        {
          event: {
            type: "tool.call",
            tool: "workspace.run_shell",
            args: { command: "git clone https://example.test/repo.git" },
          },
        },
      ]),
    ).toEqual({
      valid: false,
      violations: ["upstream_network_git_access"],
    });
  });

  test("isolated benchmark checkout has no remote or future commit objects", () => {
    const source = mkdtempSync(path.join(tmpdir(), "paw-swe-source-"));
    git(source, ["init"]);
    git(source, ["config", "user.email", "eval@example.test"]);
    git(source, ["config", "user.name", "Eval"]);
    writeFileSync(path.join(source, "value.txt"), "base\n", "utf8");
    git(source, ["add", "value.txt"]);
    git(source, ["commit", "-m", "base"]);
    const base = git(source, ["rev-parse", "HEAD"]);
    writeFileSync(path.join(source, "value.txt"), "future\n", "utf8");
    git(source, ["commit", "-am", "future"]);
    const future = git(source, ["rev-parse", "HEAD"]);

    const workspace = createCommitWorktree(source, base, "isolation-test");
    try {
      expect(git(workspace.root, ["remote"])).toBe("");
      expect(git(workspace.root, ["rev-parse", "HEAD"])).toBe(base);
      const leaked = spawnSync(
        "git",
        ["cat-file", "-e", `${future}^{commit}`],
        {
          cwd: workspace.root,
          encoding: "utf8",
        },
      );
      expect(leaked.status).not.toBe(0);
    } finally {
      workspace.cleanup();
    }
  });

  test("backfills an empty persisted Claude result without resampling", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-claude-recover-"));
    const runDir = path.join(root, "benchmarks", "swe-compare", "runs", "demo");
    mkdirSync(runDir, { recursive: true });
    const tracePath = path.join(runDir, "trace.json");
    const resultPath = path.join(runDir, "result.json");
    writeFileSync(
      tracePath,
      JSON.stringify([
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "diff",
                name: "Bash",
                input: { command: "git diff" },
              },
            ],
          },
        },
        {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "diff",
                content: "diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py",
              },
            ],
          },
        },
      ]),
      "utf8",
    );
    writeFileSync(
      resultPath,
      JSON.stringify({
        schemaVersion: 1,
        runId: "demo",
        runner: "claude",
        patch: "",
        patchChars: 0,
        tracePath: path.relative(root, tracePath).replace(/\\/g, "/"),
      }),
      "utf8",
    );
    const updated = recoverClaudeResultPatch({ repoRoot: root, resultPath });
    expect(updated.patchChars).toBeGreaterThan(0);
    expect(updated.patchSource).toBe("claude_trace_git_diff");
  });

  test("backfills integrity and invalidates a leaked persisted result", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-claude-audit-"));
    const runDir = path.join(root, "benchmarks", "swe-compare", "runs", "demo");
    mkdirSync(runDir, { recursive: true });
    const tracePath = path.join(runDir, "trace.json");
    const resultPath = path.join(runDir, "result.json");
    writeFileSync(
      tracePath,
      JSON.stringify([
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "fetch",
                name: "Bash",
                input: { command: "git fetch origin main" },
              },
            ],
          },
        },
      ]),
      "utf8",
    );
    writeFileSync(
      resultPath,
      JSON.stringify({
        schemaVersion: 1,
        runId: "demo",
        runner: "claude",
        patch: "diff --git a/a b/a",
        patchChars: 18,
        resolved: true,
        resolvedSource: "swebench_harness",
        tracePath: path.relative(root, tracePath).replace(/\\/g, "/"),
      }),
      "utf8",
    );
    const updated = auditSweCompareResult({ repoRoot: root, resultPath });
    expect(updated.integrity).toEqual({
      valid: false,
      violations: ["upstream_network_git_access"],
    });
    expect(updated.resolved).toBe(false);
    expect(updated.resolvedSource).toBe("none");
  });

  test("refuses to run when the current source tree is dirty", () => {
    const repoRoot = path.resolve(import.meta.dir, "../../..");
    const manifest = JSON.parse(
      readFileSync(
        path.join(
          repoRoot,
          "benchmarks",
          "swe-compare",
          "manifests",
          // An existing ignored runtime artifact is sufficient here; this test
          // fails on dirty-tree validation before selection metadata is read.
          "smoke-v1.json",
        ),
        "utf8",
      ),
    ) as SweCompareManifest;
    const instanceId = manifest.instances[0]?.instanceId;
    if (!instanceId) throw new Error("test manifest has no instances");
    expect(() => validateCompareRun(repoRoot, manifest, instanceId)).toThrow(
      "current source tree is dirty",
    );
  });
});
