/**
 * EvalRunner — 评测运行器，执行测试套件并生成评分报告
 * =========================================================
 *
 * 【是什么】
 * EvalRunner 是评测系统的核心执行引擎。它接收测试套件（TestCase 数组），
 * 通过 AgentOrchestrator 实际运行每个测试用例，收集运行记录，然后进行
 * 规则评分和 LLM 评分，最终生成聚合报告。
 *
 * 【为什么】
 * 评测需要一个统一的执行框架来协调"运行→收集→评分→聚合→报告"全流程。
 * 这确保：
 * - 所有测试用例在一致的环境下执行
 * - 每个用例被重复运行多次以测量稳定性
 * - 沙箱模式保护用户的工作目录不被修改
 * - 评分逻辑（规则 vs LLM）以标准化的权重合并
 *
 * 【关键设计决策】
 * 1. **沙箱隔离**：通过 `git worktree add --detach` 在临时目录创建
 *    独立的 worktree，Agent 的所有文件操作都在沙箱内，运行结束后自动
 *    清理。在沙箱中自动批准所有变更工具（因为 worktree 是临时的）。
 * 2. **评分流程**：rule_score * rule_weight + llm_score * llm_weight
 *    得到加权总分，与 pass_threshold 比较判断是否通过。如果 judgeModel
 *    不可用，则仅使用规则评分。
 * 3. **重复运行**：每个测试用例重复 `repetitions` 次，统计均值和变异系数，
 *    衡量 Agent 行为的稳定性。非确定性的 LLM 输出可能导致同一用例
 *    在不同运行中得到不同分数。
 * 4. **workspace 验证后置**：file_created 和 file_contains 规则被标记为
 *    [DEFERRED]，在运行结束后由 verifyWorkspaceRules 实际检查文件系统。
 *    这是因为这些规则需要等 Agent 的整个运行完全结束后才能验证。
 * 5. **运行限制**：maxSteps=20，防止 Agent 陷入无限循环或过度调用工具。
 * 6. **记忆提取禁用**：评测中设置 memoryExtraction="off"，避免记忆系统
 *    污染评测的纯净度——每次运行应该独立评估，不受历史记忆影响。
 */

import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentOrchestrator, type AgentOrchestratorOptions } from "@paw/agent";
import type { LanguageModel } from "@paw/models";
import type { TestCase } from "./test-suite/types.js";
import type { EvalRunRecord } from "./eval-record.js";
import { EvalDataCollector } from "./data-collector.js";
import { RuleScorer } from "./scorer/rule-scorer.js";
import { llmScore } from "./scorer/llm-scorer.js";
import { Aggregator } from "./scorer/aggregator.js";
import { Reporter, type ReportFormat } from "./scorer/reporter.js";
import { resolveEvalSettings, type EvalSettings } from "./eval-settings.js";
import type { ScoreReport, AggregateScoreReport } from "./scorer/types.js";

/** EvalRunner 构造函数参数 */
export interface EvalRunnerOptions {
  /** Agent 使用的语言模型 */
  readonly model?: LanguageModel;
  /** 可选的 LLM 评判模型（用于主观评分，Phase 2） */
  readonly judgeModel?: LanguageModel;
  /** 工作区根目录（默认为当前目录） */
  readonly workspaceRoot?: string;
  /** 在隔离的 git worktree 中运行，保护用户工作目录 */
  readonly sandbox?: boolean;
  /** 评测设置覆盖值 */
  readonly settings?: Partial<EvalSettings>;
  /** 报告输出格式 */
  readonly reportFormat?: ReportFormat;
  /** 进度回调：每个测试用例每次重复开始时调用 */
  readonly onProgress?: (testCaseId: string, rep: number, total: number) => void;
}

/** EvalRunner.runSuite 的返回结果 */
export interface EvalRunnerResult {
  /** 套件名称 */
  readonly suiteName: string;
  /** 所有用例的聚合报告 */
  readonly aggregateReports: AggregateScoreReport[];
  /** 所有原始运行记录 */
  readonly allRecords: EvalRunRecord[];
  /** 整体通过率 0-100 */
  readonly overallPassRate: number;
  /** 格式化后的最终报告文本 */
  readonly formattedReport: string;
}

/**
 * 评测运行器主类。
 *
 * 典型用法：
 * ```
 * const runner = new EvalRunner({ model, sandbox: true });
 * const result = await runner.runSuite("my-suite", testCases);
 * console.log(result.formattedReport);
 * ```
 */
export class EvalRunner {
  /** 规则评分器（确定性评分） */
  private readonly scorer = new RuleScorer();
  /** 聚合器（多重复运行合并为稳定度指标） */
  private readonly aggregator = new Aggregator();
  /** 报告生成器 */
  private readonly reporter: Reporter;
  /** 解析后的评测设置（所有字段有默认值） */
  private readonly settings: Required<EvalSettings>;

  constructor(private readonly opts: EvalRunnerOptions = {}) {
    this.reporter = new Reporter({
      format: opts.reportFormat ?? "console",
      showRuleDetails: true,
    });
    this.settings = resolveEvalSettings(opts.settings);
  }

  /**
   * 运行完整的测试套件。
   *
   * 当 `sandbox` 启用时，在临时目录创建 git worktree 作为隔离工作区，
   * 运行结束后自动清理。沙箱中的 worktree 是独立的，Agent 的修改不会
   * 影响用户的实际工作目录。
   *
   * @param suiteName 套件名称（用于报告展示）
   * @param cases 测试用例数组
   * @returns 完整的评测结果
   */
  async runSuite(
    suiteName: string,
    cases: TestCase[],
  ): Promise<EvalRunnerResult> {
    const repetitions = this.settings.default_repetitions;
    const aggregateReports: AggregateScoreReport[] = [];
    const allRecords: EvalRunRecord[] = [];
    let totalRuns = 0;
    const totalCases = cases.length * repetitions;
    const originalWsRoot = this.opts.workspaceRoot ?? process.cwd();

    // ── 沙箱设置：在临时目录创建独立的 git worktree ──
    let sandboxPath: string | undefined;
    if (this.opts.sandbox) {
      sandboxPath = createSandbox(originalWsRoot);
      console.log(`[sandbox] Isolated workspace: ${sandboxPath}`);
    }
    const activeWsRoot = sandboxPath ?? originalWsRoot;

    const suiteStart = Date.now();

    try {
      for (const tc of cases) {
        const reports: ScoreReport[] = [];
        const caseStart = Date.now();

        // 每个用例重复运行多次以评估稳定性
        for (let rep = 0; rep < repetitions; rep++) {
          totalRuns++;
          this.opts.onProgress?.(tc.id, rep + 1, totalCases);

          // 步骤1：运行用例并收集记录
          const record = await this.runSingleCase(tc, rep, activeWsRoot);
          allRecords.push(record);

          // 步骤2：对运行记录评分
          const report = await this.scoreRecord(record, tc, activeWsRoot);
          reports.push(report);

          console.log(this.reporter.renderRun(report, record));
        }

        const caseElapsed = ((Date.now() - caseStart) / 1000).toFixed(1);
        console.log(`  ⏱ ${caseElapsed}s`);

        // 步骤3：聚合同一用例的多次重复运行结果
        const agg = this.aggregator.aggregate(
          tc.id,
          reports,
          this.settings.pass_threshold,
        );
        aggregateReports.push(agg);
        console.log(this.reporter.renderAggregate(agg));
      }
    } finally {
      // ── 沙箱清理：无论运行成功与否，都要清理临时 worktree ──
      if (sandboxPath) {
        cleanupSandbox(sandboxPath);
        console.log(`[sandbox] Cleaned up: ${sandboxPath}`);
      }
    }

    const elapsed = ((Date.now() - suiteStart) / 1000).toFixed(1);
    const passed = aggregateReports.filter((r) => r.passed).length;
    const passRate =
      aggregateReports.length > 0
        ? Math.round((passed / aggregateReports.length) * 100)
        : 0;

    const formattedReport = this.formatFinalReport(
      suiteName,
      aggregateReports,
      passRate,
      elapsed,
    );

    return {
      suiteName,
      aggregateReports,
      allRecords,
      overallPassRate: passRate,
      formattedReport,
    };
  }

  /**
   * 运行单个测试用例一次。
   *
   * 创建一个 AgentOrchestrator 实例，配置 EvalDataCollector 作为 evalHooks
   * 来捕获运行过程的所有细节。设置 maxSteps=20 防止无限循环。
   *
   * 关键设计：评测中禁用记忆提取（memoryExtraction="off"）并自动批准所有工具调用。
   * 这是因为评测需要每次独立运行，不受历史记忆污染；在沙箱模式下，
   * 工具调用是安全的（临时 worktree 会被清理）。
   */
  private async runSingleCase(
    tc: TestCase,
    repIndex: number,
    workspaceRoot: string,
  ): Promise<EvalRunRecord> {
    const runId = `eval-${tc.id}-rep${repIndex}-${Date.now()}`;
    const modelLabel = this.opts.model?.label ?? "default";

    // 创建数据收集器，后续通过钩子自动填充运行记录
    const collector = new EvalDataCollector(
      tc.id,
      repIndex,
      runId,
      tc.goal,
      modelLabel,
    );

    const orchestratorOpts: AgentOrchestratorOptions = {
      model: this.opts.model,
      evalHooks: collector,
      memoryExtraction: "off", // 评测中禁用以保证独立性
      // 沙箱模式下自动批准所有工具（worktree 是临时的）
      resolveToolApproval: async () => true,
    };

    const orchestrator = new AgentOrchestrator(orchestratorOpts);

    let status: EvalRunRecord["status"] = "completed";
    let finalAnswer: string | undefined;
    let error: string | undefined;

    try {
      const result = await orchestrator.run({
        runId,
        goal: tc.goal,
        workspaceRoot,
        maxSteps: 20, // 限制步数，防止无限循环
      });

      if (result.status === "completed") {
        finalAnswer = result.message;
        status = "completed";
      } else {
        status = "failed";
        error = result.message;
      }
    } catch (e) {
      status = "error";
      error = e instanceof Error ? e.message : String(e);
    }

    // 固化收集器中的所有轮次，生成最终记录
    return collector.finalize(status, finalAnswer, error);
  }

  /**
   * 对单次运行记录进行评分。
   *
   * 评分流程：
   * 1. 先运行 RuleScorer（处理所有规则类型）
   * 2. 调用 verifyWorkspaceRules 后置验证 file_created/file_contains 规则
   * 3. 重新计算规则分数（因为验证可能改变了某些规则的结果）
   * 4. 如果 judgeModel 可用，运行 LlmScorer 进行主观维度评分
   * 5. 加权合并规则分和 LLM 分：
   *    overallScore = ruleScore * rule_weight + llmScore * llm_weight
   *    如果没有 LLM 分，则 overallScore = ruleScore
   * 6. 与 pass_threshold 比较判定是否通过
   */
  private async scoreRecord(
    record: EvalRunRecord,
    tc: TestCase,
    workspaceRoot: string,
  ): Promise<ScoreReport> {
    const rules = tc.expected.rules ?? [];
    let { ruleResults, ruleScore, summary } = this.scorer.score(record, rules);

    // 后置验证：检查需要访问实际文件系统的规则（file_created、file_contains）
    // 这些规则在运行期间被标记为 [DEFERRED]，现在进行实际验证
    ruleResults = this.scorer.verifyWorkspaceRules(ruleResults, workspaceRoot);

    // 验证后重新计算规则分数
    const passedCount = ruleResults.filter((r) => r.passed).length;
    ruleScore = rules.length > 0 ? Math.round((passedCount / rules.length) * 100) : 100;
    summary =
      ruleResults.filter((r) => !r.passed).length === 0
        ? `All ${rules.length} rule(s) passed`
        : `${passedCount}/${rules.length} rule(s) passed`;

    let llmScoreValue: number | undefined;
    let dimensionScores: ScoreReport["dimensionScores"];

    // Phase 2: LLM 评判——仅在 judgeModel 可用且测试用例定义了 llmJudgment 时执行
    if (this.opts.judgeModel && tc.expected.llmJudgment) {
      try {
        const result = await llmScore(
          this.opts.judgeModel,
          record,
          tc.expected.llmJudgment,
        );
        llmScoreValue = result.llmScore;
        dimensionScores = result.dimensionScores;
      } catch {
        // LLM 评判失败 → 回退到仅规则评分，确保系统不会因 judge 崩溃而中断
      }
    }

    // 加权计算总分：规则分和 LLM 分按配置的权重合并
    const ruleWeight = this.settings.rule_weight;
    const llmWeight = this.settings.llm_weight;
    const overallScore =
      llmScoreValue !== undefined
        ? Math.round(ruleScore * ruleWeight + llmScoreValue * llmWeight)
        : ruleScore;

    const passed = overallScore >= this.settings.pass_threshold;

    return {
      testCaseId: tc.id,
      repetitionIndex: record.repetitionIndex,
      overallScore,
      ruleScore,
      llmScore: llmScoreValue,
      ruleResults,
      dimensionScores,
      passed,
      summary,
    };
  }

  /**
   * 生成套件级别的最终汇总报告。
   *
   * 包含：套件名称、用例数、重复策略、通过率、权重配置、失败用例列表、总耗时。
   */
  private formatFinalReport(
    suiteName: string,
    reports: AggregateScoreReport[],
    passRate: number,
    elapsed: string,
  ): string {
    const lines = [
      `\n${"=".repeat(60)}`,
      `Suite: ${suiteName}`,
      `Cases: ${reports.length}  Repetitions/case: ${this.settings.default_repetitions}`,
      `Pass rate: ${passRate}%  Threshold: ${this.settings.pass_threshold}/100`,
      `Rule weight: ${this.settings.rule_weight}  LLM weight: ${this.settings.llm_weight}`,
      `Failed cases: ${reports.filter((r) => !r.passed).map((r) => r.testCaseId).join(", ") || "(none)"}`,
      `Total elapsed: ${elapsed}s`,
      `${"=".repeat(60)}`,
    ];
    return lines.join("\n");
  }
}

// ── 沙箱辅助函数 ──

/**
 * 创建隔离的工作区沙箱。
 *
 * 在系统临时目录下创建 git worktree（detached HEAD），作为 Agent 的运行环境。
 * 这样 Agent 的所有文件操作都在这个临时 worktree 内，不会影响用户的原始仓库。
 *
 * 为什么用 `--detach`：我们只需要一个干净的工作副本，不需要占用分支名。
 * 沙箱运行结束后会直接删除整个 worktree 目录。
 */
function createSandbox(originalRoot: string): string {
  const tmpDir = mkdtempSync(join(tmpdir(), "paw-eval-"));
  const worktreePath = join(tmpDir, "workspace");
  execSync(`git worktree add --detach "${worktreePath}" HEAD`, {
    cwd: originalRoot,
    stdio: "pipe",
    timeout: 30_000,
  });
  return worktreePath;
}

/**
 * 清理沙箱工作区。
 *
 * 先尝试用 git worktree remove 正常移除（会清理 git 元数据），
 * 失败后使用 rmSync 强制递归删除（兜底处理）。
 * 同时清理父级临时目录。
 */
function cleanupSandbox(sandboxPath: string): void {
  try {
    execSync(`git worktree remove --force "${sandboxPath}"`, {
      stdio: "pipe",
      timeout: 10_000,
    });
  } catch {
    // worktree remove 失败（git 元数据可能已损坏），强制删除目录
    try { rmSync(sandboxPath, { recursive: true, force: true }); } catch { /* 忽略清理错误 */ }
  }
  try {
    rmSync(join(sandboxPath, ".."), { recursive: true, force: true });
  } catch { /* 忽略清理错误 */ }
}
