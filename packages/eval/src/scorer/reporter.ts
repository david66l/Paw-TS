/**
 * Reporter — 评分报告格式化器
 * =============================
 *
 * 【是什么】
 * 将 ScoreReport（单次运行报告）和 AggregateScoreReport（聚合报告）
 * 格式化为 console（终端）、markdown 或 JSON 三种输出格式。
 *
 * 【为什么】
 * 不同使用场景需要不同的输出格式：
 * - Console：开发者本地运行评测，需要直观的终端输出（图标、颜色暗示）
 * - Markdown：生成评测文档、PR 评论、CI 摘要
 * - JSON：程序化消费、存储到数据库、与其他工具集成
 *
 * 【关键设计决策】
 * 1. **策略模式**：Reporter 持有 format 选项，renderRun/renderAggregate
 *    根据 format 分发到对应的私有方法。添加新格式只需新增方法 + case。
 * 2. **runSummary 辅助方法**：为 JSON 输出提供精炼的运行摘要（仅关键字段
 *    和使用过的工具集合），避免原始 EvalRunRecord 数据量过大。
 * 3. **showRuleDetails 开关**：默认开启，在 console/markdown 中显示
 *    每一条规则的详细检查结果（通过/失败），帮助定位问题根因。
 */

import type { ScoreReport, AggregateScoreReport } from "./types.js";
import type { EvalRunRecord } from "../eval-record.js";

/** 报告输出格式枚举 */
export type ReportFormat = "console" | "markdown" | "json";

/** Reporter 配置选项 */
export interface ReporterOptions {
  /** 输出格式 */
  readonly format: ReportFormat;
  /** 是否显示每条规则的详细检查结果 */
  readonly showRuleDetails?: boolean;
}

export class Reporter {
  constructor(private readonly opts: ReporterOptions = { format: "console" }) {}

  /**
   * 渲染单次运行报告。
   *
   * @param report 评分报告
   * @param run 原始运行记录（用于提取元数据如轮次数、耗时等）
   */
  renderRun(report: ScoreReport, run: EvalRunRecord): string {
    switch (this.opts.format) {
      case "json":
        return JSON.stringify({ report, runSummary: this.runSummary(run) }, null, 2);
      case "markdown":
        return this.renderRunMarkdown(report, run);
      default:
        return this.renderRunConsole(report, run);
    }
  }

  /**
   * 渲染聚合报告（同一用例多次重复的汇总）。
   */
  renderAggregate(report: AggregateScoreReport): string {
    switch (this.opts.format) {
      case "json":
        return JSON.stringify(report, null, 2);
      case "markdown":
        return this.renderAggregateMarkdown(report);
      default:
        return this.renderAggregateConsole(report);
    }
  }

  // ── Console 格式 ──

  /** Console 格式单次运行报告：显示 PASS/FAIL 图标、分数、goal 摘要、轮次和耗时 */
  private renderRunConsole(report: ScoreReport, run: EvalRunRecord): string {
    const status = report.passed ? "✅ PASS" : "❌ FAIL";
    const lines = [
      `${status}  ${report.testCaseId}  (rep #${report.repetitionIndex})  score=${report.overallScore}/100`,
      `  Goal: ${run.goal.slice(0, 80)}${run.goal.length > 80 ? "..." : ""}`,
      `  Turns: ${run.turns.length}  Duration: ${(run.durationMs / 1000).toFixed(1)}s`,
    ];

    if (report.ruleScore !== undefined) {
      lines.push(`  Rule score: ${report.ruleScore}/100`);
    }
    // 详细规则结果：每条规则一行，✓ 通过 ✗ 失败
    if (this.opts.showRuleDetails) {
      for (const r of report.ruleResults) {
        const icon = r.passed ? "✓" : "✗";
        lines.push(`    ${icon} ${r.ruleType}: ${r.detail ?? ""}`);
      }
    }

    return lines.join("\n");
  }

  /** Console 格式聚合报告：显示总评分、稳定度、分数范围和每次重复的得分 */
  private renderAggregateConsole(report: AggregateScoreReport): string {
    const status = report.passed ? "✅ PASS" : "❌ FAIL";
    const lines = [
      `\n${status}  ${report.testCaseId}  (${report.repetitionCount} reps)`,
      `  Overall: ${report.overallScore}/100  Stability: ${report.stabilityScore}%`,
      `  Range: ${report.minScore}-${report.maxScore}`,
    ];

    // 每次重复的详细分数
    if (this.opts.showRuleDetails) {
      for (const rep of report.perRepetition) {
        lines.push(`  Rep #${rep.repetitionIndex}: ${rep.overallScore}/100`);
      }
    }

    return lines.join("\n");
  }

  // ── Markdown 格式 ──

  /** Markdown 格式单次运行报告：使用标题和表格展示关键指标 */
  private renderRunMarkdown(report: ScoreReport, run: EvalRunRecord): string {
    const status = report.passed ? "✅" : "❌";
    const lines = [
      `## ${status} ${report.testCaseId} (rep #${report.repetitionIndex})`,
      "",
      `| Metric | Value |`,
      `|--------|-------|`,
      `| Score | ${report.overallScore}/100 |`,
      `| Rule Score | ${report.ruleScore ?? "N/A"} |`,
      `| Turns | ${run.turns.length} |`,
      `| Duration | ${(run.durationMs / 1000).toFixed(1)}s |`,
      "",
    ];

    // 规则详细结果使用 Markdown 列表
    if (this.opts.showRuleDetails && report.ruleResults.length > 0) {
      lines.push("### Rule Results", "");
      for (const r of report.ruleResults) {
        const icon = r.passed ? "✅" : "❌";
        lines.push(`- ${icon} **${r.ruleType}**: ${r.detail ?? ""}`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  /** Markdown 格式聚合报告：标题 + 表格展示总评分、稳定度、范围和重复次数 */
  private renderAggregateMarkdown(report: AggregateScoreReport): string {
    const status = report.passed ? "✅ PASS" : "❌ FAIL";
    const lines = [
      `# ${status} ${report.testCaseId}`,
      "",
      `| Metric | Value |`,
      `|--------|-------|`,
      `| Overall Score | ${report.overallScore}/100 |`,
      `| Stability | ${report.stabilityScore}% |`,
      `| Range | ${report.minScore}–${report.maxScore} |`,
      `| Repetitions | ${report.repetitionCount} |`,
      "",
    ];

    return lines.join("\n");
  }

  /**
   * 从 EvalRunRecord 中提取精炼摘要，用于 JSON 输出。
   * 只包含关键字段和去重后的工具列表，避免数据冗余。
   */
  private runSummary(run: EvalRunRecord): object {
    return {
      testCaseId: run.testCaseId,
      runId: run.runId,
      goal: run.goal.slice(0, 200),
      turns: run.turns.length,
      durationMs: run.durationMs,
      status: run.status,
      toolsUsed: [
        ...new Set(
          run.turns.flatMap((t) => t.toolExecutions.map((e) => e.tool)),
        ),
      ],
    };
  }
}
