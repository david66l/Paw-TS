import { describe, expect, test } from "bun:test";
import {
  lifecycleGatesOk,
  summarizeLifecycleGates,
} from "../../eval/src/swe-exp/report.js";
import { checkAcceptanceCriteria } from "../src/lifecycle/acceptance-gate.js";
import {
  createBudgetAbort,
  resolveLifecycleBudget,
} from "../src/lifecycle/budget.js";
import {
  EMPTY_CODING_PHASE_STATE,
  advanceCodingPhase,
  codingPhaseBlockReason,
  goalUsesCodingPhaseBudget,
} from "../src/lifecycle/coding-phase.js";
import {
  decideCompletion,
  decideFailed,
  decideIncomplete,
  evidenceFromTaskState,
} from "../src/lifecycle/completion-policy.js";
import { collectToolRecoveryMessage } from "../src/lifecycle/task-lifecycle.js";
import {
  idleFuseTripped,
  recoveryHintForToolResult,
  updateFailureSignatures,
} from "../src/lifecycle/tool-recovery.js";
import { checkVerification } from "../src/lifecycle/verification-gate.js";
import {
  type TaskState,
  formatCompletionReadiness,
} from "../src/task-state.js";

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

  test("structured incomplete preserves its producer-owned reason", () => {
    const decision = decideIncomplete({
      reason: "provider_protocol_empty_response",
      message: "Provider recovery exhausted.",
      taskState: baseState({ filesChanged: ["a.py"] }),
    });
    expect(decision).toMatchObject({
      status: "incomplete",
      outcome: "incomplete",
      reason: "provider_protocol_empty_response",
      message: "Provider recovery exhausted.",
      evidence: { filesChanged: ["a.py"] },
    });
    expect(() =>
      decideIncomplete({
        reason: " ",
        message: "missing reason",
        taskState: baseState(),
      }),
    ).toThrow("reason is required");
  });

  test("structured failure preserves its producer-owned reason and evidence", () => {
    const decision = decideFailed({
      reason: "plan_update_failed",
      message: "invalid dependency",
      taskState: baseState({ filesChanged: ["plan.json"] }),
    });
    expect(decision).toMatchObject({
      status: "failed",
      outcome: "failed",
      reason: "plan_update_failed",
      message: "invalid dependency",
      evidence: { filesChanged: ["plan.json"] },
    });
    expect(() =>
      decideFailed({
        reason: " ",
        message: "missing reason",
        taskState: baseState(),
      }),
    ).toThrow("reason is required");
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

  test("structured verification failures survive the run evidence boundary", () => {
    const evidence = evidenceFromTaskState(
      baseState({
        testResults: [
          {
            command: "python runtests.py",
            passed: false,
            outcome: "harness_failed",
            failureKind: "missing_dependency",
            retryability: "terminal",
            summary: "No module named dependency",
          },
        ],
      }),
    );
    expect(evidence.testResults[0]).toMatchObject({
      outcome: "harness_failed",
      failureKind: "missing_dependency",
      retryability: "terminal",
    });
  });

  test("terminal environment setup evidence survives the run boundary", () => {
    const evidence = evidenceFromTaskState(
      baseState({
        testResults: [
          {
            command: "python -m pytest tests/test_candidate.py",
            passed: false,
            outcome: "harness_failed",
            failureKind: "environment_setup",
            retryability: "terminal",
            summary: "conftest could not load from a broken installation",
          },
        ],
      }),
    );
    expect(evidence.testResults[0]).toMatchObject({
      outcome: "harness_failed",
      failureKind: "environment_setup",
      retryability: "terminal",
    });
  });
});

describe("AcceptanceGate", () => {
  test("keeps legacy empty-ledger behavior permissive", () => {
    expect(checkAcceptanceCriteria(baseState())).toEqual({
      ok: true,
      items: [],
    });
  });

  test("requires pending and stale criteria to be re-verified", () => {
    const decision = checkAcceptanceCriteria(
      baseState({
        mutationRevision: 2,
        acceptanceCriteria: [
          {
            id: "acceptance-001",
            text: "Keep legacy output",
            source: { kind: "repository", turn: 1 },
            status: "pending",
          },
          {
            id: "acceptance-002",
            text: "Show the new label",
            source: { kind: "user", turn: 0 },
            status: "satisfied",
            evidence: "passed before the latest edit",
            evidenceMutationRevision: 1,
          },
        ],
      }),
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.mode).toBe("action_required");
      expect(decision.message).toContain("acceptance-001 [pending]");
      expect(decision.message).toContain("acceptance-002 [stale]");
    }
  });

  test("treats blocked criteria as honest incomplete", () => {
    const decision = checkAcceptanceCriteria(
      baseState({
        acceptanceCriteria: [
          {
            id: "acceptance-001",
            text: "Run the official verifier",
            source: { kind: "verification", turn: 3 },
            status: "blocked",
            evidence: "fixture service is unavailable",
          },
        ],
      }),
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.mode).toBe("blocked");
  });

  test("accepts only current-revision satisfied criteria", () => {
    const decision = checkAcceptanceCriteria(
      baseState({
        mutationRevision: 2,
        acceptanceCriteria: [
          {
            id: "acceptance-001",
            text: "Keep legacy output",
            source: { kind: "repository", turn: 1 },
            status: "satisfied",
            evidence: "targeted regression passed",
            evidenceMutationRevision: 2,
          },
        ],
      }),
    );
    expect(decision.ok).toBe(true);
  });

  test("keeps externally verified criteria visible without blocking local closeout", () => {
    const decision = checkAcceptanceCriteria(
      baseState({
        acceptanceCriteria: [
          {
            id: "acceptance-001",
            text: "Official FAIL_TO_PASS suite",
            source: { kind: "verification", turn: 0 },
            status: "pending",
            verificationAuthority: "external",
          },
        ],
      }),
    );
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.items[0]?.readiness).toBe("external");
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
    const v = checkVerification(
      baseState({
        goal: "fix bug\n[allow_skip_verify]",
        filesChanged: ["x.ts"],
      }),
      {
        skipVerifyReason: "no test harness in workspace",
      },
    );
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
    if (!v.ok) expect(v.nudge).toContain("latest code verification failed");
  });

  test("later harness failure does not erase a current-revision pass", () => {
    const state = baseState({
      filesChanged: ["sympy/core/numbers.py"],
      mutationRevision: 2,
      testResults: [
        {
          command: "python bin/test sympy/core/tests/test_numbers.py",
          family: "python-runner",
          passed: true,
          outcome: "passed",
          summary: "85 passed",
          mutationRevision: 2,
        },
        {
          command: "python -m pytest sympy/core/tests/test_numbers.py",
          family: "pytest",
          passed: false,
          outcome: "harness_failed",
          failureKind: "runner_unavailable",
          retryability: "terminal",
          summary: "No module named pytest",
          mutationRevision: 2,
        },
      ],
    });
    expect(checkVerification(state)).toEqual({
      ok: true,
      mode: "tests_passed",
    });
    expect(formatCompletionReadiness(state)).toContain(
      "- Verification: passed for r2",
    );
  });

  test("later harness failure does not hide a current-revision code failure", () => {
    const decision = checkVerification(
      baseState({
        filesChanged: ["src/a.py"],
        mutationRevision: 1,
        testResults: [
          {
            command: "pytest tests/test_a.py",
            family: "pytest",
            passed: false,
            outcome: "code_failed",
            summary: "assertion failed",
            mutationRevision: 1,
          },
          {
            command: "python -m pytest tests/test_b.py",
            family: "pytest",
            passed: false,
            outcome: "harness_failed",
            failureKind: "runner_unavailable",
            summary: "runner unavailable",
            mutationRevision: 1,
          },
        ],
      }),
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.nudge).toContain("latest code verification failed");
      expect(decision.nudge).not.toContain("did not execute");
    }
  });

  test("harness failure blocks completion without blaming product code", () => {
    const v = checkVerification(
      baseState({
        filesChanged: ["x.ts"],
        mutationRevision: 1,
        testResults: [
          {
            command: "pytest",
            passed: false,
            outcome: "harness_failed",
            summary: "exit 1",
            evidence: "Error importing plugin",
            mutationRevision: 1,
          },
        ],
      }),
    );
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.nudge).toContain("did not execute");
      expect(v.nudge).toContain("Repair or replace the verification command");
      expect(v.nudge).not.toContain("Fix the implementation failure");
    }
  });

  test("masked shell status requires direct verification evidence", () => {
    const v = checkVerification(
      baseState({
        filesChanged: ["x.ts"],
        mutationRevision: 1,
        testResults: [
          {
            command: "bun test | findstr passed",
            passed: false,
            outcome: "harness_failed",
            failureKind: "untrusted_exit_status",
            retryability: "retryable",
            summary: "downstream control flow owns the final status",
            mutationRevision: 1,
          },
        ],
      }),
    );
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.nudge).toContain(
        "does not prove its verification runner passed",
      );
      expect(v.nudge).toContain("Run the verification directly");
      expect(v.nudge).not.toContain("did not execute");
    }
  });

  test("trusted external verifier accepts current harness failure only after diff inspection", () => {
    const failed = baseState({
      filesChanged: ["x.ts"],
      mutationRevision: 1,
      testResults: [
        {
          command: "pytest",
          passed: false,
          outcome: "harness_failed",
          summary: "exit 4",
          mutationRevision: 1,
        },
      ],
    });
    const beforeDiff = checkVerification(failed, {
      policy: { authority: "external" },
    });
    expect(beforeDiff.ok).toBe(false);
    if (!beforeDiff.ok)
      expect(beforeDiff.nudge).toContain("Inspect the final diff");
    const afterDiff = checkVerification(
      { ...failed, diffInspectedRevision: 1 },
      { policy: { authority: "external" } },
    );
    expect(afterDiff).toEqual({ ok: true, mode: "external_pending" });
  });

  test("trusted external verifier requires one bounded retry for a recoverable invocation", () => {
    const retryable = {
      command: "node verify-test.js | missing-helper",
      passed: false,
      outcome: "harness_failed" as const,
      failureKind: "invocation_error" as const,
      retryability: "retryable" as const,
      summary: "helper unavailable",
      mutationRevision: 1,
    };
    const once = baseState({
      filesChanged: ["x.ts"],
      mutationRevision: 1,
      diffInspectedRevision: 1,
      testResults: [retryable],
    });
    const pendingRetry = checkVerification(once, {
      policy: { authority: "external" },
    });
    expect(pendingRetry.ok).toBe(false);
    if (!pendingRetry.ok)
      expect(pendingRetry.nudge).toContain("materially simpler direct command");

    const exhausted = checkVerification(
      { ...once, testResults: [retryable, retryable] },
      { policy: { authority: "external" } },
    );
    expect(exhausted).toEqual({ ok: true, mode: "external_pending" });
  });

  test("trusted verification policy can require mutation without a prompt marker", () => {
    const decision = checkVerification(baseState(), {
      policy: { authority: "external", requireMutation: true },
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.nudge).toContain("requires file changes");
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

  test("different shell commands do not share an idle-fuse signature", () => {
    const fail = {
      ok: false as const,
      summary: "run_shell: exit 1 — Command failed with exit code 1",
      payload: {},
    };
    let sigs: readonly string[] = [];
    for (const command of [
      "python -c \"print('one')\"",
      "python -c \"print('two')\"",
      "python -c \"print('three')\"",
      "python -c \"print('four')\"",
    ]) {
      sigs = updateFailureSignatures(
        sigs,
        [{ tool: "workspace.run_shell", args: { command } }],
        [fail],
      );
    }
    expect(idleFuseTripped(sigs, 3)).toBe(false);
    expect(new Set(sigs).size).toBe(4);
  });

  test("the same shell action and failure still trips without exposing args", () => {
    const secret = "token-super-secret";
    const call = {
      tool: "workspace.run_shell",
      args: { command: `curl -H Authorization:${secret} localhost` },
    };
    const fail = {
      ok: false as const,
      summary: "run_shell: exit 1 — Command failed with exit code 1",
      payload: {},
    };
    let sigs: readonly string[] = [];
    for (let i = 0; i < 3; i++) {
      sigs = updateFailureSignatures(sigs, [call], [fail]);
    }
    expect(idleFuseTripped(sigs, 3)).toBe(true);
    expect(sigs.join("\n")).not.toContain(secret);
    expect(sigs[0]).toBe(sigs[1]);
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

  test("control-plane rejections do not create recovery or idle-fuse failures", () => {
    const previous = ["workspace.read_file|E_IO|real failure"];
    const recovery = collectToolRecoveryMessage(
      [{ tool: "workspace.read_file" }],
      [
        {
          ok: false,
          payload: { code: "E_LOOP_POLICY" },
          summary: "[LoopPolicy:implementation_required] edit now",
        },
      ],
      previous,
    );
    expect(recovery.message).toBeNull();
    expect(recovery.signatures).toEqual(previous);
    expect(recovery.fuseTripped).toBe(false);
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
      [{ ok: true, payload: { linesAdded: 1, linesRemoved: 1 } }],
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

  test("a no-op edit does not leave the locate phase", () => {
    const noOp = advanceCodingPhase(
      EMPTY_CODING_PHASE_STATE,
      [call("workspace.edit_file")],
      [
        {
          ok: true,
          payload: { changed: false, linesAdded: 0, linesRemoved: 0 },
        },
      ],
    );
    expect(noOp.state.successfulEdits).toBe(0);
    expect(noOp.nudges).toEqual([]);
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
