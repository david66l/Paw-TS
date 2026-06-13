/**
 * EvalRunner — executes test suites against the agent and collects scores.
 *
 * Each test case is run `repetitions` times to measure stability.
 * All runs use EvalDataCollector hooked into the orchestrator.
 */

import { AgentOrchestrator, type AgentOrchestratorOptions } from "@paw/agent";
import type { LanguageModel } from "@paw/models";
import type { TestCase } from "./test-suite/types.js";
import type { EvalRunRecord } from "./eval-record.js";
import { EvalDataCollector } from "./data-collector.js";
import { RuleScorer } from "./scorer/rule-scorer.js";
import { Aggregator } from "./scorer/aggregator.js";
import { Reporter, type ReportFormat } from "./scorer/reporter.js";
import { resolveEvalSettings, type EvalSettings } from "./eval-settings.js";
import type { ScoreReport, AggregateScoreReport } from "./scorer/types.js";

export interface EvalRunnerOptions {
  readonly model?: LanguageModel;
  readonly workspaceRoot?: string;
  readonly settings?: Partial<EvalSettings>;
  readonly reportFormat?: ReportFormat;
  readonly onProgress?: (testCaseId: string, rep: number, total: number) => void;
}

export interface EvalRunnerResult {
  readonly suiteName: string;
  readonly aggregateReports: AggregateScoreReport[];
  readonly allRecords: EvalRunRecord[];
  readonly overallPassRate: number;
  readonly formattedReport: string;
}

export class EvalRunner {
  private readonly scorer = new RuleScorer();
  private readonly aggregator = new Aggregator();
  private readonly reporter: Reporter;
  private readonly settings: Required<EvalSettings>;

  constructor(private readonly opts: EvalRunnerOptions = {}) {
    this.reporter = new Reporter({
      format: opts.reportFormat ?? "console",
      showRuleDetails: true,
    });
    this.settings = resolveEvalSettings(opts.settings);
  }

  /**
   * Run a full test suite.
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

    for (const tc of cases) {
      const reports: ScoreReport[] = [];

      for (let rep = 0; rep < repetitions; rep++) {
        totalRuns++;
        this.opts.onProgress?.(tc.id, rep + 1, totalCases);

        const record = await this.runSingleCase(tc, rep);
        allRecords.push(record);

        const report = this.scoreRecord(record, tc);
        reports.push(report);

        console.log(this.reporter.renderRun(report, record));
      }

      const agg = this.aggregator.aggregate(
        tc.id,
        reports,
        this.settings.pass_threshold,
      );
      aggregateReports.push(agg);
      console.log(this.reporter.renderAggregate(agg));
    }

    const passed = aggregateReports.filter((r) => r.passed).length;
    const passRate =
      aggregateReports.length > 0
        ? Math.round((passed / aggregateReports.length) * 100)
        : 0;

    const formattedReport = this.formatFinalReport(
      suiteName,
      aggregateReports,
      passRate,
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
   * Run a single test case once.
   */
  private async runSingleCase(
    tc: TestCase,
    repIndex: number,
  ): Promise<EvalRunRecord> {
    const runId = `eval-${tc.id}-rep${repIndex}-${Date.now()}`;
    const modelLabel = this.opts.model?.label ?? "default";

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
      memoryExtraction: "off", // disable for evals
    };

    const orchestrator = new AgentOrchestrator(orchestratorOpts);

    let status: EvalRunRecord["status"] = "completed";
    let finalAnswer: string | undefined;
    let error: string | undefined;

    try {
      const result = await orchestrator.run({
        runId,
        goal: tc.goal,
        workspaceRoot: this.opts.workspaceRoot ?? process.cwd(),
        maxSteps: 20, // reasonable limit for test cases
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

    return collector.finalize(status, finalAnswer, error);
  }

  /**
   * Score a single run record against its test case expectations.
   */
  private scoreRecord(record: EvalRunRecord, tc: TestCase): ScoreReport {
    const rules = tc.expected.rules ?? [];
    const { ruleResults, ruleScore, summary } = this.scorer.score(record, rules);

    // For now, overall score = rule score (LLM scoring is Phase 2)
    const overallScore = ruleScore;
    const passed = overallScore >= this.settings.pass_threshold;

    return {
      testCaseId: tc.id,
      repetitionIndex: record.repetitionIndex,
      overallScore,
      ruleScore,
      ruleResults,
      passed,
      summary,
    };
  }

  /**
   * Generate the final suite-level report.
   */
  private formatFinalReport(
    suiteName: string,
    reports: AggregateScoreReport[],
    passRate: number,
  ): string {
    const lines = [
      `\n${"=".repeat(60)}`,
      `Suite: ${suiteName}`,
      `Cases: ${reports.length}  Repetitions/case: ${this.settings.default_repetitions}`,
      `Pass rate: ${passRate}%  Threshold: ${this.settings.pass_threshold}/100`,
      `Rule weight: ${this.settings.rule_weight}  LLM weight: ${this.settings.llm_weight}`,
      `Failed cases: ${reports.filter((r) => !r.passed).map((r) => r.testCaseId).join(", ") || "(none)"}`,
      `${"=".repeat(60)}`,
    ];
    return lines.join("\n");
  }
}
