import { describe, expect, test } from "bun:test";
import {
  TaskStateManager,
  formatCompletionReadiness,
  formatTaskStateForContext,
  isVerificationCommand,
} from "../src/task-state.js";

describe("TaskStateManager", () => {
  test("does not record control-plane rejections as task failures", () => {
    const state = new TaskStateManager("fix bug");
    state.recordToolResult(
      {
        type: "tool_call",
        tool: "workspace.read_file",
        args: { path: "src/a.ts" },
      },
      {
        ok: false,
        payload: { code: "E_LOOP_POLICY" },
        summary: "[LoopPolicy:implementation_required] edit now",
      },
    );
    expect(state.snapshot().filesRead).toEqual([]);
    expect(state.snapshot().pinnedFacts).toEqual([]);

    state.recordToolResult(
      {
        type: "tool_call",
        tool: "workspace.run_shell",
        args: { command: "python helper.py" },
      },
      {
        ok: false,
        summary: "effect rejected",
        payload: { code: "E_TOOL_EFFECT_POLICY" },
      },
    );
    expect(state.snapshot().commandsRun).toEqual([]);
    expect(state.snapshot().pinnedFacts).toEqual([]);
  });

  test("records file and test tool facts", () => {
    const state = new TaskStateManager("must keep changes minimal");

    state.recordToolResult(
      {
        type: "tool_call",
        tool: "workspace.read_file",
        args: { path: "src/a.ts" },
      },
      { ok: true, summary: "read_file: src/a.ts", payload: {} },
    );
    state.recordToolResult(
      {
        type: "tool_call",
        tool: "workspace.edit_file",
        args: { path: "src/a.ts" },
      },
      {
        ok: true,
        summary: "edit_file: src/a.ts +1/-1",
        payload: { path: "src/a.ts", linesAdded: 1, linesRemoved: 1 },
      },
    );
    state.recordToolResult(
      {
        type: "tool_call",
        tool: "workspace.run_shell",
        args: { command: "bun test packages/agent/test/task-state.test.ts" },
      },
      { ok: true, summary: "run_shell: exit 0", payload: {} },
    );
    state.recordToolResult(
      {
        type: "tool_call",
        tool: "workspace.run_shell",
        args: { command: "bun run bad" },
      },
      { ok: false, summary: "run_shell: exit 1", payload: {} },
    );

    const snapshot = state.snapshot();
    expect(
      snapshot.constraints.some((c) => c.text === "must keep changes minimal"),
    ).toBe(true);
    expect(state.activeConstraints()[0]?.text).toBe(
      "must keep changes minimal",
    );
    expect(snapshot.filesRead).toContain("src/a.ts");
    expect(snapshot.filesChanged).toContain("src/a.ts");
    expect(snapshot.commandsRun).toHaveLength(2);
    expect(snapshot.shellCommandRevision).toBe(2);
    expect(snapshot.mutationShellCommandRevision).toBe(0);
    expect(snapshot.testResults[0]?.passed).toBe(true);
    expect(snapshot.pinnedFacts[0]).toContain("workspace.run_shell failed");

    const restored = new TaskStateManager("ignored", snapshot);
    expect(restored.snapshot().filesChanged).toContain("src/a.ts");
    expect(formatTaskStateForContext(snapshot)).toContain("Files changed");
  });

  test("tracks verification and diff against the exact mutation revision", () => {
    const state = new TaskStateManager("fix bug");
    const edit = () =>
      state.recordToolResult(
        {
          type: "tool_call",
          tool: "workspace.edit_file",
          args: { path: "a.py" },
        },
        {
          ok: true,
          summary: "edited",
          payload: { path: "a.py", linesAdded: 1, linesRemoved: 1 },
        },
      );
    edit();
    state.recordToolResult(
      {
        type: "tool_call",
        tool: "workspace.run_shell",
        args: { command: "py -3.10 -m pytest tests/test_a.py -q" },
      },
      { ok: true, summary: "1 passed", payload: {} },
    );
    state.recordToolResult(
      { type: "tool_call", tool: "workspace.git_diff", args: {} },
      { ok: true, summary: "diff", payload: {} },
    );
    expect(formatCompletionReadiness(state.snapshot())).toEqual([
      "Completion readiness:",
      "- Verification: passed for r1",
      "- Final diff: inspected for r1",
    ]);
    edit();
    expect(formatCompletionReadiness(state.snapshot())).toEqual([
      "Completion readiness:",
      "- Verification: stale (verified r1)",
      "- Final diff: stale (inspected r1)",
    ]);
    expect(isVerificationCommand("py -3.10 -m pytest tests -q")).toBe(true);
    expect(isVerificationCommand("pip install pytest")).toBe(false);
  });

  test("separates verification harness failures from code failures", () => {
    const harness = new TaskStateManager("fix bug");
    harness.recordToolResult(
      {
        type: "tool_call",
        tool: "workspace.edit_file",
        args: { path: "a.py" },
      },
      {
        ok: true,
        summary: "edited",
        payload: { path: "a.py", linesAdded: 1, linesRemoved: 1 },
      },
    );
    harness.recordToolResult(
      {
        type: "tool_call",
        tool: "workspace.run_shell",
        args: { command: "pytest tests/test_a.py -q" },
      },
      {
        ok: false,
        summary: "run_shell: exit 1",
        payload: {
          exit_code: 1,
          stderr:
            "Error importing plugin x: ModuleNotFoundError: No module named 'project' token=secret-value",
        },
      },
    );
    const harnessResult = harness.snapshot().testResults.at(-1);
    expect(harnessResult?.outcome).toBe("harness_failed");
    expect(harnessResult?.evidence).toContain("Error importing plugin");
    expect(harnessResult?.evidence).not.toContain("secret-value");
    expect(formatCompletionReadiness(harness.snapshot())[1]).toContain(
      "harness failed",
    );

    const code = new TaskStateManager("fix bug");
    code.recordToolResult(
      {
        type: "tool_call",
        tool: "workspace.edit_file",
        args: { path: "a.py" },
      },
      {
        ok: true,
        summary: "edited",
        payload: { path: "a.py", linesAdded: 1, linesRemoved: 1 },
      },
    );
    code.recordToolResult(
      {
        type: "tool_call",
        tool: "workspace.run_shell",
        args: { command: "pytest tests/test_a.py -q" },
      },
      {
        ok: false,
        summary: "run_shell: exit 1",
        payload: { exit_code: 1, stdout: "FAILED test_value - assert 1 == 2" },
      },
    );
    expect(code.snapshot().testResults.at(-1)?.outcome).toBe("code_failed");
  });

  test("keeps a monotonic shell revision when retained command history rolls over", () => {
    const state = new TaskStateManager("fix bug");
    for (let index = 0; index < 25; index += 1) {
      state.recordToolResult(
        {
          type: "tool_call",
          tool: "workspace.run_shell",
          args: { command: `echo ${index}` },
        },
        { ok: true, summary: "ok", payload: {} },
      );
    }
    expect(state.snapshot().commandsRun).toHaveLength(20);
    expect(state.snapshot().shellCommandRevision).toBe(25);
    state.recordToolResult(
      {
        type: "tool_call",
        tool: "workspace.edit_file",
        args: { path: "a.py" },
      },
      {
        ok: true,
        summary: "edited",
        payload: { path: "a.py", linesAdded: 1, linesRemoved: 1 },
      },
    );
    expect(state.snapshot().mutationShellCommandRevision).toBe(25);
  });

  test("does not advance mutation state for a successful-looking no-op edit", () => {
    const state = new TaskStateManager("fix bug");
    state.recordToolResult(
      {
        type: "tool_call",
        tool: "workspace.edit_file",
        args: { path: "a.py", old_string: "same", new_string: "same" },
      },
      {
        ok: true,
        summary: "edit_file: a.py +0/-0",
        payload: {
          path: "a.py",
          changed: false,
          linesAdded: 0,
          linesRemoved: 0,
        },
      },
    );
    expect(state.snapshot().mutationRevision).toBe(0);
    expect(state.snapshot().filesChanged).toEqual([]);
  });

  test("records a trusted shell workspace effect as a source mutation", () => {
    const state = new TaskStateManager("fix bug");
    state.recordToolResult(
      {
        type: "tool_call",
        tool: "workspace.run_shell",
        args: { command: "python rewrite.py" },
      },
      {
        ok: true,
        summary: "run_shell: exit 0",
        payload: {
          workspaceEffect: { changed: true, paths: ["src/a.py"] },
        },
      },
    );
    expect(state.snapshot().mutationRevision).toBe(1);
    expect(state.snapshot().mutationShellCommandRevision).toBe(1);
    expect(state.snapshot().filesChanged).toEqual(["src/a.py"]);
  });

  test("records a shell mutation even when the process exits unsuccessfully", () => {
    const state = new TaskStateManager("fix bug");
    state.recordToolResult(
      {
        type: "tool_call",
        tool: "workspace.run_shell",
        args: { command: "python rewrite_then_fail.py" },
      },
      {
        ok: false,
        summary: "run_shell: exit 1",
        payload: {
          workspaceEffect: { changed: true, paths: ["src/a.py"] },
        },
      },
    );
    expect(state.snapshot().mutationRevision).toBe(1);
    expect(state.snapshot().filesChanged).toEqual(["src/a.py"]);
    expect(state.snapshot().pinnedFacts).toEqual([
      "workspace.run_shell failed: run_shell: exit 1",
    ]);
  });

  test("retains an unrecovered effect-policy failure as task evidence", () => {
    const state = new TaskStateManager("fix bug");
    state.recordToolResult(
      {
        type: "tool_call",
        tool: "workspace.run_shell",
        args: { command: "bad command" },
      },
      {
        ok: false,
        summary: "[ToolEffectPolicy:settle_failed] rollback failed",
        payload: {
          code: "E_TOOL_EFFECT_POLICY",
          recovered: false,
        },
      },
    );
    expect(state.snapshot().commandsRun).toHaveLength(1);
    expect(state.snapshot().pinnedFacts[0]).toContain("rollback failed");
  });

  test("retains one exact target after an edit anchor failure", () => {
    const state = new TaskStateManager("fix bug");
    state.recordToolResult(
      {
        type: "tool_call",
        tool: "workspace.edit_file",
        args: { path: "src/a.py", old_string: "old", new_string: "new" },
      },
      {
        ok: false,
        summary: "edit_file: E_USER old_string not found in src/a.py",
        payload: { error_code: "E_USER" },
      },
    );
    expect(state.snapshot().editRecoveryPath).toBe("src/a.py");
    state.recordToolResult(
      {
        type: "tool_call",
        tool: "workspace.read_file",
        args: { path: "src/a.py" },
      },
      { ok: true, summary: "read", payload: {} },
    );
    expect(state.snapshot().editRecoveryPath).toBeUndefined();
  });
});
