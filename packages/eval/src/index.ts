// Data collection
export { EvalDataCollector } from "./data-collector.js";
export type {
  EvalRunRecord,
  EvalTurnRecord,
  EvalToolExecution,
  EvalModelInput,
  EvalModelOutput,
  EvalContextSnapshot,
} from "./eval-record.js";

// Settings
export {
  resolveEvalSettings,
  DEFAULT_EVAL_SETTINGS,
  type EvalSettings,
} from "./eval-settings.js";

// Test suites
export type {
  TestCase,
  TestSuite,
  TestCategory,
  AgentCapability,
  RuleSpec,
  RuleType,
  EvalDimension,
  LlmJudgment,
} from "./test-suite/types.js";
export { listBuiltinSuites, resolveSuite } from "./test-suite/loader.js";
export { CORE_TOOLS_SUITE } from "./test-suite/builtin/core-tools.js";
export { SHELL_SAFETY_SUITE } from "./test-suite/builtin/shell-safety.js";

// Scoring
export { RuleScorer } from "./scorer/rule-scorer.js";
export { Aggregator } from "./scorer/aggregator.js";
export { Reporter } from "./scorer/reporter.js";
export type {
  ScoreReport,
  AggregateScoreReport,
  RuleResult,
  DimensionScore,
} from "./scorer/types.js";

// Runner
export { EvalRunner } from "./runner.js";
export type { EvalRunnerOptions, EvalRunnerResult } from "./runner.js";

// CLI
export { runEvalCommand } from "./cli/eval-command.js";
export type { EvalCommandArgs } from "./cli/eval-command.js";
