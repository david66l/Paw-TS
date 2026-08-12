import { describe, expect, test } from "bun:test";
import {
  decideCompletion,
  evidenceFromTaskState,
} from "../src/lifecycle/completion-policy.js";
import { checkVerification } from "../src/lifecycle/verification-gate.js";
import {
  idleFuseTripped,
  recoveryHintForToolResult,
  updateFailureSignatures,
} from "../src/lifecycle/tool-recovery.js";
import {
  resolveLifecycleBudget,
  createBudgetAbort,
} from "../src/lifecycle/budget.js";
import {
  advanceCodingPhase,
  codingPhaseBlockReason,
  EMPTY_CODING_PHASE_STATE,
  goalUsesCodingPhaseBudget,
} from "../src/lifecycle/coding-phase.js";
import {
  summarizeLifecycleGates,
  lifecycleGatesOk,
} from "../../eval/src/swe-exp/report.js";
import type { TaskState } from "../src/task-state.js";

function baseState(over: Partial<TaskState> = {}): TaskState {
  return {
    goal: "fix bug",
    constraints: [],
    plan: [],
    filesRead: [],
    filesChanged: [],
    commandsRun: [],
    testResults: [],
    fileLockConflicts: [],
    rejectedHypotheses: [],
    pinnedFacts: [],
    knownNonGoals: [],
    updatedAt: Date.now(),
    ...over,
  };
}

describe("CompletionPolicy", () => {
  test("budget exhaustion is never completed", () => {
    const d = decideCompletion({
      intent: "budget_exhausted",
      message: "I almost fixed it",
      taskState: baseState({ filesChanged: ["a.py"] }),
      hasEverUsedTools: true,
    });
    expect(d.status).toBe("incomplete");
    expect(d.outcome).toBe("budget_exhausted");
  });

  test("final_answer without mutation is model_declared completed", () => {
    const d = decideCompletion({
      intent: "final_answer",
      message: "answer",
      taskState: baseState(),
      verification: { ok: true, mode: "no_mutation" },
    });
    expect(d.status).toBe("completed");
    expect(d.outcome).toBe("model_declared");
  });

  test("require_mutation goal blocks no_mutation completion via VerificationGate", () => {
    const state = baseState({
      goal: "Fix the bug\n[require_mutation]\n...",
    });
    const v = checkVerification(state);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.nudge).toContain("require_mutation");
  });

  test("require_mutation goal allows completion after filesChanged", () => {
    const state = baseState({
      goal: "Fix the bug\n[require_mutation]\n...",
      filesChanged: ["a.py"],
      testResults: [{ command: "pytest", passed: true, summary: "ok" }],
    });
    const v = checkVerification(state);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.mode).toBe("tests_passed");
  });

  test("verified tests → verified completed", () => {
    const state = baseState({
      filesChanged: ["a.py"],
      testResults: [{ command: "pytest", passed: true, summary: "ok" }],
    });
    const d = decideCompletion({
      intent: "final_answer",
      message: "done",
      taskState: state,
      verification: { ok: true, mode: "tests_passed" },
    });
    expect(d.status).toBe("completed");
    expect(d.outcome).toBe("verified");
    expect(evidenceFromTaskState(state).filesChanged).toEqual(["a.py"]);
  });

  test("file lock conflicts appear in evidence", () => {
    const state = baseState({ fileLockConflicts: ["src/a.ts"] });
    expect(evidenceFromTaskState(state).fileLockConflicts).toEqual([
      "src/a.ts",
    ]);
  });
});

describe("VerificationGate", () => {
  test("no mutation ok", () => {
    expect(checkVerification(baseState()).ok).toBe(true);
  });

  test("mutation without tests fails", () => {
    const v = checkVerification(baseState({ filesChanged: ["x.ts"] }));
    expect(v.ok).toBe(false);
  });

  test("trusted task can allow skip_verify", () => {
    const v = checkVerification(baseState({
      goal: "fix bug\n[allow_skip_verify]",
      filesChanged: ["x.ts"],
    }), {
      skipVerifyReason: "no test harness in workspace",
    });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.mode).toBe("skipped");
  });

  test("model cannot authorize its own skip_verify", () => {
    const v = checkVerification(baseState({ filesChanged: ["x.ts"] }), {
      skipVerifyReason: "tests are inconvenient",
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.nudge).toContain("allow_skip_verify");
  });

  test("passing verification before the latest mutation is stale", () => {
    const v = checkVerification(
      baseState({
        filesChanged: ["x.ts"],
        mutationRevision: 2,
        testResults: [
          {
            command: "bun test",
            passed: true,
            summary: "ok",
            mutationRevision: 1,
          },
        ],
      }),
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.nudge).toContain("predates the latest file change");
  });

  test("latest failed verification overrides an earlier pass", () => {
    const v = checkVerification(
      baseState({
        filesChanged: ["x.ts"],
        mutationRevision: 1,
        testResults: [
          {
            command: "bun test",
            passed: true,
            summary: "ok",
            mutationRevision: 1,
          },
          {
            command: "bun test",
            passed: false,
            summary: "failed",
            mutationRevision: 1,
          },
        ],
      }),
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.nudge).toContain("latest verification failed");
  });
});

describe("ToolFailureRecovery + idle fuse", () => {
  test("edit_file old_string failure suggests apply_patch", () => {
    const hint = recoveryHintForToolResult("workspace.edit_file", {
      ok: false,
      summary: "edit_file: old_string not found",
      payload: { error: "old_string not found" },
    });
    expect(hint?.action).toBe("use_apply_patch");
  });

  test("idle fuse trips on repeated signature", () => {
    const fail = {
      ok: false as const,
      summary: "boom",
      payload: { code: "E_USER" },
    };
    let sigs = updateFailureSignatures([], [{ tool: "t" }], [fail]);
    sigs = updateFailureSignatures(sigs, [{ tool: "t" }], [fail]);
    sigs = updateFailureSignatures(sigs, [{ tool: "t" }], [fail]);
    expect(idleFuseTripped(sigs, 3)).toBe(true);
  });

  test("successful progress resets the idle-fuse failure streak", () => {
    const fail = {
      ok: false as const,
      summary: "boom",
      payload: { code: "E_USER" },
    };
    const success = {
      ok: true as const,
      summary: "recovered",
      payload: {},
    };
    let sigs = updateFailureSignatures([], [{ tool: "t" }], [fail]);
    sigs = updateFailureSignatures(sigs, [{ tool: "t" }], [fail]);
    sigs = updateFailureSignatures(sigs, [{ tool: "read" }], [success]);
    expect(sigs).toEqual([]);
    expect(idleFuseTripped(sigs, 3)).toBe(false);
  });
});

describe("CodingPhase locate → edit → verify budget", () => {
  const call = (tool: string, args: Record<string, unknown> = {}) => ({
    type: "tool_call" as const,
    tool,
    args,
  });

  test("nudges at 10 navigation calls and blocks the 15th before an edit", () => {
    const ten = advanceCodingPhase(
      EMPTY_CODING_PHASE_STATE,
      Array.from({ length: 10 }, () => call("workspace.grep")),
      Array.from({ length: 10 }, () => ({ ok: true })),
    );
    expect(ten.state.navigationCalls).toBe(10);
    expect(ten.nudges[0]).toContain("CodingPhase:locate");

    const fourteen = advanceCodingPhase(
      ten.state,
      Array.from({ length: 4 }, () => call("workspace.read_file")),
      Array.from({ length: 4 }, () => ({ ok: true })),
    );
    expect(
      codingPhaseBlockReason(call("workspace.grep"), fourteen.state),
    ).toContain("CodingPhase:locate_limit");
    expect(
      codingPhaseBlockReason(call("workspace.edit_file"), fourteen.state),
    ).toBeNull();
  });

  test("an edit triggers verification nudge and blocks post-edit browsing", () => {
    const edited = advanceCodingPhase(
      EMPTY_CODING_PHASE_STATE,
      [call("workspace.edit_file")],
      [{ ok: true }],
    );
    expect(edited.nudges[0]).toContain("CodingPhase:verify");
    const browsed = advanceCodingPhase(
      edited.state,
      Array.from({ length: 4 }, () => call("workspace.read_file")),
      Array.from({ length: 4 }, () => ({ ok: true })),
    );
    expect(
      codingPhaseBlockReason(call("workspace.grep"), browsed.state),
    ).toContain("CodingPhase:verify_limit");
    expect(
      codingPhaseBlockReason(
        call("workspace.run_shell", { command: "pytest tests/test_x.py -q" }),
        browsed.state,
      ),
    ).toBeNull();
    const verified = advanceCodingPhase(
      browsed.state,
      [call("workspace.run_shell", { command: "pytest tests/test_x.py -q" })],
      [{ ok: false }],
    );
    expect(verified.state.verificationCalls).toBe(1);
  });
});

describe("LifecycleBudget", () => {
  test("resolveLifecycleBudget clamps and defaults", () => {
    const b = resolveLifecycleBudget({ maxSteps: 10 });
    expect(b.maxSteps).toBe(10);
    expect(b.childMaxSteps).toBe(12);
    expect(b.idleFuseHardStopTrips).toBe(2);
  });

  test("createBudgetAbort clears without throwing", () => {
    const { signal, clear } = createBudgetAbort(60_000);
    expect(signal.aborted).toBe(false);
    clear();
  });
});

describe("SWE-Exp lifecycle gates", () => {
  test("fake completed empty patch fails gate", () => {
    const summary = summarizeLifecycleGates([
      {
        pairId: "p1",
        repo: "r",
        historyId: "h",
        probeId: "p",
        off: {
          memoryOn: false,
          resolved: false,
          warnings: ["empty_patch", "fake_completed_empty_patch"],
        },
        on: { memoryOn: true, resolved: false, warnings: [] },
        outcome: "tie",
      },
    ]);
    expect(summary.fakeCompletedEmptyPatch).toBe(1);
    expect(lifecycleGatesOk(summary)).toBe(false);
  });

  test("clean arms pass gate", () => {
    const summary = summarizeLifecycleGates([
      {
        pairId: "p1",
        repo: "r",
        historyId: "h",
        probeId: "p",
        off: { memoryOn: false, resolved: true, warnings: [] },
        on: { memoryOn: true, resolved: true, warnings: [] },
        outcome: "tie",
      },
    ]);
    expect(lifecycleGatesOk(summary)).toBe(true);
  });
});
  test("is opt-in rather than affecting every mutation task", () => {
    expect(goalUsesCodingPhaseBudget("fix bug [require_mutation]")).toBe(false);
    expect(
      goalUsesCodingPhaseBudget(
        "fix bug [require_mutation] [coding_phase_budget]",
      ),
    ).toBe(true);
  });
