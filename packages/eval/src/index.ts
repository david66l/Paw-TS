/**
 * eval 包的公共 API 入口
 * =======================
 *
 * 【是什么】
 * 这是 paw-ts 评测系统（packages/eval）的 barrels 文件，集中导出所有公共类型、
 * 类和函数，是外部消费者（CLI 命令、测试、插件等）的唯一入口。
 *
 * 【为什么】
 * Monorepo 中每个 package 需要一个统一的公共 API 面。通过 barrels 文件：
 * - 内部模块的重构不影响外部消费者
 * - 一眼可见整个包的导出结构
 * - TypeScript 的类型导出和值导出在同一位置管理
 *
 * 【导出分类】
 * 1. **数据收集**（Data collection）：EvalDataCollector 及其相关类型
 * 2. **设置**（Settings）：EvalSettings 配置
 * 3. **测试套件**（Test suites）：TestCase/TestSuite 类型、内置套件、加载器
 * 4. **评分**（Scoring）：RuleScorer、llmScore、Aggregator、Reporter
 * 5. **运行器**（Runner）：EvalRunner 及其配置
 * 6. **CLI**（Command line）：runEvalCommand
 */

// ── 数据收集 ──
export { EvalDataCollector } from "./data-collector.js";
export type {
  EvalRunRecord,
  EvalTurnRecord,
  EvalToolExecution,
  EvalModelInput,
  EvalModelOutput,
  EvalContextSnapshot,
} from "./eval-record.js";

// ── 设置 ──
export {
  resolveEvalSettings,
  DEFAULT_EVAL_SETTINGS,
  type EvalSettings,
} from "./eval-settings.js";

// ── 测试套件 ──
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
// 内置套件导出：方便外部按需引入特定套件
export { CORE_TOOLS_SUITE } from "./test-suite/builtin/core-tools.js";
export { SHELL_SAFETY_SUITE } from "./test-suite/builtin/shell-safety.js";
export { CONTEXT_MGMT_SUITE } from "./test-suite/builtin/context-mgmt.js";
export { MEMORY_RETRIEVAL_SUITE } from "./test-suite/builtin/memory-retrieval.js";
export { CODE_GEN_SUITE } from "./test-suite/builtin/code-gen.js";
export { MULTI_STEP_SUITE } from "./test-suite/builtin/multi-step.js";
export { ADVERSARIAL_SUITE } from "./test-suite/builtin/adversarial.js";
export { HIGH_FREQ_SUITE } from "./test-suite/builtin/high-frequency.js";

// ── 评分 ──
export { RuleScorer } from "./scorer/rule-scorer.js";
export { llmScore, type LlmScoreResult } from "./scorer/llm-scorer.js";
export { Aggregator } from "./scorer/aggregator.js";
export { Reporter } from "./scorer/reporter.js";
export type {
  ScoreReport,
  AggregateScoreReport,
  RuleResult,
  DimensionScore,
} from "./scorer/types.js";

// ── 运行器 ──
export { EvalRunner } from "./runner.js";
export type { EvalRunnerOptions, EvalRunnerResult } from "./runner.js";

// ── CLI ──
export { runEvalCommand } from "./cli/eval-command.js";
export type { EvalCommandArgs } from "./cli/eval-command.js";
