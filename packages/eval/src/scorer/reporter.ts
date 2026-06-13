/**
 * Reporter — formats score reports for console, markdown, and JSON output.
 */

import type { ScoreReport, AggregateScoreReport } from "./types.js";
import type { EvalRunRecord } from "../eval-record.js";

export type ReportFormat = "console" | "markdown" | "json";

export interface ReporterOptions {
  readonly format: ReportFormat;
  readonly showRuleDetails?: boolean;
}

export class Reporter {
  constructor(private readonly opts: ReporterOptions = { format: "console" }) {}

  /** Render a single-run score report. */
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

  /** Render an aggregate report. */
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

  // ── Console format ──

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
    if (this.opts.showRuleDetails) {
      for (const r of report.ruleResults) {
        const icon = r.passed ? "✓" : "✗";
        lines.push(`    ${icon} ${r.ruleType}: ${r.detail ?? ""}`);
      }
    }

    return lines.join("\n");
  }

  private renderAggregateConsole(report: AggregateScoreReport): string {
    const status = report.passed ? "✅ PASS" : "❌ FAIL";
    const lines = [
      `\n${status}  ${report.testCaseId}  (${report.repetitionCount} reps)`,
      `  Overall: ${report.overallScore}/100  Stability: ${report.stabilityScore}%`,
      `  Range: ${report.minScore}-${report.maxScore}`,
    ];

    if (this.opts.showRuleDetails) {
      for (const rep of report.perRepetition) {
        lines.push(`  Rep #${rep.repetitionIndex}: ${rep.overallScore}/100`);
      }
    }

    return lines.join("\n");
  }

  // ── Markdown format ──

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
