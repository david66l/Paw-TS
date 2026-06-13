/**
 * RuleScorer — deterministic, code-level scoring against RuleSpec rules.
 *
 * Examines EvalRunRecord (turn traces + tool executions + final answer)
 * and checks each rule without any LLM calls.
 */

import type { EvalRunRecord } from "../eval-record.js";
import type { RuleSpec } from "../test-suite/types.js";
import type { RuleResult } from "./types.js";

export class RuleScorer {
  /**
   * Score a single run record against a set of rules.
   * Returns a ScoreReport with per-rule results and an aggregate ruleScore.
   */
  score(run: EvalRunRecord, rules: RuleSpec[]): {
    ruleResults: RuleResult[];
    ruleScore: number;
    summary: string;
  } {
    if (rules.length === 0) {
      return { ruleResults: [], ruleScore: 100, summary: "No rules to check" };
    }

    const results = rules.map((rule) => this.checkRule(run, rule));
    const passed = results.filter((r) => r.passed).length;
    const ruleScore = Math.round((passed / results.length) * 100);

    const failures = results.filter((r) => !r.passed);
    const summary =
      failures.length === 0
        ? `All ${results.length} rule(s) passed`
        : `${passed}/${results.length} rule(s) passed. Failed: ${failures.map((f) => f.ruleType).join(", ")}`;

    return { ruleResults: results, ruleScore, summary };
  }

  // ── Per-rule checking ──

  private checkRule(run: EvalRunRecord, rule: RuleSpec): RuleResult {
    const params = rule.params as Record<string, unknown>;

    switch (rule.type) {
      case "tool_called":
        return this.checkToolCalled(run, String(params.tool ?? ""), rule);

      case "tool_not_called":
        return this.checkToolNotCalled(run, String(params.tool ?? ""), rule);

      case "tool_args_match":
        return this.checkToolArgsMatch(
          run,
          String(params.tool ?? ""),
          params,
          rule,
        );

      case "shell_command_matches":
        return this.checkShellCommandMatches(
          run,
          String(params.pattern ?? ""),
          rule,
        );

      case "output_contains":
        return this.checkOutputContains(
          run,
          String(params.text ?? ""),
          rule,
        );

      case "output_not_contains":
        return this.checkOutputNotContains(
          run,
          String(params.text ?? ""),
          rule,
        );

      case "output_matches_regex":
        return this.checkOutputMatchesRegex(
          run,
          String(params.regex ?? ""),
          rule,
        );

      case "no_error":
        return this.checkNoError(run, rule);

      // file_created and file_contains require workspace state;
      // they are checked by the eval runner after the run completes.
      case "file_created":
        return this.deferToRunner("file_created", params, rule);

      case "file_contains":
        return this.deferToRunner("file_contains", params, rule);

      default:
        return {
          ruleType: rule.type,
          params: rule.params,
          description: rule.description,
          passed: false,
          detail: `Unknown rule type: ${rule.type}`,
        };
    }
  }

  // ── Individual checkers ──

  private checkToolCalled(
    run: EvalRunRecord,
    tool: string,
    rule: RuleSpec,
  ): RuleResult {
    for (const turn of run.turns) {
      for (const exec of turn.toolExecutions) {
        if (exec.tool === tool) {
          return {
            ruleType: rule.type,
            params: rule.params,
            description: rule.description,
            passed: true,
            detail: `Tool "${tool}" was called`,
          };
        }
      }
    }
    const allTools = run.turns.flatMap((t) =>
      t.toolExecutions.map((e) => e.tool),
    );
    return {
      ruleType: rule.type,
      params: rule.params,
      description: rule.description,
      passed: false,
      detail: `Tool "${tool}" was not called. Tools used: ${[...new Set(allTools)].join(", ") || "(none)"}`,
    };
  }

  private checkToolNotCalled(
    run: EvalRunRecord,
    tool: string,
    rule: RuleSpec,
  ): RuleResult {
    for (const turn of run.turns) {
      for (const exec of turn.toolExecutions) {
        if (exec.tool === tool) {
          return {
            ruleType: rule.type,
            params: rule.params,
            description: rule.description,
            passed: false,
            detail: `Tool "${tool}" was called but should not have been`,
          };
        }
      }
    }
    return {
      ruleType: rule.type,
      params: rule.params,
      description: rule.description,
      passed: true,
      detail: `Tool "${tool}" was not called (correct)`,
    };
  }

  private checkToolArgsMatch(
    run: EvalRunRecord,
    tool: string,
    params: Record<string, unknown>,
    rule: RuleSpec,
  ): RuleResult {
    // Extract the expected key-value pairs (excluding metadata keys)
    const expected: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(params)) {
      if (k !== "tool" && k !== "pattern" && k !== "text" && k !== "regex") {
        expected[k] = v;
      }
    }

    if (Object.keys(expected).length === 0) {
      return {
        ruleType: rule.type,
        params: rule.params,
        description: rule.description,
        passed: true,
        detail: "No arg constraints to check",
      };
    }

    // If no specific tool is named, check all tool calls
    const matchTool = tool.length > 0;

    for (const turn of run.turns) {
      for (const exec of turn.toolExecutions) {
        if (matchTool && exec.tool !== tool) continue;
        const args = exec.args as Record<string, unknown> | undefined;
        if (!args) continue;

        let allMatch = true;
        const mismatches: string[] = [];
        for (const [key, expectedVal] of Object.entries(expected)) {
          const actualVal = args[key];
          if (typeof expectedVal === "string" && typeof actualVal === "string") {
            if (!actualVal.includes(expectedVal)) {
              allMatch = false;
              mismatches.push(`${key}: expected to contain "${expectedVal}", got "${actualVal}"`);
            }
          } else if (JSON.stringify(actualVal) !== JSON.stringify(expectedVal)) {
            allMatch = false;
            mismatches.push(
              `${key}: expected ${JSON.stringify(expectedVal)}, got ${JSON.stringify(actualVal)}`,
            );
          }
        }

        if (allMatch) {
          const matchedTool = matchTool ? tool : exec.tool;
          return {
            ruleType: rule.type,
            params: rule.params,
            description: rule.description,
            passed: true,
            detail: `Tool "${matchedTool}" args matched: ${JSON.stringify(expected)}`,
          };
        }
      }
    }

    const desc = matchTool
      ? `Tool "${tool}" was not called with matching args`
      : `No tool was called with matching args`;
    return {
      ruleType: rule.type,
      params: rule.params,
      description: rule.description,
      passed: false,
      detail: `${desc}. Expected: ${JSON.stringify(expected)}`,
    };
  }

  private checkShellCommandMatches(
    run: EvalRunRecord,
    pattern: string,
    rule: RuleSpec,
  ): RuleResult {
    const shellCommands: string[] = [];
    const violations: string[] = [];

    for (const turn of run.turns) {
      for (const exec of turn.toolExecutions) {
        if (exec.tool === "workspace.run_shell") {
          const cmd = String((exec.args as Record<string, unknown>)?.command ?? "");
          shellCommands.push(cmd);

          // The pattern is typically a negative lookahead (e.g., "^(?!.*rm -rf).*$")
          // If the pattern is a full regex, test the command against it.
          try {
            const regex = new RegExp(pattern);
            if (!regex.test(cmd)) {
              violations.push(cmd);
            }
          } catch {
            // If pattern is not a valid regex, use simple substring check
            if (cmd.includes(pattern)) {
              violations.push(cmd);
            }
          }
        }
      }
    }

    if (violations.length > 0) {
      return {
        ruleType: rule.type,
        params: rule.params,
        description: rule.description,
        passed: false,
        detail: `Shell command(s) violated pattern "${pattern}": ${violations.join("; ")}`,
      };
    }

    return {
      ruleType: rule.type,
      params: rule.params,
      description: rule.description,
      passed: true,
      detail:
        shellCommands.length > 0
          ? `All ${shellCommands.length} shell command(s) matched pattern`
          : "No shell commands executed",
    };
  }

  private checkOutputContains(
    run: EvalRunRecord,
    text: string,
    rule: RuleSpec,
  ): RuleResult {
    const answer = (run.finalAnswer ?? "").toLowerCase();
    const search = text.toLowerCase();

    if (answer.includes(search)) {
      return {
        ruleType: rule.type,
        params: rule.params,
        description: rule.description,
        passed: true,
        detail: `Output contains "${text}"`,
      };
    }

    // Also check last turn's model output
    const lastTurn = run.turns[run.turns.length - 1];
    const lastOutput = lastTurn?.modelOutput.rawText.toLowerCase() ?? "";
    if (lastOutput.includes(search)) {
      return {
        ruleType: rule.type,
        params: rule.params,
        description: rule.description,
        passed: true,
        detail: `Output contains "${text}" (found in last model response)`,
      };
    }

    return {
      ruleType: rule.type,
      params: rule.params,
      description: rule.description,
      passed: false,
      detail: `Output does not contain "${text}"`,
    };
  }

  private checkOutputNotContains(
    run: EvalRunRecord,
    text: string,
    rule: RuleSpec,
  ): RuleResult {
    const answer = (run.finalAnswer ?? "").toLowerCase();
    const search = text.toLowerCase();

    if (answer.includes(search)) {
      return {
        ruleType: rule.type,
        params: rule.params,
        description: rule.description,
        passed: false,
        detail: `Output should not contain "${text}" but it does`,
      };
    }

    return {
      ruleType: rule.type,
      params: rule.params,
      description: rule.description,
      passed: true,
      detail: `Output correctly does not contain "${text}"`,
    };
  }

  private checkOutputMatchesRegex(
    run: EvalRunRecord,
    regex: string,
    rule: RuleSpec,
  ): RuleResult {
    const answer = run.finalAnswer ?? "";
    try {
      const re = new RegExp(regex);
      if (re.test(answer)) {
        return {
          ruleType: rule.type,
          params: rule.params,
          description: rule.description,
          passed: true,
          detail: `Output matches regex /${regex}/`,
        };
      }
      return {
        ruleType: rule.type,
        params: rule.params,
        description: rule.description,
        passed: false,
        detail: `Output does not match regex /${regex}/`,
      };
    } catch {
      return {
        ruleType: rule.type,
        params: rule.params,
        description: rule.description,
        passed: false,
        detail: `Invalid regex: ${regex}`,
      };
    }
  }

  private checkNoError(
    run: EvalRunRecord,
    rule: RuleSpec,
  ): RuleResult {
    const failures: string[] = [];
    for (const turn of run.turns) {
      for (const exec of turn.toolExecutions) {
        if (!exec.ok) {
          failures.push(`${exec.tool}: ${exec.result}`);
        }
      }
    }

    if (failures.length > 0) {
      return {
        ruleType: rule.type,
        params: rule.params,
        description: rule.description,
        passed: false,
        detail: `${failures.length} tool failure(s): ${failures.slice(0, 3).join("; ")}`,
      };
    }

    return {
      ruleType: rule.type,
      params: rule.params,
      description: rule.description,
      passed: true,
      detail: "No tool errors detected",
    };
  }

  /** Rules that need workspace access are deferred. */
  private deferToRunner(
    ruleType: string,
    _params: Record<string, unknown>,
    rule: RuleSpec,
  ): RuleResult {
    return {
      ruleType: rule.type,
      params: rule.params,
      description: rule.description,
      passed: true, // optimistic; runner will override with actual check
      detail: `[DEFERRED] ${ruleType} check requires workspace state — runner will verify`,
    };
  }
}
