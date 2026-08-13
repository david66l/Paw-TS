import { describe, expect, test } from "bun:test";
import {
  TaskStateManager,
  acceptanceReadiness,
  formatCompletionReadiness,
  formatTaskStateForContext,
  isVerificationCommand,
} from "../src/task-state.js";

describe("TaskStateManager", () => {
  test("keeps a durable acceptance ledger with stable ids", () => {
    const state = new TaskStateManager("change route output");
    state.registerAcceptanceCriteria(
      [
        {
          text: "  Keep the legacy three-column output when no host is configured. ",
          source: "repository",
          ref: "tests/test_cli.py::test_simple",
        },
        {
          text: "Use Host as the heading in host-matching mode.",
          source: "repository",
          ref: "tests/test_cli.py::test_host",
        },
      ],
      3,
    );
    state.registerAcceptanceCriteria(
      [
        {
          text: "Keep the legacy three-column output when no host is configured.",
          source: "repository",
        },
      ],
      4,
    );

    expect(state.acceptanceCriteria().map((item) => item.id)).toEqual([
      "acceptance-001",
      "acceptance-002",
    ]);
    expect(state.acceptanceCriteria()[0]?.source).toEqual({
      kind: "repository",
      turn: 3,
      ref: "tests/test_cli.py::test_simple",
    });

    const restored = new TaskStateManager("ignored", state.snapshot());
    restored.registerAcceptanceCriteria(
      [{ text: "Show Subdomain in subdomain mode.", source: "user" }],
      5,
    );
    expect(restored.acceptanceCriteria().at(-1)?.id).toBe("acceptance-003");
    expect(formatTaskStateForContext(restored.snapshot())).toContain(
      "acceptance-001 [pending]",
    );
  });

  test("applies acceptance updates atomically", () => {
    const state = new TaskStateManager("preserve compatibility");
    state.registerAcceptanceCriteria(
      [{ text: "Keep old output", source: "repository" }],
      1,
    );
    const before = state.snapshot();
    const rejected = state.applyAcceptanceUpdate(
      {
        reason: "mixed valid and invalid transaction",
        add: [{ text: "New branch", source: "verification" }],
        updates: [
          {
            id: "acceptance-missing",
            status: "satisfied",
            evidence: "test passed",
          },
        ],
      },
      2,
    );
    expect(rejected.ok).toBe(false);
    expect(state.snapshot()).toEqual(before);

    const accepted = state.applyAcceptanceUpdate(
      {
        reason: "direct test passed",
        add: [],
        updates: [
          {
            id: "acceptance-001",
            status: "satisfied",
            evidence: "tests/test_cli.py passed",
          },
        ],
      },
      2,
    );
    expect(accepted.ok).toBe(true);
    expect(acceptanceReadiness(state.snapshot())[0]?.readiness).toBe(
      "satisfied",
    );
  });

  test("makes satisfied acceptance evidence stale after a source mutation", () => {
    const state = new TaskStateManager("change route output");
    state.registerAcceptanceCriteria(
      [
        {
          text: "Existing route formatting remains compatible.",
          source: "repository",
          ref: "tests/test_cli.py",
        },
      ],
      1,
    );
    expect(() =>
      state.setAcceptanceCriterionStatus("acceptance-001", "satisfied"),
    ).toThrow("requires evidence");
    state.setAcceptanceCriterionStatus(
      "acceptance-001",
      "satisfied",
      "tests/test_cli.py passed",
    );
    expect(acceptanceReadiness(state.snapshot())[0]?.readiness).toBe(
      "satisfied",
    );

    state.recordToolResult(
      {
        type: "tool_call",
        tool: "workspace.edit_file",
        args: { path: "src/flask/cli.py" },
      },
      {
        ok: true,
        summary: "edited",
        payload: { path: "src/flask/cli.py", linesAdded: 1, linesRemoved: 1 },
      },
    );
    expect(acceptanceReadiness(state.snapshot())[0]?.readiness).toBe("stale");
    expect(formatTaskStateForContext(state.snapshot())).toContain(
      "acceptance-001 [stale]",
    );
    state.setAcceptanceCriterionStatus(
      "acceptance-001",
      "satisfied",
      "pytest tests/test_cli.py: 57 passed",
    );
    expect(acceptanceReadiness(state.snapshot())[0]?.readiness).toBe(
      "satisfied",
    );
  });

  test("restores legacy snapshots with an empty acceptance ledger", () => {
    const current = new TaskStateManager("fix bug").snapshot();
    const { acceptanceCriteria: _removed, ...legacy } = current;
    const restored = new TaskStateManager("ignored", legacy);
    expect(restored.acceptanceCriteria()).toEqual([]);
  });

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
