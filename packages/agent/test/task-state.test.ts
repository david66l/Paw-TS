import { describe, expect, test } from "bun:test";
import { TaskStateManager, formatTaskStateForContext } from "../src/task-state.js";

describe("TaskStateManager", () => {
  test("records file and test tool facts", () => {
    const state = new TaskStateManager("must keep changes minimal");

    state.recordToolResult(
      { type: "tool_call", tool: "workspace.read_file", args: { path: "src/a.ts" } },
      { ok: true, summary: "read_file: src/a.ts", payload: {} },
    );
    state.recordToolResult(
      { type: "tool_call", tool: "workspace.edit_file", args: { path: "src/a.ts" } },
      { ok: true, summary: "edit_file: src/a.ts +1/-1", payload: {} },
    );
    state.recordToolResult(
      { type: "tool_call", tool: "workspace.run_shell", args: { command: "bun test packages/agent/test/task-state.test.ts" } },
      { ok: true, summary: "run_shell: exit 0", payload: {} },
    );
    state.recordToolResult(
      { type: "tool_call", tool: "workspace.run_shell", args: { command: "bun run bad" } },
      { ok: false, summary: "run_shell: exit 1", payload: {} },
    );

    const snapshot = state.snapshot();
    expect(snapshot.constraints).toContain("must keep changes minimal");
    expect(snapshot.filesRead).toContain("src/a.ts");
    expect(snapshot.filesChanged).toContain("src/a.ts");
    expect(snapshot.commandsRun).toHaveLength(2);
    expect(snapshot.testResults[0]?.passed).toBe(true);
    expect(snapshot.pinnedFacts[0]).toContain("workspace.run_shell failed");

    const restored = new TaskStateManager("ignored", snapshot);
    expect(restored.snapshot().filesChanged).toContain("src/a.ts");
    expect(formatTaskStateForContext(snapshot)).toContain("Files changed");
  });
});
