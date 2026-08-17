import { describe, expect, test } from "bun:test";

import {
  AGENT_ROSTER_ORDER,
  DEFAULT_AGENT_SEEDS,
  SEED_BIGE,
} from "../src/agents/seeds.js";
import {
  computeProgressBaselineV1,
  evaluateInvestigationStallV1,
} from "../src/lifecycle/investigation-stall.js";
import { DEFAULT_PROGRESS_ADVISOR_CONFIG_V2 } from "../src/loop-v2/progress-advisor.js";
import type { TaskState } from "../src/task-state.js";

function state(overrides: Partial<TaskState>): TaskState {
  return {
    runId: "stall-test",
    goal: "goal",
    filesRead: [],
    filesChanged: [],
    commandsRun: [],
    testResults: [],
    constraints: [],
    plan: [],
    mutationRevision: 0,
    shellCommandRevision: 0,
    ...overrides,
  } as TaskState;
}

describe("multi-agent activation slice", () => {
  test("investigator seed is registered read-only with tracking output", () => {
    expect(SEED_BIGE.id).toBe("bige");
    expect(SEED_BIGE.childPolicy).toBe("read_only");
    expect(SEED_BIGE.tools).not.toContain("write_file");
    expect(SEED_BIGE.tools).not.toContain("edit_file");
    expect(SEED_BIGE.tools).toContain("symbol_search");
    expect(AGENT_ROSTER_ORDER).toContain("bige");
    expect(DEFAULT_AGENT_SEEDS).toHaveLength(9);
  });

  test("stall ladder fires fact-based advice at versioned thresholds", () => {
    const base = evaluateInvestigationStallV1({
      state: state({}),
      baseline: computeProgressBaselineV1(state({}), 0),
      turn: 0,
    });
    // investigation-only progress: reads and commands grow, product facts do not
    const investigating = state({
      filesRead: ["a.py", "b.py", "c.py"],
      shellCommandRevision: 7,
    });
    const gap = DEFAULT_PROGRESS_ADVISOR_CONFIG_V2.noDeltaThresholds.inspectGap;
    const advice = evaluateInvestigationStallV1({
      state: investigating,
      baseline: base.baseline,
      turn: gap,
    });
    expect(advice.message).toContain("[ProgressAdvice:inspect_gap]");
    expect(advice.message).toContain(`last ${gap} turns`);
    expect(advice.message).toContain("+3 files read");
    expect(advice.message).toContain("workspace.run_agent");
    expect(advice.message).toContain("bige");

    const mid = evaluateInvestigationStallV1({
      state: investigating,
      baseline: base.baseline,
      turn: gap + 1,
    });
    expect(mid.message).toBeUndefined();

    const stale = evaluateInvestigationStallV1({
      state: investigating,
      baseline: base.baseline,
      turn: DEFAULT_PROGRESS_ADVISOR_CONFIG_V2.noDeltaThresholds
        .changeHypothesis,
    });
    expect(stale.message).toContain("[ProgressAdvice:hypothesis_stale]");

    const safety = evaluateInvestigationStallV1({
      state: investigating,
      baseline: base.baseline,
      turn: DEFAULT_PROGRESS_ADVISOR_CONFIG_V2.noDeltaThresholds.safetyWarning,
    });
    expect(safety.message).toContain("[ProgressAdvice:safety_line]");
    expect(safety.message).toContain("honest incomplete/stalled handoff");
  });

  test("meaningful product progress resets the baseline without advice", () => {
    const base = computeProgressBaselineV1(state({}), 0);
    const afterMutation = evaluateInvestigationStallV1({
      state: state({ mutationRevision: 1, filesChanged: ["x.py"] }),
      baseline: base,
      turn: 5,
    });
    expect(afterMutation.message).toBeUndefined();
    expect(afterMutation.baseline.turn).toBe(5);
    expect(afterMutation.baseline.mutationRevision).toBe(1);

    const afterVerification = evaluateInvestigationStallV1({
      state: state({
        testResults: [
          {
            command: "pytest x",
            passed: true,
            shellCommandRevision: 3,
          } as TaskState["testResults"][number],
        ],
      }),
      baseline: base,
      turn: 6,
    });
    expect(afterVerification.message).toBeUndefined();
    expect(afterVerification.baseline.lastVerificationRevision).toBe(3);
    // 基线重置后，停滞计数从新回合重新起算
    const next = evaluateInvestigationStallV1({
      state: state({
        testResults: [
          {
            command: "pytest x",
            passed: true,
            shellCommandRevision: 3,
          } as TaskState["testResults"][number],
        ],
      }),
      baseline: afterVerification.baseline,
      turn: 7,
    });
    expect(next.message).toBeUndefined();
  });
});
