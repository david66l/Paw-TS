/**
 * @paw/memory Runtime 门面导出。
 * Agent 集成新记忆系统时只应从这里（或包根 re-export）导入。
 */

export { createMemoryRuntime, MemoryRuntimeImpl } from "./memory-runtime.js";
export {
  checkMemoryHealth,
  resolveMemoryBackendFromSettings,
  type MemoryBackendKind,
  type MemoryHealthReport,
} from "./health.js";
export {
  migrateLegacyMemories,
  type MigrateLegacyOptions,
  type MigrateLegacyResult,
} from "./migrate-legacy.js";
export { resolveScope, type ResolvedScope } from "./scope.js";
export type {
  BeginTaskInput,
  BeginTaskResult,
  BuildContextInput,
  BuildContextResult,
  CompleteTaskInput,
  CompleteTaskResult,
  ContextSectionItem,
  MemoryListItem,
  MemoryRuntime,
  MemoryRuntimeOptions,
  OnToolResultInput,
  PatchWorkingMemoryInput,
  SaveMemoryInput,
  SaveMemoryResult,
  WorkingMemoryPatch,
} from "./types.js";
