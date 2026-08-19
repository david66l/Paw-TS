import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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
import { AgentOrchestrator } from "../src/orchestrator.js";
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
      canDelegate: true,
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
    expect(safety.message).toContain("not a forced stop or edit");
    expect(safety.message).toContain("confirmed facts");
    expect(safety.message).toContain("current focus:");

    for (const periodicGap of [24, 32, 40]) {
      const periodic = evaluateInvestigationStallV1({
        state: investigating,
        baseline: base.baseline,
        turn: periodicGap,
      });
      expect(periodic.message).toContain("[ProgressAdvice:safety_line]");
      expect(periodic.message).toContain(`last ${periodicGap} turns`);
      expect(periodic.message).toContain("materially different");
    }
    expect(
      evaluateInvestigationStallV1({
        state: investigating,
        baseline: base.baseline,
        turn: 23,
      }).message,
    ).toBeUndefined();
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

  test("a 42-turn production loop receives 4/8/16 then periodic 24/32/40 advice", async () => {
    const workspaceRoot = mkdtempSync(
      path.join(tmpdir(), "paw-stall-cadence-"),
    );
    mkdirSync(path.join(workspaceRoot, ".paw"), { recursive: true });
    writeFileSync(
      path.join(workspaceRoot, ".paw", "memory-config.json"),
      JSON.stringify({ enable: false }),
      "utf8",
    );
    const files = Array.from({ length: 42 }, (_, index) => `fact-${index}.txt`);
    for (const file of files) {
      writeFileSync(path.join(workspaceRoot, file), file, "utf8");
    }
    const progressTags: string[] = [];
    const orchestrator = new AgentOrchestrator({
      loopKernelVersion: "v2",
      memoryExtraction: "off",
      memoryLlm: "off",
      model: {
        label: "stall-cadence-fixture",
        async complete(messages) {
          const control = messages.find((message) =>
            message.content.includes("[ProgressAdvice:"),
          );
          const tag = control?.content.match(
            /\[ProgressAdvice:([^\]]+)\]/,
          )?.[1];
          if (tag) progressTags.push(tag);
          const file = files.shift() ?? "fact-41.txt";
          return {
            text: JSON.stringify({
              tool: "workspace.read_file",
              args: { path: file },
            }),
          };
        },
      },
      retrySleep: async () => {},
    });

    try {
      await orchestrator.run({
        runId: "stall-cadence-production",
        goal: "Inspect repository evidence until the cause is established.",
        workspaceRoot,
        maxSteps: 42,
      });
      expect(progressTags).toEqual([
        "inspect_gap",
        "hypothesis_stale",
        "safety_line",
        "safety_line",
        "safety_line",
        "safety_line",
      ]);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
