import { describe, expect, test } from "bun:test";
import { MAX_STEPS_WARNING } from "@paw/core";

import {
  applyLoopGuidanceReceiptV1,
  deriveLoopGuidanceCandidatesV1,
} from "../src/lifecycle/loop-guidance.js";
import type { TurnFlags } from "../src/orchestrator/types.js";
import type { TaskState } from "../src/task-state.js";

function state(overrides: Partial<TaskState> = {}): TaskState {
  return {
    goal: "fix bug",
    constraints: [],
    plan: [],
    filesRead: [],
    filesChanged: ["a.ts"],
    commandsRun: [],
    testResults: [],
    shellCommandRevision: 0,
    mutationRevision: 1,
    mutationShellCommandRevision: 0,
    diffInspectedRevision: 0,
    fileLockConflicts: [],
    rejectedHypotheses: [],
    pinnedFacts: [],
    knownNonGoals: [],
    updatedAt: 0,
    ...overrides,
  };
}

function flags(overrides: Partial<TurnFlags> = {}): TurnFlags {
  return {
    autoContinueNudges: 0,
    lastTurnHadToolCall: false,
    hasEverUsedTools: true,
    ...overrides,
  };
}

describe("late loop guidance v1", () => {
  test("does not consume convergence evidence before the closeout window", () => {
    const before = deriveLoopGuidanceCandidatesV1({
      state: state(),
      flags: flags(),
      turn: 20,
      maxSteps: 64,
      historyUsed: 10,
      historyBudget: 100,
    });
    expect(before).toHaveLength(0);

    const inWindow = deriveLoopGuidanceCandidatesV1({
      state: state(),
      flags: flags(),
      turn: 52,
      maxSteps: 64,
      historyUsed: 10,
      historyBudget: 100,
    });
    expect(inWindow[0]?.receipt).toEqual({
      kind: "convergence",
      evidenceKey: "r1:missing:stale",
    });
    expect(inWindow[0]?.control.text).toContain("Convergence checkpoint");
  });

  test("orders max-step ahead of evidence guidance and keeps guard as status", () => {
    const candidates = deriveLoopGuidanceCandidatesV1({
      state: state(),
      flags: flags(),
      turn: 7,
      maxSteps: 10,
      historyUsed: 101,
      historyBudget: 100,
    });
    expect(candidates.map((candidate) => candidate.receipt.kind)).toEqual([
      "max_steps",
      "convergence",
      "context_guard",
    ]);
    expect(candidates[0]?.control).toEqual({
      kind: "progress",
      text: MAX_STEPS_WARNING,
    });
    expect(candidates.at(-1)?.control.kind).toBe("status");
  });

  test("records only the selected successful delivery receipt", () => {
    const converged = applyLoopGuidanceReceiptV1(flags(), {
      kind: "convergence",
      evidenceKey: "r1:passed:current",
    });
    expect(converged._convergenceEvidenceKey).toBe("r1:passed:current");
    expect(converged._maxStepsWarned).toBeUndefined();

    const maxed = applyLoopGuidanceReceiptV1(converged, {
      kind: "max_steps",
    });
    expect(maxed._maxStepsWarned).toBe(true);
    expect(maxed._convergenceEvidenceKey).toBe("r1:passed:current");
  });

  test("derives implementation only after sustained read-only work", () => {
    const candidates = deriveLoopGuidanceCandidatesV1({
      state: state({
        mutationRevision: 0,
        filesChanged: [],
        filesRead: ["a.ts", "b.ts", "c.ts"],
      }),
      flags: flags({ hasEverUsedTools: false }),
      turn: 31,
      maxSteps: 64,
      historyUsed: 10,
      historyBudget: 100,
    });
    expect(candidates.map((candidate) => candidate.receipt.kind)).toEqual([
      "implementation",
    ]);
  });
});
