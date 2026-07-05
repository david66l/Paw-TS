/**
 * paw-ts 核心包（@paw-ts/core）的公共 API 入口——桶导出文件（Barrel Export）。
 *
 * ## 模块职责（架构定位）
 * 本文件是核心包对外暴露的唯一入口点。所有需要被外部模块（CLI、Server、Plugin 等）
 * 使用的类型、函数和类都通过此文件集中 re-export，实现了以下架构目标：
 *
 * 1. **封装内部实现**：各子模块的内部实现细节（如私有辅助函数、内部类型）
 *    不会出现在此导出列表中，外部使用者只能访问经过筛选的公共 API。
 * 2. **统一导入路径**：所有外部消费者只需从 `@paw-ts/core` 这一个入口导入，
 *    无需关心内部文件结构。这降低了耦合度，使得内部重构不影响外部使用者。
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
 * | 会话记忆             | session-memory.js            | 会话级别记忆管理             |
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
 * | 项目记忆             | project-memory.js            | 项目级持久记忆               |
 * | 自动记忆             | auto-memory.js               | 自动提取的学习记忆           |
 * | 嵌入缓存             | embedding-cache.js           | 嵌入向量缓存                 |
 * | 根目录查找           | find-root.js                 | paw-ts 项目根目录定位        |
 * | 系统提示词构建       | system-prompt.js             | 完整系统提示词组装           |
 * | 记忆检索级联         | memory-retrieval-cascade.js  | 多级记忆检索降级策略         |
 * | 记忆检索             | memory-retrieve.js           | 统一记忆检索入口             |
 * | 统一记忆存储         | unified-memory-store.js      | 多源记忆融合存储             |
 * | 关键词记忆检索       | memory-retriever.js          | BM25 关键词检索              |
 * | 记忆记录             | memory-record.js             | 记忆索引与检索信号           |
 * | 记忆反思             | memory-reflector.js          | 记忆质量反思与归档           |
 */

// ============================================================
// Agent 操作类型
// ============================================================
export type {
  AgentAbortAction,
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
  type Attachment,
  type ChatMessage,
  type ContextManagerOptions,
} from "./context/manager.js";

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
export type { RunEvent, RunEventEnvelope } from "./run-events.js";

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
export { ApproximateEstimator, type TokenEstimator } from "./token-estimator.js";

// ============================================================
// 上下文裁剪
// ============================================================
export {
  pruneToolResults,
  type PruneConfig,
  type PruneResult,
} from "./context/pruner.js";

// ============================================================
// 工具结果格式与存储
// ============================================================
export { isToolResultMessage, parseToolResult, splitToolBlocks } from "./tool-result/format.js";
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
  ContextCompactor,
  CONTEXT_SUMMARY_PREFIX,
  DEFAULT_COMPACTOR_CONFIG,
  stripContextSummaryMessages,
  isContextSummaryMessage,
  type CompactorConfig,
  type CompactBoundaries,
  type CompactCheck,
} from "./context/compactor.js";

// ============================================================
// 上下文预算管理
// ============================================================
export {
  allocateContextBudget,
  DEFAULT_BUDGET_RATIOS,
  LARGE_WINDOW_BUDGET_RATIOS,
  measureContextBudget,
  resolveBudgetRatios,
  shouldCompactHistory,
  truncateTextToTokenBudget,
  MEMORY_INJECTION_DETAIL_TOKENS,
  type ContextBudgetAllocation,
  type ContextBudgetRatios,
  type ContextBudgetSnapshot,
} from "./context/budget.js";

// ============================================================
// 压缩结果质量验证
// ============================================================
export {
  compressionSavingsRatio,
  meetsCompressionSavingsThreshold,
  MIN_COMPRESSION_SAVINGS_RATIO,
  REQUIRED_SUMMARY_SECTIONS,
  validateCompressionSummary,
} from "./context/summary.js";

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
export type { RunResult, RunSpec, RunStatus } from "./run.js";

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
  isMutatingTool,
  listCheckpoints,
  restoreCheckpoint,
  saveCheckpoint,
  undoLastCheckpoint,
  type CheckpointEntry,
} from "./checkpoint.js";

// ============================================================
// 记忆系统 — 已迁移至 @paw/memory（向后兼容 re-export）
// ============================================================
export {
  // 项目记忆
  loadProjectMemory,
  type ProjectMemory,
  // 自动记忆
  AutoMemoryStore,
  type AutoMemoryEntry,
  type MemoryPriority as AutoMemoryPriority,
  // 嵌入缓存
  EmbeddingCache,
  resolveEmbeddingConfig,
  type EmbeddingCacheEntry,
  type EmbeddingConfig,
  // 检索级联
  DEFAULT_CASCADE_CONFIG,
  formatMemoryManifest,
  LLM_FALLBACK_SCORE,
  shouldEscalateToLlmFallback,
  type CascadeFallbackConfig,
  type LlmMemorySelectFn,
  type LlmMemorySelectInput,
  // 检索入口
  retrieveMemories,
  type RetrieveMemoriesOptions,
  // 统一存储
  UnifiedMemoryStore,
  type UnifiedMemoryStoreOptions,
  // 关键词检索
  KeywordMemoryRetriever,
  DEFAULT_RETRIEVAL_CONFIG,
  type RetrievalConfig,
  type RetrievalQuery,
  type MemoryRetrievalResult,
  // 记录与信号
  sessionMemoryToRecord,
  autoMemoryToRecord,
  extractCleanMemoryQuery,
  extractFilePaths,
  extractErrorSignatures,
  inferTags,
  buildRetrievalSignalsFromMessages,
  isMemoryMetaQuery,
  isArchitectureQuery,
  isReferenceMemory,
  classifyTask,
  PRIORITY_COEFFICIENTS,
  type MemoryRetrievalSignals,
  type MemoryRecord,
  type MemorySource,
  type MemoryScope,
  type MemoryPriority,
  type TaskProfile,
  // 反思
  runReflection,
  shouldRunReflection,
  resetReflectionCounter,
  type ReflectionPlan,
  type ReflectionMergeAction,
  type ReflectionArchiveAction,
  type ReflectionConflictAction,
  type ReflectorOptions,
  type ReflectionState,
  // 会话记忆
  SessionMemoryStore,
  type SessionMemory,
} from "@paw/memory";

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
