/**
 * RuleScorer — 规则评分器
 * ========================
 *
 * 【是什么】
 * 基于确定性规则的评分引擎。检查 EvalRunRecord（包含轮次追踪、工具调用、
 * 最终答案）是否满足测试用例中定义的 RuleSpec 规则，生成每行规则的
 * 通过/失败结果和总分。
 *
 * 【为什么】
 * 规则评分是评测系统的核心可信度来源，因为它是确定性的——相同输入
 * 永远产生相同结果。它检查的是一阶的"对不对"：
 * - 工具是否被正确调用
 * - Shell 命令是否安全
 * - 输出是否包含必要内容
 * - 文件是否被创建
 *
 * LLM 评判（llm-scorer）检查"好不好"，规则评分检查"对不对"，
 * 两者互补构成完整的评分体系。
 *
 * 【关键设计决策】
 * 1. **策略模式分发**：`checkRule` 根据 RuleType 分发到具体的 check 方法，
 *    每种规则类型有独立的检查逻辑，便于理解和维护。
 * 2. **大小写不敏感检查**：output_contains/output_not_contains 默认
 *    toLowerCase 比较，避免大小写差异引起的假阴性。
 * 3. **后置验证（Deferred）**：file_created 和 file_contains 规则在 score()
 *    中返回 [DEFERRED] 标记，由 `verifyWorkspaceRules()` 在 Runner 完成
 *    所有执行后进行实际的文件系统检查。这是必要的，因为文件操作
 *    在 Agent 运行过程中生效，需要等全部结束后再验证。
 * 4. **Shell 命令检查双模式**：pattern 如果可以被解析为正则表达式，
 *    则用正则匹配（支持负向先行断言如 "^(?!.*rm -rf).*$"）；
 *    否则回退到简单子串匹配。
 * 5. **tool_args_match 灵活匹配**：对于字符串类型的参数值，使用 includes
 *    而非严格相等，允许 partial match——这在工具参数中常用于检查
 *    是否包含某个关键子串（如检查文件路径是否在某个目录下）。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { EvalRunRecord } from "../eval-record.js";
import type { RuleSpec } from "../test-suite/types.js";
import type { RuleResult } from "./types.js";

export class RuleScorer {
  /**
   * 对单次运行记录按规则集评分。
   *
   * @param run 评测运行记录
   * @param rules 规则集
   * @returns 包含逐条规则结果、规则总分和摘要文字的结果对象
   */
  score(run: EvalRunRecord, rules: RuleSpec[]): {
    ruleResults: RuleResult[];
    ruleScore: number;
    summary: string;
  } {
    if (rules.length === 0) {
      return { ruleResults: [], ruleScore: 100, summary: "No rules to check" };
    }

    // 逐条检查所有规则
    const results = rules.map((rule) => this.checkRule(run, rule));
    const passed = results.filter((r) => r.passed).length;
    // 规则分数 = 通过率 * 100
    const ruleScore = Math.round((passed / results.length) * 100);

    // 生成摘要文字：全部通过 vs 列出失败项
    const failures = results.filter((r) => !r.passed);
    const summary =
      failures.length === 0
        ? `All ${results.length} rule(s) passed`
        : `${passed}/${results.length} rule(s) passed. Failed: ${failures.map((f) => f.ruleType).join(", ")}`;

    return { ruleResults: results, ruleScore, summary };
  }

  // ── 规则分发 ──

  /**
   * 根据规则类型分发到具体的检查方法。
   *
   * file_created 和 file_contains 规则在此返回 [DEFERRED]，
   * 由 Runner 在运行结束后调用 verifyWorkspaceRules 统一验证。
   */
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

      // file_created 和 file_contains 需要访问实际工作区文件系统；
      // 它们被标记为 [DEFERRED]，由 EvalRunner 在运行结束后统一验证。
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

  // ── 各规则检查方法 ──

  /**
   * 检查指定工具是否被调用过。
   * 遍历所有轮次的所有工具调用，匹配工具名称。
   * 失败时列出实际调用的所有工具名。
   */
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

  /**
   * 检查指定工具是否没有被调用过（反向检查）。
   * 例如：验证 Agent 没有使用 `workspace.run_shell` 执行危险命令。
   */
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

  /**
   * 检查工具调用参数是否匹配预期。
   *
   * 匹配规则：
   * - 从 params 中排除元数据键（tool/pattern/text/regex），剩余的是期望参数
   * - 如果指定了 tool 名称，只检查该工具的调用；否则检查所有工具
   * - 字符串参数使用 includes 匹配（宽松），其他类型使用 JSON 序列化后严格匹配
   *
   * 这种宽松匹配设计是因为工具参数常常包含动态内容（如完整路径），
   * 只检查是否包含关键子串更实用。
   */
  private checkToolArgsMatch(
    run: EvalRunRecord,
    tool: string,
    params: Record<string, unknown>,
    rule: RuleSpec,
  ): RuleResult {
    // 提取预期的键值对（排除元数据键如 tool/pattern/text/regex）
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

    // 如果指定了具体工具名，只检查该工具的调用；否则检查所有工具
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
            // 字符串：includes 宽松匹配
            if (!actualVal.includes(expectedVal)) {
              allMatch = false;
              mismatches.push(`${key}: expected to contain "${expectedVal}", got "${actualVal}"`);
            }
          } else if (JSON.stringify(actualVal) !== JSON.stringify(expectedVal)) {
            // 非字符串：JSON 严格匹配
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

  /**
   * 检查 Shell 命令是否匹配指定模式。
   *
   * 双模式匹配：
   * 1. pattern 能被解析为有效正则 → 使用正则测试（支持负向先行断言等高级模式）
   * 2. pattern 不是有效正则 → 降级为简单子串包含检查
   *
   * 典型用例：pattern="^(?!.*rm -rf).*$" 确保没有危险命令。
   */
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

          // 尝试作为正则匹配，失败时回退到子串查找
          try {
            const regex = new RegExp(pattern);
            if (!regex.test(cmd)) {
              violations.push(cmd);
            }
          } catch {
            // 正则无效 → 简单子串匹配
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

  /**
   * 检查输出是否包含指定文本（大小写不敏感）。
   *
   * 检查两层：
   * 1. finalAnswer（Agent 的最终回答）
   * 2. 最后一轮模型输出（rawText）
   * 任一满足即通过。
   */
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

    // 兜底：检查最后一轮的模型原始输出
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

  /**
   * 检查输出是否不包含指定文本（反向检查，大小写不敏感）。
   *
   * 用于验证 Agent 没有输出不安全/不符合要求的内容，
   * 如暴露密钥、提供危险建议等。
   */
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

  /**
   * 检查输出是否匹配正则表达式。
   *
   * 如果正则表达式本身无效（解析失败），视为规则检查失败
   * 并给出明确的错误信息，帮助测试用例编写者修正正则。
   */
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

  /**
   * 检查运行过程中是否没有任何工具错误。
   *
   * 遍历所有轮次的所有工具调用，检查 ok 字段。
   * 失败时列出前 3 个错误（避免错误信息过长）。
   */
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

  /**
   * 延迟到 Runner 验证的规则（file_created / file_contains）。
   *
   * 这些规则返回 [DEFERRED] 标记，在 Runner.runSuite 的 scoreRecord 中
   * 会调用 verifyWorkspaceRules 进行实际验证后替换。
   */
  private deferToRunner(
    ruleType: string,
    _params: Record<string, unknown>,
    rule: RuleSpec,
  ): RuleResult {
    return {
      ruleType: rule.type,
      params: rule.params,
      description: rule.description,
      passed: false, // 默认不通过，等待后续验证
      detail: `[DEFERRED] ${ruleType} — pending workspace verification`,
    };
  }

  /**
   * 验证后置规则（file_created 和 file_contains）。
   *
   * 遍历 RuleResult 数组，找到 [DEFERRED] 标记的结果，
   * 对实际工作区文件系统进行检查并替换为真实的通过/失败结果。
   *
   * 设计原因：这些规则需要 Agent 完全执行完毕后的最终文件系统状态，
   * 不能在评分时即时判断。
   */
  verifyWorkspaceRules(
    results: RuleResult[],
    workspaceRoot: string,
  ): RuleResult[] {
    return results.map((r) => {
      if (!r.detail?.startsWith("[DEFERRED]")) return r;

      const params = r.params as Record<string, unknown>;
      const path = String(params.path ?? "");

      if (r.ruleType === "file_created") {
        return this.verifyFileCreated(path, workspaceRoot, r);
      }
      if (r.ruleType === "file_contains") {
        const text = String(params.text ?? "");
        return this.verifyFileContains(path, text, workspaceRoot, r);
      }
      return r;
    });
  }

  /**
   * 验证文件是否被创建。
   *
   * 使用 Node.js 的 existsSync 检查文件是否存在。
   * 路径基于 workspaceRoot 拼接为绝对路径。
   */
  private verifyFileCreated(
    relPath: string,
    workspaceRoot: string,
    rule: RuleResult,
  ): RuleResult {
    const fullPath = join(workspaceRoot, relPath);

    try {
      const exists = existsSync(fullPath);
      if (exists) {
        return {
          ...rule,
          passed: true,
          detail: `File "${relPath}" exists`,
        };
      }
      return {
        ...rule,
        passed: false,
        detail: `File "${relPath}" was not created`,
      };
    } catch (e) {
      return {
        ...rule,
        passed: false,
        detail: `Cannot check file "${relPath}": ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  /**
   * 验证文件是否包含指定文本。
   *
   * 使用 Node.js 的 readFileSync 读取文件内容（UTF-8），
   * 检查是否包含指定文本（直接子串匹配，大小写敏感）。
   */
  private verifyFileContains(
    relPath: string,
    text: string,
    workspaceRoot: string,
    rule: RuleResult,
  ): RuleResult {
    const fullPath = join(workspaceRoot, relPath);

    try {
      const content = readFileSync(fullPath, "utf-8");
      if (content.includes(text)) {
        return {
          ...rule,
          passed: true,
          detail: `File "${relPath}" contains "${text}"`,
        };
      }
      return {
        ...rule,
        passed: false,
        detail: `File "${relPath}" does not contain "${text}"`,
      };
    } catch (e) {
      return {
        ...rule,
        passed: false,
        detail: `Cannot read file "${relPath}": ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }
}
