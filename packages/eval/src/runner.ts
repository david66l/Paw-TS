/**
 * EvalRunner — executes test suites against the agent and collects scores.
 *
 * Each test case is run `repetitions` times to measure stability.
 * All runs use EvalDataCollector hooked into the orchestrator.
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

export interface EvalRunnerOptions {
  readonly model?: LanguageModel;
  /** Optional LLM judge model for subjective scoring (Phase 2). */
  readonly judgeModel?: LanguageModel;
  readonly workspaceRoot?: string;
  /** Run in an isolated git worktree to protect the working directory. */
  readonly sandbox?: boolean;
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
   *
   * When `sandbox` is enabled, creates a git worktree in a temp directory
   * so the agent cannot modify the user's working copy.
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

    // ── Sandbox setup ──
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

        for (let rep = 0; rep < repetitions; rep++) {
          totalRuns++;
          this.opts.onProgress?.(tc.id, rep + 1, totalCases);

          const record = await this.runSingleCase(tc, rep, activeWsRoot);
          allRecords.push(record);

          const report = await this.scoreRecord(record, tc, activeWsRoot);
          reports.push(report);

          console.log(this.reporter.renderRun(report, record));
        }

        const caseElapsed = ((Date.now() - caseStart) / 1000).toFixed(1);
        console.log(`  ⏱ ${caseElapsed}s`);

        const agg = this.aggregator.aggregate(
          tc.id,
          reports,
          this.settings.pass_threshold,
        );
        aggregateReports.push(agg);
        console.log(this.reporter.renderAggregate(agg));
      }
    } finally {
      // ── Sandbox cleanup ──
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
   * Run a single test case once.
   */
  private async runSingleCase(
    tc: TestCase,
    repIndex: number,
    workspaceRoot: string,
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
      // Sandbox mode: auto-approve mutating tools (workspace is isolated)
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
   * Uses RuleScorer always; adds LlmScorer when judgeModel is available.
   */
  private async scoreRecord(
    record: EvalRunRecord,
    tc: TestCase,
    workspaceRoot: string,
  ): Promise<ScoreReport> {
    const rules = tc.expected.rules ?? [];
    let { ruleResults, ruleScore, summary } = this.scorer.score(record, rules);

    // Post-run workspace verification for file_created/file_contains
    ruleResults = this.scorer.verifyWorkspaceRules(ruleResults, workspaceRoot);

    // Recompute rule score after verification
    const passedCount = ruleResults.filter((r) => r.passed).length;
    ruleScore = rules.length > 0 ? Math.round((passedCount / rules.length) * 100) : 100;
    summary =
      ruleResults.filter((r) => !r.passed).length === 0
        ? `All ${rules.length} rule(s) passed`
        : `${passedCount}/${rules.length} rule(s) passed`;

    let llmScoreValue: number | undefined;
    let dimensionScores: ScoreReport["dimensionScores"];

    // Phase 2: LLM judging when judge model is available
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
        // LLM judge failed — fall back to rule-only scoring
      }
    }

    // Weighted overall score
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
   * Generate the final suite-level report.
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

// ── Sandbox helpers ──

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

function cleanupSandbox(sandboxPath: string): void {
  try {
    execSync(`git worktree remove --force "${sandboxPath}"`, {
      stdio: "pipe",
      timeout: 10_000,
    });
  } catch {
    try { rmSync(sandboxPath, { recursive: true, force: true }); } catch { /* ok */ }
  }
  try {
    rmSync(join(sandboxPath, ".."), { recursive: true, force: true });
  } catch { /* ok */ }
}
