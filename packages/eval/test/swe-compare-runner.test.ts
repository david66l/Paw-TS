import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { AgentOrchestrator } from "@paw/agent";
import type { RunEventEnvelope } from "@paw/core";
import { FakeLanguageModel } from "@paw/models";

import {
  allowSweCompareToolCall,
  auditClaudeTraceIntegrity,
  auditPawTraceIntegrity,
  auditSweCompareResult,
  claudeCodeArgs,
  collectTraceMutationHints,
  createSweCompareToolEffectPolicy,
  createSweCompareToolExecutionPolicy,
  extractClaudePatchFromTrace,
  parseClaudeStream,
  recoverClaudeResultPatch,
  recoverPawResultPatch,
  replayClaudeTracePatch,
  sweCompareLocalGoldViolation,
  sweCompareNetworkViolation,
  validateCompareRun,
} from "../src/swe-compare/runner.js";
import type { SweCompareManifest } from "../src/swe-compare/types.js";
import {
  captureGitDiff,
  createCommitWorktree,
} from "../src/swe-exp/repo-cache.js";

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "git failed").trim());
  }
  return (result.stdout ?? "").trim();
}

describe("SWE compare runner", () => {
  test("trusted mutation policy allows tracked source but rejects helpers and tests", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-swe-policy-"));
    mkdirSync(path.join(root, "src"), { recursive: true });
    mkdirSync(path.join(root, "tests"), { recursive: true });
    writeFileSync(path.join(root, "src", "app.py"), "x = 1\n", "utf8");
    writeFileSync(path.join(root, "tests", "test_app.py"), "pass\n", "utf8");
    const policy = createSweCompareToolExecutionPolicy({
      workspaceRoot: root,
      trackedFiles: new Set(["src/app.py", "tests/test_app.py"]),
    });

    expect(
      await policy({
        tool: "workspace.edit_file",
        args: { path: "src/app.py" },
        workspaceRoot: root,
      }),
    ).toEqual({ allowed: true });
    const helper = await policy({
      tool: "workspace.write_file",
      args: { path: ".paw_verify.py" },
      workspaceRoot: root,
    });
    expect(helper.allowed).toBe(false);
    if (!helper.allowed) expect(helper.reason).toBe("new_file_forbidden");
    const testEdit = await policy({
      tool: "workspace.edit_file",
      args: { path: "tests/test_app.py" },
      workspaceRoot: root,
    });
    expect(testEdit.allowed).toBe(false);
    if (!testEdit.allowed)
      expect(testEdit.reason).toBe("test_mutation_forbidden");
  });

  test("shell effect audit keeps product edits and reports them", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-swe-effect-source-"));
    git(root, ["init"]);
    git(root, ["config", "user.email", "test@example.invalid"]);
    git(root, ["config", "user.name", "Paw Test"]);
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(path.join(root, "src", "app.py"), "x = 1\n", "utf8");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "base"]);
    const policy = createSweCompareToolEffectPolicy({
      workspaceRoot: root,
      trackedFiles: new Set(["src/app.py"]),
    });
    const prepared = await policy.prepare({
      tool: "workspace.run_shell",
      args: { command: "rewrite" },
      workspaceRoot: root,
    });
    writeFileSync(path.join(root, "src", "app.py"), "x = 2\n", "utf8");
    const decision = await policy.settle(
      {
        tool: "workspace.run_shell",
        args: { command: "rewrite" },
        workspaceRoot: root,
        result: { ok: true, summary: "exit 0", payload: {} },
      },
      prepared,
    );
    expect(decision.allowed).toBe(true);
    if (decision.allowed) {
      expect(decision.result?.payload).toEqual({
        workspaceEffect: { changed: true, paths: ["src/app.py"] },
      });
    }
    expect(readFileSync(path.join(root, "src", "app.py"), "utf8")).toBe(
      "x = 2\n",
    );
  });

  test("shell effect audit restores helper and test writes atomically", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-swe-effect-deny-"));
    git(root, ["init"]);
    git(root, ["config", "user.email", "test@example.invalid"]);
    git(root, ["config", "user.name", "Paw Test"]);
    mkdirSync(path.join(root, "src"), { recursive: true });
    mkdirSync(path.join(root, "tests"), { recursive: true });
    writeFileSync(path.join(root, "src", "app.py"), "x = 1\n", "utf8");
    writeFileSync(path.join(root, "tests", "test_app.py"), "pass\n", "utf8");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "base"]);
    const policy = createSweCompareToolEffectPolicy({
      workspaceRoot: root,
      trackedFiles: new Set(["src/app.py", "tests/test_app.py"]),
    });
    const prepared = await policy.prepare({
      tool: "workspace.run_shell",
      args: { command: "bad rewrite" },
      workspaceRoot: root,
    });
    writeFileSync(path.join(root, "src", "app.py"), "x = 2\n", "utf8");
    writeFileSync(
      path.join(root, "tests", "test_app.py"),
      "assert False\n",
      "utf8",
    );
    writeFileSync(path.join(root, "helper.py"), "probe\n", "utf8");
    const decision = await policy.settle(
      {
        tool: "workspace.run_shell",
        args: { command: "bad rewrite" },
        workspaceRoot: root,
        result: { ok: true, summary: "exit 0", payload: {} },
      },
      prepared,
    );
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.recovered).toBe(true);
    expect(
      readFileSync(path.join(root, "src", "app.py"), "utf8").replace(
        /\r\n/g,
        "\n",
      ),
    ).toBe("x = 1\n");
    expect(
      readFileSync(path.join(root, "tests", "test_app.py"), "utf8").replace(
        /\r\n/g,
        "\n",
      ),
    ).toBe("pass\n");
    expect(existsSync(path.join(root, "helper.py"))).toBe(false);
  });

  test("shell effect audit removes ignored helpers introduced by a commit", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-swe-effect-history-"));
    git(root, ["init"]);
    git(root, ["config", "user.email", "test@example.invalid"]);
    git(root, ["config", "user.name", "Paw Test"]);
    writeFileSync(path.join(root, ".gitignore"), "*.probe\n", "utf8");
    writeFileSync(path.join(root, "app.py"), "x = 1\n", "utf8");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "base"]);
    const baseline = git(root, ["rev-parse", "HEAD"]);
    const policy = createSweCompareToolEffectPolicy({
      workspaceRoot: root,
      trackedFiles: new Set([".gitignore", "app.py"]),
    });
    const prepared = await policy.prepare({
      tool: "workspace.run_shell",
      args: { command: "commit helper" },
      workspaceRoot: root,
    });
    writeFileSync(path.join(root, "secret.probe"), "probe\n", "utf8");
    git(root, ["add", "-f", "secret.probe"]);
    git(root, ["commit", "-m", "bad helper"]);
    const decision = await policy.settle(
      {
        tool: "workspace.run_shell",
        args: { command: "commit helper" },
        workspaceRoot: root,
        result: { ok: true, summary: "exit 0", payload: {} },
      },
      prepared,
    );
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.recovered).toBe(true);
    expect(git(root, ["rev-parse", "HEAD"])).toBe(baseline);
    expect(existsSync(path.join(root, "secret.probe"))).toBe(false);
  });

  test("shell effect audit cleans test caches without rejecting verification", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-swe-effect-cache-"));
    git(root, ["init"]);
    git(root, ["config", "user.email", "test@example.invalid"]);
    git(root, ["config", "user.name", "Paw Test"]);
    writeFileSync(path.join(root, ".gitignore"), "__pycache__/\n", "utf8");
    writeFileSync(path.join(root, "app.py"), "x = 1\n", "utf8");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "base"]);
    const policy = createSweCompareToolEffectPolicy({
      workspaceRoot: root,
      trackedFiles: new Set([".gitignore", "app.py"]),
    });
    const prepared = await policy.prepare({
      tool: "workspace.run_shell",
      args: { command: "pytest" },
      workspaceRoot: root,
    });
    mkdirSync(path.join(root, "__pycache__"));
    writeFileSync(path.join(root, "__pycache__", "app.pyc"), "cache", "utf8");
    const decision = await policy.settle(
      {
        tool: "workspace.run_shell",
        args: { command: "pytest" },
        workspaceRoot: root,
        result: { ok: true, summary: "tests passed", payload: {} },
      },
      prepared,
    );
    expect(decision).toEqual({ allowed: true });
    expect(existsSync(path.join(root, "__pycache__", "app.pyc"))).toBe(false);
  });

  test("shell effect audit restores the ignored runner configuration baseline", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-swe-effect-config-"));
    git(root, ["init"]);
    git(root, ["config", "user.email", "test@example.invalid"]);
    git(root, ["config", "user.name", "Paw Test"]);
    writeFileSync(path.join(root, ".gitignore"), ".paw/\n", "utf8");
    writeFileSync(path.join(root, "app.py"), "x = 1\n", "utf8");
    mkdirSync(path.join(root, ".paw"));
    writeFileSync(path.join(root, ".paw", "settings.json"), "frozen\n", "utf8");
    git(root, ["add", ".gitignore", "app.py"]);
    git(root, ["commit", "-m", "base"]);
    const policy = createSweCompareToolEffectPolicy({
      workspaceRoot: root,
      trackedFiles: new Set([".gitignore", "app.py"]),
    });
    const prepared = await policy.prepare({
      tool: "workspace.run_shell",
      args: { command: "rewrite config" },
      workspaceRoot: root,
    });
    writeFileSync(
      path.join(root, ".paw", "settings.json"),
      "weakened\n",
      "utf8",
    );
    const decision = await policy.settle(
      {
        tool: "workspace.run_shell",
        args: { command: "rewrite config" },
        workspaceRoot: root,
        result: { ok: true, summary: "exit 0", payload: {} },
      },
      prepared,
    );
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.recovered).toBe(true);
    expect(readFileSync(path.join(root, ".paw", "settings.json"), "utf8")).toBe(
      "frozen\n",
    );
  });

  test("orchestrator rejects and restores a real shell helper write", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-swe-effect-e2e-"));
    git(root, ["init"]);
    git(root, ["config", "user.email", "test@example.invalid"]);
    git(root, ["config", "user.name", "Paw Test"]);
    writeFileSync(path.join(root, "app.py"), "x = 1\n", "utf8");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "base"]);
    const events: RunEventEnvelope[] = [];
    let calls = 0;
    const helperCommand =
      process.platform === "win32"
        ? "cmd /c echo probe>helper.py"
        : "printf probe > helper.py";
    const orchestrator = new AgentOrchestrator({
      model: {
        label: "shell-effect-e2e",
        async complete() {
          calls += 1;
          if (calls === 1) {
            return {
              text: JSON.stringify({
                tool: "workspace.run_shell",
                args: { command: helperCommand },
              }),
            };
          }
          return {
            text: JSON.stringify({
              action: "final_answer",
              summary: "The prohibited helper write was rejected.",
            }),
          };
        },
      },
      auxiliaryModel: new FakeLanguageModel(),
      toolEffectPolicy: createSweCompareToolEffectPolicy({
        workspaceRoot: root,
        trackedFiles: new Set(["app.py"]),
      }),
      onEvent: (event) => events.push(event),
    });
    await orchestrator.run({
      runId: "shell-effect-e2e",
      goal: "Run the requested local check without creating helper files.",
      workspaceRoot: root,
      maxSteps: 4,
    });
    expect(existsSync(path.join(root, "helper.py"))).toBe(false);
    const toolSummaries = events.flatMap((event) =>
      event.event.type === "tool.result" ? [event.event.summary] : [],
    );
    expect(toolSummaries).toContainEqual(
      expect.stringContaining(
        "ToolEffectPolicy:prohibited_workspace_effect_recovered",
      ),
    );
  });

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
    expect(args).toContain("--disallowedTools");
    expect(args[args.indexOf("--disallowedTools") + 1]).toContain(
      "Bash(* curl *)",
    );
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
              input: { command: "cd repo && git diff --binary" },
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

  test("replays Claude's successful edits and later source resets", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-claude-replay-"));
    git(root, ["init"]);
    git(root, ["config", "user.email", "test@example.invalid"]);
    git(root, ["config", "user.name", "Paw Test"]);
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(path.join(root, "src", "keep.py"), "old\n", "utf8");
    writeFileSync(path.join(root, "src", "reset.py"), "base\n", "utf8");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "base"]);
    const toolUse = (
      id: string,
      file: string,
      oldText: string,
      newText: string,
    ) => ({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id,
            name: "Edit",
            input: {
              file_path: `C:\\tmp\\task\\wt\\src\\${file}`,
              old_string: oldText,
              new_string: newText,
              replace_all: false,
            },
          },
        ],
      },
    });
    const result = (id: string) => ({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: id, content: "ok" }],
      },
    });
    const trace = [
      toolUse("keep", "keep.py", "old", "new"),
      result("keep"),
      toolUse("reset", "reset.py", "base", "temporary"),
      result("reset"),
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "checkout",
              name: "Bash",
              input: {
                command:
                  "cd repo && git checkout -- src/reset.py && git status",
              },
            },
          ],
        },
      },
      result("checkout"),
    ];
    const replayed = replayClaudeTracePatch(trace, root);
    expect(replayed.error).toBeUndefined();
    expect(replayed.diff).toContain("src/keep.py");
    expect(replayed.diff).not.toContain("src/reset.py");
    expect(
      readFileSync(path.join(root, "src", "reset.py"), "utf8").replace(
        /\r\n/g,
        "\n",
      ),
    ).toBe("base\n");
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

  test("invalidates an unrecovered Paw workspace-effect failure", () => {
    expect(
      auditPawTraceIntegrity([
        {
          event: {
            type: "tool.result",
            tool: "workspace.run_shell",
            ok: false,
            summary:
              "[ToolEffectPolicy:prohibited_workspace_effect_unrecovered] rollback failed",
          },
        },
      ]),
    ).toEqual({
      valid: false,
      violations: ["workspace_effect_policy_failure"],
    });
  });

  test("does not invalidate network commands denied before execution", () => {
    const deniedClaude = [
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "blocked",
              name: "Bash",
              input: { command: "curl https://example.test/fix.patch" },
            },
          ],
        },
      },
      {
        type: "system",
        subtype: "permission_denied",
        tool_use_id: "blocked",
      },
    ];
    expect(auditClaudeTraceIntegrity(deniedClaude)).toEqual({
      valid: true,
      violations: [],
    });
    expect(
      auditPawTraceIntegrity([
        {
          event: {
            type: "tool.call",
            tool: "workspace.run_shell",
            args: { command: "git fetch origin main" },
          },
        },
        {
          event: {
            type: "tool.result",
            tool: "workspace.run_shell",
            ok: false,
            summary: "tool execution denied by user",
          },
        },
      ]),
    ).toEqual({ valid: true, violations: [] });
  });

  test("blocks benchmark network tools before execution but permits offline/local work", () => {
    expect(sweCompareNetworkViolation("git fetch origin main")).toBe(
      "upstream_network_git_access",
    );
    expect(
      sweCompareNetworkViolation(
        "cd /tmp && curl https://github.com/org/repo/pull/1.diff",
      ),
    ).toBe("outbound_network_command");
    expect(sweCompareNetworkViolation("python -m pip install scipy")).toBe(
      "outbound_dependency_install",
    );
    expect(
      sweCompareNetworkViolation(
        "C:\\Python310\\python.exe -m pip install scipy",
      ),
    ).toBe("outbound_dependency_install");
    expect(
      sweCompareNetworkViolation(
        "python -c \"import requests; requests.get('https://example.test')\"",
      ),
    ).toBe("outbound_network_command");
    expect(
      sweCompareNetworkViolation(
        "python -m pip install --no-index --find-links wheels scipy",
      ),
    ).toBeUndefined();
    expect(
      sweCompareNetworkViolation("pytest tests/test_local.py"),
    ).toBeUndefined();
    expect(
      allowSweCompareToolCall({
        tool: "workspace.run_shell",
        args: { command: "wget https://example.test/fix.patch" },
      }),
    ).toBe(false);
    expect(
      allowSweCompareToolCall({
        tool: "workspace.run_shell",
        args: { command: "python -m pytest tests/test_local.py" },
      }),
    ).toBe(true);
    expect(
      sweCompareLocalGoldViolation(
        "diff repo/a.py C:/Python/Lib/site-packages/project/a.py",
      ),
    ).toBe("installed_future_source_access");
    expect(
      sweCompareLocalGoldViolation(
        "pyarrow.ipc.open_stream('C:/Users/me/.cache/huggingface/swe-bench_lite-test.arrow'); row['test_patch']",
      ),
    ).toBe("benchmark_gold_data_access");
    expect(
      allowSweCompareToolCall({
        tool: "workspace.run_shell",
        args: { command: "grep -R fix /usr/lib/python/site-packages/project" },
      }),
    ).toBe(false);
    expect(
      allowSweCompareToolCall({
        tool: "workspace.edit_file",
        args: { path: "src/a.py" },
      }),
    ).toBe(true);
  });

  test("invalidates successful Claude access to local future source or gold data", () => {
    const tool = (
      id: string,
      name: string,
      input: Record<string, unknown>,
    ) => ({
      type: "assistant",
      message: { content: [{ type: "tool_use", id, name, input }] },
    });
    const result = (id: string) => ({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: id, content: "ok" }],
      },
    });
    expect(
      auditClaudeTraceIntegrity([
        tool("read", "Read", {
          file_path:
            "C:/Python/Lib/site-packages/sympy/physics/vector/point.py",
        }),
        result("read"),
        tool("gold", "Bash", {
          command:
            "python -c \"import pyarrow; row['test_patch']\" C:/Users/me/.cache/huggingface/swe-bench_lite-test.arrow",
        }),
        result("gold"),
      ]),
    ).toEqual({
      valid: false,
      violations: [
        "benchmark_gold_data_access",
        "installed_future_source_access",
      ],
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
      expect(git(workspace.root, ["config", "--local", "core.autocrlf"])).toBe(
        "false",
      );
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

  test("patch capture ignores a configured external diff command", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-swe-diff-"));
    git(root, ["init"]);
    git(root, ["config", "user.email", "eval@example.test"]);
    git(root, ["config", "user.name", "Eval"]);
    writeFileSync(path.join(root, "value.txt"), "base\n", "utf8");
    git(root, ["add", "value.txt"]);
    git(root, ["commit", "-m", "base"]);
    git(root, ["config", "diff.external", "definitely-missing-paw-diff"]);
    writeFileSync(path.join(root, "value.txt"), "changed\n", "utf8");
    const captured = captureGitDiff(root);
    expect(captured.error).toBeUndefined();
    expect(captured.diff).toContain("+changed");
  });

  test("captures an explicit edited path directly from HEAD and the file", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-swe-explicit-diff-"));
    git(root, ["init"]);
    git(root, ["config", "user.email", "eval@example.test"]);
    git(root, ["config", "user.name", "Eval"]);
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(path.join(root, "src", "value.py"), "value = 1\n", "utf8");
    git(root, ["add", "src/value.py"]);
    git(root, ["commit", "-m", "base"]);
    writeFileSync(path.join(root, "src", "value.py"), "value = 2\n", "utf8");
    const captured = captureGitDiff(root, ["src/value.py"]);
    expect(captured.error).toBeUndefined();
    expect(captured.diff).toContain("diff --git a/src/value.py b/src/value.py");
    expect(captured.diff).toContain("-value = 1");
    expect(captured.diff).toContain("+value = 2");
  });

  test("uses explicit edited paths and recognizes a read-only Paw trace", () => {
    const root = path.join(tmpdir(), "paw-workspace");
    expect(
      collectTraceMutationHints({
        runner: "paw",
        workspaceRoot: root,
        trace: [
          {
            event: {
              type: "tool.call",
              tool: "workspace.read_file",
              args: { path: "src/a.py" },
            },
          },
        ],
      }),
    ).toEqual({ explicitPaths: [], unknownWritePossible: false });
    expect(
      collectTraceMutationHints({
        runner: "paw",
        workspaceRoot: root,
        trace: [
          {
            event: {
              type: "tool.call",
              tool: "workspace.edit_file",
              args: { path: "doc/probe.rst" },
            },
          },
          {
            event: {
              type: "tool.result",
              tool: "workspace.edit_file",
              ok: true,
              fileChanges: [],
            },
          },
        ],
      }),
    ).toEqual({ explicitPaths: [], unknownWritePossible: false });
    expect(
      collectTraceMutationHints({
        runner: "claude",
        workspaceRoot: root,
        trace: [
          {
            type: "assistant",
            message: {
              content: [
                {
                  type: "tool_use",
                  name: "Edit",
                  input: { file_path: path.join(root, "src", "a.py") },
                },
                {
                  type: "tool_use",
                  name: "Bash",
                  input: { command: "pytest src/test_a.py 2>&1" },
                },
              ],
            },
          },
        ],
      }),
    ).toEqual({ explicitPaths: ["src/a.py"], unknownWritePossible: false });
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

  test("replays only a paired successful Paw edit to recover a patch", () => {
    const repoRoot = path.resolve(import.meta.dir, "../../..");
    const runDir = mkdtempSync(path.join(tmpdir(), "paw-edit-replay-result-"));
    const tracePath = path.join(runDir, "trace.json");
    const resultPath = path.join(runDir, "result.json");
    writeFileSync(
      tracePath,
      JSON.stringify([
        {
          event: {
            type: "tool.call",
            tool: "workspace.edit_file",
            args: {
              path: "verify_tmp.py",
              old_string: "old",
              new_string: "new",
            },
          },
        },
        {
          event: {
            type: "tool.result",
            tool: "workspace.edit_file",
            ok: true,
          },
        },
        {
          event: {
            type: "tool.call",
            tool: "workspace.run_shell",
            args: { command: "del verify_tmp.py 2>nul" },
          },
        },
        {
          event: {
            type: "tool.result",
            tool: "workspace.run_shell",
            ok: true,
          },
        },
        {
          event: {
            type: "tool.call",
            tool: "workspace.edit_file",
            args: {
              path: "sklearn/utils/multiclass.py",
              old_string: "from collections.abc import Sequence",
              new_string: "from collections.abc import Sequence  # replay",
            },
          },
        },
        {
          event: {
            type: "tool.result",
            tool: "workspace.edit_file",
            ok: true,
          },
        },
      ]),
      "utf8",
    );
    writeFileSync(
      resultPath,
      JSON.stringify({
        schemaVersion: 1,
        runId: "paw-replay-test",
        runner: "paw",
        instanceId: "scikit-learn__scikit-learn-25638",
        patch: "",
        patchChars: 0,
        patchSource: "none",
        artifactStatus: "patch_collection_failed",
        resolved: false,
        resolvedSource: "none",
        tracePath,
      }),
      "utf8",
    );
    const updated = recoverPawResultPatch({ repoRoot, resultPath });
    expect(updated.patchSource).toBe("paw_trace_edit_replay");
    expect(updated.artifactStatus).toBe("valid");
    expect(updated.patch).toContain("Sequence  # replay");
  }, 15_000);

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
