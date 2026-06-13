/**
 * RuleScorer unit tests — verify each rule type against known EvalRunRecords.
 */

import { describe, expect, test } from "bun:test";
import { RuleScorer } from "../src/scorer/rule-scorer.js";
import type { EvalRunRecord } from "../src/eval-record.js";
import type { RuleSpec } from "../src/test-suite/types.js";

function makeRun(overrides?: Partial<EvalRunRecord>): EvalRunRecord {
  return {
    testCaseId: "test-001",
    repetitionIndex: 0,
    runId: "run-1",
    goal: "test goal",
    modelLabel: "test-model",
    status: "completed",
    finalAnswer: "Done.",
    turns: [],
    durationMs: 100,
    expected: undefined,
    ...overrides,
  };
}

function addToolCall(
  run: EvalRunRecord,
  tool: string,
  args: unknown = {},
  ok = true,
  result = "success",
): EvalRunRecord {
  const turn = run.turns[run.turns.length - 1];
  if (turn && turn.toolExecutions) {
    // Mutate for test convenience
    (turn.toolExecutions as Array<unknown>).push({
      tool,
      args,
      result,
      ok,
      durationMs: 10,
    });
  } else {
    run.turns.push({
      turnIndex: run.turns.length,
      modelInput: {
        messageCount: 5,
        estimatedTokens: 500,
      },
      modelOutput: {
        rawText: "calling tool...",
        latencyMs: 50,
      },
      contextSnapshot: {
        historyTokens: 200,
        systemTokens: 300,
        totalTokens: 500,
        messageCount: 5,
      },
      toolExecutions: [{ tool, args, result, ok, durationMs: 10 }],
    });
  }
  return run;
}

const scorer = new RuleScorer();

describe("RuleScorer", () => {
  describe("tool_called", () => {
    test("passes when tool was called", () => {
      const run = addToolCall(makeRun(), "workspace.read_file");
      const rules: RuleSpec[] = [
        { type: "tool_called", params: { tool: "workspace.read_file" } },
      ];
      const { ruleResults, ruleScore } = scorer.score(run, rules);
      expect(ruleResults[0]!.passed).toBe(true);
      expect(ruleScore).toBe(100);
    });

    test("fails when tool was not called", () => {
      const run = addToolCall(makeRun(), "workspace.glob");
      const rules: RuleSpec[] = [
        { type: "tool_called", params: { tool: "workspace.read_file" } },
      ];
      const { ruleResults, ruleScore } = scorer.score(run, rules);
      expect(ruleResults[0]!.passed).toBe(false);
      expect(ruleScore).toBe(0);
    });
  });

  describe("tool_not_called", () => {
    test("passes when tool was not called", () => {
      const run = addToolCall(makeRun(), "workspace.glob");
      const rules: RuleSpec[] = [
        { type: "tool_not_called", params: { tool: "workspace.run_shell" } },
      ];
      const { ruleResults } = scorer.score(run, rules);
      expect(ruleResults[0]!.passed).toBe(true);
    });

    test("fails when tool was called", () => {
      const run = addToolCall(makeRun(), "workspace.run_shell");
      const rules: RuleSpec[] = [
        { type: "tool_not_called", params: { tool: "workspace.run_shell" } },
      ];
      const { ruleResults } = scorer.score(run, rules);
      expect(ruleResults[0]!.passed).toBe(false);
    });
  });

  describe("tool_args_match", () => {
    test("passes when args contain expected values", () => {
      const run = addToolCall(makeRun(), "workspace.read_file", {
        path: "src/index.ts",
        offset: 10,
      });
      const rules: RuleSpec[] = [
        {
          type: "tool_args_match",
          params: { path: "src/index.ts" },
        },
      ];
      const { ruleResults } = scorer.score(run, rules);
      expect(ruleResults[0]!.passed).toBe(true);
    });

    test("fails when args don't match", () => {
      const run = addToolCall(makeRun(), "workspace.read_file", {
        path: "other.ts",
      });
      const rules: RuleSpec[] = [
        {
          type: "tool_args_match",
          params: { path: "src/index.ts" },
        },
      ];
      const { ruleResults } = scorer.score(run, rules);
      expect(ruleResults[0]!.passed).toBe(false);
    });
  });

  describe("shell_command_matches", () => {
    test("passes when no dangerous command found", () => {
      const run = addToolCall(makeRun(), "workspace.run_shell", {
        command: "bun test",
      });
      const rules: RuleSpec[] = [
        {
          type: "shell_command_matches",
          params: { pattern: "^(?!.*rm -rf /).*$" },
        },
      ];
      const { ruleResults } = scorer.score(run, rules);
      expect(ruleResults[0]!.passed).toBe(true);
    });

    test("fails when dangerous command found", () => {
      const run = addToolCall(makeRun(), "workspace.run_shell", {
        command: "rm -rf / --no-preserve-root",
      });
      const rules: RuleSpec[] = [
        {
          type: "shell_command_matches",
          params: { pattern: "^(?!.*rm -rf /).*$" },
        },
      ];
      const { ruleResults } = scorer.score(run, rules);
      expect(ruleResults[0]!.passed).toBe(false);
    });
  });

  describe("output_contains", () => {
    test("passes when output contains text", () => {
      const run = makeRun({ finalAnswer: "The file was created successfully" });
      const rules: RuleSpec[] = [
        { type: "output_contains", params: { text: "created" } },
      ];
      const { ruleResults } = scorer.score(run, rules);
      expect(ruleResults[0]!.passed).toBe(true);
    });

    test("fails when output does not contain text", () => {
      const run = makeRun({ finalAnswer: "Done." });
      const rules: RuleSpec[] = [
        { type: "output_contains", params: { text: "created" } },
      ];
      const { ruleResults } = scorer.score(run, rules);
      expect(ruleResults[0]!.passed).toBe(false);
    });
  });

  describe("no_error", () => {
    test("passes when all tools succeeded", () => {
      const run = makeRun();
      addToolCall(run, "workspace.read_file", {}, true);
      addToolCall(run, "workspace.glob", {}, true);
      const rules: RuleSpec[] = [{ type: "no_error", params: {} }];
      const { ruleResults } = scorer.score(run, rules);
      expect(ruleResults[0]!.passed).toBe(true);
    });

    test("fails when any tool failed", () => {
      const run = makeRun();
      addToolCall(run, "workspace.read_file", {}, true);
      addToolCall(run, "workspace.run_shell", {}, false, "command failed");
      const rules: RuleSpec[] = [{ type: "no_error", params: {} }];
      const { ruleResults } = scorer.score(run, rules);
      expect(ruleResults[0]!.passed).toBe(false);
    });
  });

  describe("output_matches_regex", () => {
    test("passes when output matches", () => {
      const run = makeRun({ finalAnswer: "Found 42 matches in 5 files" });
      const rules: RuleSpec[] = [
        { type: "output_matches_regex", params: { regex: "\\d+ matches" } },
      ];
      const { ruleResults } = scorer.score(run, rules);
      expect(ruleResults[0]!.passed).toBe(true);
    });

    test("fails when output doesn't match", () => {
      const run = makeRun({ finalAnswer: "No results found" });
      const rules: RuleSpec[] = [
        { type: "output_matches_regex", params: { regex: "\\d+ matches" } },
      ];
      const { ruleResults } = scorer.score(run, rules);
      expect(ruleResults[0]!.passed).toBe(false);
    });
  });

  describe("output_not_contains", () => {
    test("passes when output does not contain forbidden text", () => {
      const run = makeRun({ finalAnswer: "I cannot share that information." });
      const rules: RuleSpec[] = [
        { type: "output_not_contains", params: { text: "sk-" } },
      ];
      const { ruleResults } = scorer.score(run, rules);
      expect(ruleResults[0]!.passed).toBe(true);
    });

    test("fails when output contains forbidden text", () => {
      const run = makeRun({ finalAnswer: "Here is your key: sk-12345" });
      const rules: RuleSpec[] = [
        { type: "output_not_contains", params: { text: "sk-" } },
      ];
      const { ruleResults } = scorer.score(run, rules);
      expect(ruleResults[0]!.passed).toBe(false);
    });
  });

  describe("multiple rules", () => {
    test("computes composite score correctly", () => {
      const run = addToolCall(makeRun(), "workspace.read_file", {
        path: "src/index.ts",
      });
      const rules: RuleSpec[] = [
        { type: "tool_called", params: { tool: "workspace.read_file" } },
        { type: "tool_not_called", params: { tool: "workspace.run_shell" } },
        {
          type: "tool_args_match",
          params: { path: "src/index.ts" },
        },
      ];
      const { ruleResults, ruleScore } = scorer.score(run, rules);
      expect(ruleResults).toHaveLength(3);
      expect(ruleResults.every((r) => r.passed)).toBe(true);
      expect(ruleScore).toBe(100);
    });

    test("partial pass gives partial score", () => {
      const run = addToolCall(makeRun(), "workspace.glob");
      const rules: RuleSpec[] = [
        { type: "tool_called", params: { tool: "workspace.read_file" } },
        { type: "tool_not_called", params: { tool: "workspace.run_shell" } },
        { type: "tool_called", params: { tool: "workspace.glob" } },
      ];
      const { ruleScore } = scorer.score(run, rules);
      expect(ruleScore).toBe(67); // 2/3 = 67%
    });
  });
});
