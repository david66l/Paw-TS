import { describe, expect, test } from "bun:test";

import {
  convergenceEvidenceKey,
  convergenceGuidance,
  convergenceToolBlockReason,
  convergenceWindow,
  implementationGuidance,
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

  test("nudges implementation at mid-run only for mutation goals with evidence", () => {
    const explored = state({
      goal: "Fix the parser bug",
      filesChanged: [],
      filesRead: ["a.ts", "b.ts", "c.ts"],
      mutationRevision: 0,
    });
    expect(implementationGuidance(explored, 31, 64)).toBeNull();
    expect(implementationGuidance(explored, 32, 64)).toContain(
      "without a recorded source change",
    );
    expect(
      implementationGuidance(
        { ...explored, goal: "Explain the parser" },
        40,
        64,
      ),
    ).toBeNull();
  });

  test("keys closeout guidance by material evidence state", () => {
    expect(convergenceEvidenceKey(state())).toBe("r1:missing:stale");
    expect(
      convergenceEvidenceKey(
        state({
          testResults: [
            {
              command: "pytest",
              passed: true,
              summary: "ok",
              mutationRevision: 1,
            },
          ],
        }),
      ),
    ).toBe("r1:passed:stale");
  });

  test("defers investigation after midpoint while allowing edits and tests", () => {
    const explored = state({
      goal: "Fix the parser bug",
      filesChanged: [],
      filesRead: ["a.ts", "b.ts", "c.ts"],
      mutationRevision: 0,
    });
    expect(
      convergenceToolBlockReason(
        {
          type: "tool_call",
          tool: "workspace.read_file",
          args: { path: "d.ts" },
        },
        explored,
        32,
        64,
      ),
    ).toContain("implementation_required");
    expect(
      convergenceToolBlockReason(
        { type: "tool_call", tool: "workspace.edit_file", args: {} },
        explored,
        32,
        64,
      ),
    ).toBeNull();
    expect(
      convergenceToolBlockReason(
        { type: "tool_call", tool: "workspace.git_status", args: {} },
        explored,
        32,
        64,
      ),
    ).toContain("implementation_required");
    expect(
      convergenceToolBlockReason(
        {
          type: "tool_call",
          tool: "workspace.symbol_search",
          args: { query: "Parser" },
        },
        explored,
        32,
        64,
      ),
    ).toContain("implementation_required");
    expect(
      convergenceToolBlockReason(
        {
          type: "tool_call",
          tool: "workspace.run_shell",
          args: { command: "py -3.10 -m pytest tests/test_parser.py -q" },
        },
        explored,
        32,
        64,
      ),
    ).toBeNull();
  });

  test("enforces verify then diff then delivery in the closeout window", () => {
    const read = {
      type: "tool_call" as const,
      tool: "workspace.grep",
      args: { pattern: "more" },
    };
    expect(convergenceToolBlockReason(read, state(), 55, 64)).toContain(
      "verify_current_revision",
    );
    const passed = state({
      testResults: [
        { command: "pytest", passed: true, summary: "ok", mutationRevision: 1 },
      ],
    });
    expect(convergenceToolBlockReason(read, passed, 55, 64)).toContain(
      "inspect_final_diff",
    );
    expect(
      convergenceToolBlockReason(
        { type: "tool_call", tool: "workspace.git_diff", args: {} },
        passed,
        55,
        64,
      ),
    ).toBeNull();
    expect(
      convergenceToolBlockReason(
        read,
        { ...passed, diffInspectedRevision: 1 },
        55,
        64,
      ),
    ).toContain("LoopPolicy:deliver");
  });
});
