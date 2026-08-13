import { describe, expect, test } from "bun:test";
import {
  TaskStateManager,
  formatCompletionReadiness,
  formatTaskStateForContext,
  isVerificationCommand,
} from "../src/task-state.js";

describe("TaskStateManager", () => {
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
      { ok: true, summary: "edit_file: src/a.ts +1/-1", payload: {} },
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
        { ok: true, summary: "edited", payload: {} },
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
});
