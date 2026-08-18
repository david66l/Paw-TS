/**
 * paw-ts 核心包（@paw-ts/core）的公共 API 入口——桶导出文件（Barrel Export）。
 *
 * ## 模块职责（架构定位）
 * 本文件是核心包对外暴露的唯一入口点。所有需要被外部模块（CLI、Server、Plugin 等）
 * 使用的类型、函数和类都通过此文件集中 re-export，实现了以下架构目标：
 *
 * 1. **封装内部实现**：各子模块的内部实现细节（如私有辅助函数、内部类型）
 *    不会出现在此导出列表中，外部使用者只能访问经过筛选的公共 API。
 * 2. **统一核心导入路径**：核心能力从 `@paw/core` 导入；具体记忆实现从
 *    `@paw/memory` 导入，跨包纯协议由 `@paw/protocol` 定义。
 * 3. **文档即接口**：此文件本身就是公共 API 的目录，配合 JSDoc 注释，
 *    开发者只需阅读此文件就能了解核心包提供的全部能力。
 *
 * ## API 组织结构
 * 导出按功能域分组（每个分组对应一个子模块）：
 *
 * | 功能域               | 子模块文件                    | 说明                         |
 * |---------------------|------------------------------|------------------------------|
 * | Agent 操作           | actions.js                   | Agent 执行动作类型            |
 * | 上下文管理           | context-manager.js           | 对话上下文管理器              |
 * | 应用状态             | app-state.js                 | Agent 运行状态持久化          |
 * | 费用追踪             | cost-tracker.js              | 模型调用费用实时计算           |
 * | 错误处理             | errors.js                    | 统一错误类型与工具函数         |
 * | 输入净化             | input-sanitizer.js           | 用户输入安全检查              |
 * | 评估钩子             | eval-hooks.js                | 运行评估生命周期钩子          |
 * | 运行事件             | run-events.js                | 事件流类型定义                |
 * | 运行指标             | run-metrics.js / run-evaluator.js | 效率指标计算与格式化     |
 * | Token 估算           | token-estimate.js / token-estimator.js | Token 数量预估 API   |
 * | 上下文裁剪           | context-pruner.js            | 历史消息智能裁剪             |
 * | 工具结果存储         | tool-result-storage.js       | 大工具结果持久化             |
 * | 上下文压缩           | context-compactor.js         | 对话历史摘要压缩             |
 * | 上下文预算           | context-budget.js            | 上下文窗口配额管理           |
 * | 压缩质量验证         | compression-summary.js       | 压缩结果质量检查             |
 * | Markdown 解析        | markdown.js                  | Markdown 章节解析            |
 * | Token 用量           | token-usage.js               | 模型 Token 用量类型          |
 * | 运行定义             | run.js                       | RunSpec / RunResult 类型     |
 * | 会话存储             | session-store.js             | 会话持久化存储               |
 * | 待办事项             | todo.js                      | Agent 任务跟踪               |
 * | 技能系统             | skills.js                    | 技能加载与注册               |
 * | 检查点               | checkpoint.js                | 文件状态快照与回滚           |
 * | 记忆协议兼容导出      | @paw/protocol                | 无实现的共享记忆类型         |
 * | 根目录查找           | find-root.js                 | paw-ts 项目根目录定位        |
 * | 系统提示词构建       | system-prompt.js             | 完整系统提示词组装           |
 */

// ============================================================
// Agent 操作类型
// ============================================================
export type {
  AgentAbortAction,
  AgentAcceptanceUpdateAction,
  AgentAction,
  AgentAskUserAction,
  AgentFinalAnswerAction,
  AgentPlanUpdateAction,
  AgentToolCallAction,
} from "./actions.js";

// ============================================================
// 上下文管理
// ============================================================
export {
  ContextManager,
  isNativeToolTurnV1,
  type Attachment,
  type ChatMessage,
  type ContextManagerOptions,
  type NativeToolTurnCallV1,
  type NativeToolTurnResultV1,
  type NativeToolTurnV1,
} from "./context/manager.js";
export {
  flattenContextTurnsV1,
  groupContextTurnsV1,
  type ContextTurnV1,
} from "./context/turns.js";

// ============================================================
// 应用状态
// ============================================================
export {
  appStateSummary,
  FileSystemAppStateStore,
  InMemoryAppStateStore,
  isAppStateFinished,
  type AppState,
  type AppStateStore,
  USER_INTERACTION_SCHEMA_V1,
  type UserReplyInboxEventV1,
  type WaitingUserInteractionV1,
} from "./app-state.js";

// ============================================================
// 费用追踪
// ============================================================
export {
  CostTracker,
  estimateUsageCost,
  resolveModelPricing,
  type CostCurrency,
  type CostSnapshot,
  type ModelPricing,
  type UsageRecord,
} from "./cost-tracker.js";

// ============================================================
// 错误处理
// ============================================================
export {
  isPawError,
  makeToolError,
  PawError,
  type PawErrorCode,
  type ToolErrorCode,
  type ToolErrorPayload,
} from "./errors.js";

// ============================================================
// 输入净化
// ============================================================
export { sanitizeUserInput } from "./input-sanitizer.js";
export type { SanitizeResult } from "./input-sanitizer.js";

// ============================================================
// 评估钩子
// ============================================================
export type { EvalHooks } from "./eval-hooks.js";

// ============================================================
// 运行事件
// ============================================================
export type {
  RunEvent,
  RunEventEnvelope,
  ToolDecisionCommitV1,
  ToolDecisionDispositionV1,
  ToolDecisionMutationCaptureV1,
  ToolDecisionVerificationCaptureV1,
  ToolFileChange,
} from "./run-events.js";

// ============================================================
// 运行指标
// ============================================================
export {
  formatRunMetricsSummary,
  type RunMetrics,
  type RunMetricsAccumulator,
} from "./run-metrics.js";
export {
  evaluateRunFromEnvelopes,
  evaluateRunFromJsonl,
} from "./run-evaluator.js";

// ============================================================
// Token 估算
// ============================================================
export {
  estimateTokens,
  estimateMessageTokens,
  estimateMessagesTokens,
} from "./token-estimate.js";
export {
  ApproximateEstimator,
  FastEstimator,
  TiktokenEstimator,
  prewarmEncoding,
  type TokenEstimator,
} from "./token-estimator.js";
export {
  CalibratedEstimator,
  CONSERVATIVE_BIAS,
  resolveEstimatorForModel,
} from "./tokenizer-registry.js";

// ============================================================
// 上下文裁剪
// ============================================================
export {
  pruneToolResults,
  type PruneConfig,
  type PruneResult,
} from "./context/pruner.js";
export { isProtectedUserConstraint } from "./context/policy.js";

// ============================================================
// 工具结果格式与存储
// ============================================================
export {
  isToolResultMessage,
  OBSERVATION_PROVENANCE_PREFIX,
  OBSERVATION_PROVENANCE_SCHEMA_V1,
  parseToolResult,
  splitToolBlocks,
  type ObservationProvenanceV1,
} from "./tool-result/format.js";
export {
  DEFAULT_KEEP_RECENT_TOOLS,
  DEFAULT_MAX_TOOL_OUTPUT_BYTES,
  getToolResultsDir,
  isPersistedToolResult,
} from "./tool-result/storage.js";

// ============================================================
// 上下文压缩
// ============================================================
export {
  compactionMiddleMessagesV1,
  ContextCompactor,
  CONTEXT_SUMMARY_PREFIX,
  DEFAULT_COMPACTOR_CONFIG,
  stripContextSummaryMessages,
  isContextSummaryMessage,
  projectCompactedHistoryV1,
  type CompactionFailureReason,
  type CompactorConfig,
  type CompactBoundaries,
  type CompactCheck,
} from "./context/compactor.js";

// ============================================================
// 上下文预算管理
// ============================================================
export {
  allocateContextBudget,
  COMPACT_THRESHOLD_RATIO,
  COST_PRICING,
  DEFAULT_BUDGET_RATIOS,
  LARGE_WINDOW_BUDGET_RATIOS,
  computeCompactThreshold,
  costAdjustedCompactThreshold,
  estimateContextCost,
  measureContextBudget,
  resolveBudgetRatios,
  shouldCompactHistory,
  truncateTextToTokenBudget,
  MEMORY_INJECTION_DETAIL_TOKENS,
  type ContextBudgetAllocation,
  type ContextBudgetRatios,
  type ContextBudgetSnapshot,
  type ContextCostEstimate,
} from "./context/budget.js";

// ============================================================
// 压缩结果质量验证
// ============================================================
export {
  compressionSavingsRatio,
  MAX_COMPRESSION_SAVINGS_RATIO,
  meetsCompressionSavingsThreshold,
  MIN_COMPRESSION_SAVINGS_RATIO,
  REQUIRED_SUMMARY_SECTIONS,
  validateCompressionSummary,
} from "./context/summary.js";

// ============================================================
// P3 冷库：可寻址归档（ARC）
// ============================================================
export {
  ArtifactRegistry,
  ARCHIVE_STUB_PATTERN,
  ARCHIVE_BARE_STUB_PATTERN,
  parseArchiveStub,
  parseBareArchiveStub,
  DEFAULT_ARCHIVE_OPTIONS,
  type ArchiveEntry,
  type ArchiveMeta,
  type ArchiveSearchResult,
  type ArtifactRegistryOptions,
  type RecallOutcome,
  type RecallWindow,
} from "./context/archive.js";

// ============================================================
// P4.2 生命周期驱逐（上下文段状态机 + 残差效用门控）
// ============================================================
export {
  computeSegments,
  extractRecentToolCallPaths,
  type SegmentInfo,
  type SegmentState,
} from "./context/policy.js";

// ============================================================
// P4.4 压缩版本化（每次压缩 = commit 快照）
// ============================================================
export {
  compactionCommitsDir,
  listCompactionCommits,
  loadCompactionSnapshot,
  loadLatestCompactionSnapshot,
  saveCompactionCommit,
  type CompactionCommit,
} from "./context/versioning.js";

// ============================================================
// P5.1 侧信道触发（压缩主动化调度 + 规则引擎）
// ============================================================
export {
  ContextMonitor,
  DEFAULT_MONITOR_OPTIONS,
  evaluateTrigger,
  type ContextMonitorOptions,
  type MonitorDecision,
  type TriggerReason,
} from "./context/monitor.js";

// ============================================================
// P2.7 行为闭环（压缩后重复获取检测）
// ============================================================
export {
  detectDuplicateAccess,
  type CompactionQualityResult,
  type DuplicateAccess,
} from "./context/compression-quality.js";

// ============================================================
// 轻量工具：内容哈希（P1 去重 / P3 归档去重键同源）
// ============================================================
export { simpleHash } from "./utils/hash.js";

// ============================================================
// Markdown 解析
// ============================================================
export {
  parseMarkdownSections,
  parseYamlFrontmatter,
  splitFrontmatter,
  stringifyYamlFrontmatter,
} from "./markdown.js";

// ============================================================
// Token 用量类型
// ============================================================
export type { ModelTokenUsage } from "./token-usage.js";

// ============================================================
// 运行定义
// ============================================================
export type {
  CompletionOutcome,
  RunAcceptanceCriterionSeed,
  RunEvidence,
  RunResult,
  RunSpec,
  RunStatus,
} from "./run.js";

// ============================================================
// 会话存储
// ============================================================
export {
  FileSystemSessionStore,
  type FileSystemSessionStoreOptions,
  type RunSummary,
  type SessionStore,
} from "./session-store.js";

// ============================================================
// 待办事项
// ============================================================
export {
  formatTodosForPrompt,
  InMemoryTodoStore,
  type TodoItem,
  type TodoStore,
} from "./todo.js";

// ============================================================
// 技能系统
// ============================================================
export {
  loadSkillsFromDirectory,
  renderSkillPrompt,
  skillsFromProjectMemory,
  SkillRegistry,
  type SkillDefinition,
  type SkillInvocation,
  type SkillParameter,
} from "./skills.js";

// ============================================================
// 检查点（文件状态快照与回滚）
// ============================================================
export {
  extractCheckpointTargets,
  isMutatingTool,
  listCheckpoints,
  restoreCheckpoint,
  saveCheckpoint,
  undoLastCheckpoint,
  type CheckpointEntry,
} from "./checkpoint.js";

// ============================================================
// 记忆协议兼容导出。具体实现只从 @paw/memory 导入。
// ============================================================
export type {
  LegacyProjectMemoryV1,
  LegacyMemoryRecordV1,
  MemorySource,
  MemoryScope,
  MemoryPriority,
  MemoryKind,
  MemoryMetadata,
  MemoryStatus,
  TaskProfile,
} from "@paw/protocol";

/** @deprecated WP1a compatibility alias. Import LegacyProjectMemoryV1 instead. */
export type ProjectMemory = import("@paw/protocol").LegacyProjectMemoryV1;
/** @deprecated WP1a compatibility alias. Import LegacyMemoryRecordV1 instead. */
export type MemoryRecord = import("@paw/protocol").LegacyMemoryRecordV1;

// ============================================================
// 项目根目录查找
// ============================================================
export { findPawRoot } from "./find-root.js";

// ============================================================
// 系统提示词构建
// ============================================================
export {
  buildSystemPrompt,
  buildSystemPromptWithBudget,
  MAX_STEPS_WARNING,
  type SystemPromptOptions,
  type SystemPromptBuildResult,
  type SystemPromptTrimEntry,
} from "./system-prompt.js";

// ============================================================
// 工作区路径
// ============================================================
export {
  memoryDir,
  sessionMemoryDir,
} from "./workspace-paths.js";

// ============================================================
// 文件系统工具（原子写入、文件锁、漂移检测）
// ============================================================
export {
  atomicWrite,
  lockFile,
  readLockPid,
  readWithHash,
  checkDrift,
  safeWrite,
  type DriftCheckResult,
} from "./utils/fs.js";

// ============================================================
// 威胁扫描器（prompt 注入 / C2 / 外泄检测）
// ============================================================
export {
  scanForThreats,
  firstThreatMessage,
} from "./threat-scanner.js";
