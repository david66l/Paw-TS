import { describe, expect, test } from "bun:test";

import {
  convergenceGuidance,
  convergenceWindow,
} from "../src/lifecycle/convergence.js";
import type { TaskState } from "../src/task-state.js";

function state(overrides: Partial<TaskState> = {}): TaskState {
  return {
    goal: "fix bug",
    constraints: [],
    plan: [],
    filesRead: [],
    filesChanged: ["a.py"],
    commandsRun: [],
    testResults: [],
    mutationRevision: 1,
    diffInspectedRevision: 0,
    fileLockConflicts: [],
    rejectedHypotheses: [],
    pinnedFacts: [],
    knownNonGoals: [],
    updatedAt: 0,
    ...overrides,
  };
}

describe("convergence guidance", () => {
  test("uses a proportional bounded window without changing the budget", () => {
    expect(convergenceWindow(64)).toBe(12);
    expect(convergenceWindow(32)).toBe(7);
    expect(convergenceWindow(10)).toBe(4);
    expect(convergenceGuidance(state(), 13, 64)).toBeNull();
    expect(convergenceGuidance(state(), 12, 64)).toContain(
      "Run the narrowest high-signal",
    );
  });

  test("selects the next closeout action from revision-scoped evidence", () => {
    expect(
      convergenceGuidance(
        state({
          testResults: [
            {
              command: "pytest",
              passed: false,
              summary: "failed",
              mutationRevision: 1,
            },
          ],
        }),
        6,
        32,
      ),
    ).toContain("exact current test failure");
    expect(
      convergenceGuidance(
        state({
          testResults: [
            {
              command: "pytest",
              passed: true,
              summary: "passed",
              mutationRevision: 1,
            },
          ],
        }),
        6,
        32,
      ),
    ).toContain("Inspect the final diff");
    expect(
      convergenceGuidance(
        state({
          diffInspectedRevision: 1,
          testResults: [
            {
              command: "pytest",
              passed: true,
              summary: "passed",
              mutationRevision: 1,
            },
          ],
        }),
        6,
        32,
      ),
    ).toContain("deliver final_answer now");
  });
});
