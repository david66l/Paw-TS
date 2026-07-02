/**
 * @paw/memory 包入口。
 *
 * 记忆系统：跨会话学习 — BM25 检索 + LLM 提取 + 反思归档。
 */

// 检索入口
export { retrieveMemories, type RetrieveMemoriesOptions } from "./memory-retrieve.js";

// 关键词检索器
export {
  KeywordMemoryRetriever,
  DEFAULT_RETRIEVAL_CONFIG,
  type RetrievalConfig,
  type RetrievalQuery,
  type MemoryRetrievalResult,
} from "./memory-retriever.js";

// 级联回退
export {
  DEFAULT_CASCADE_CONFIG,
  formatMemoryManifest,
  LLM_FALLBACK_SCORE,
  shouldEscalateToLlmFallback,
  type CascadeFallbackConfig,
  type LlmMemorySelectFn,
  type LlmMemorySelectInput,
} from "./memory-retrieval-cascade.js";

// 记忆记录与检索信号
export {
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
} from "./memory-record.js";

// 任务画像预算
export { TASK_PROFILE_BUDGETS, type ProfileBudget } from "./memory-profiles.js";

// 打分
export { scoreMemoryRecord } from "./memory-scorer.js";

// 选择
export { selectRecords, selectMetaFallback, type SelectedRecords } from "./memory-selector.js";

// 分词
export { tokenize, stripPathLikeText, normalizePathSeparators, pathMatchScore } from "./memory-tokenizer.js";

// 统一存储
export { UnifiedMemoryStore, type UnifiedMemoryStoreOptions } from "./unified-memory-store.js";

// 自动记忆
export {
  AutoMemoryStore,
  type AutoMemoryEntry,
  type MemoryPriority as AutoMemoryPriority,
} from "./auto-memory.js";

// 项目记忆
export { loadProjectMemory, type ProjectMemory } from "./project-memory.js";

// 会话记忆
export { SessionMemoryStore, type SessionMemory } from "./session-memory.js";

// 嵌入缓存
export {
  EmbeddingCache,
  resolveEmbeddingConfig,
  type EmbeddingCacheEntry,
  type EmbeddingConfig,
} from "./embedding-cache.js";

// 反思
export {
  runReflection,
  shouldRunReflection,
  resetReflectionCounter,
  type ReflectionPlan,
  type ReflectionMergeAction,
  type ReflectionArchiveAction,
  type ReflectionConflictAction,
  type ReflectorOptions,
  type ReflectionState,
} from "./memory-reflector.js";
