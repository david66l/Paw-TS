/**
 * @paw/memory — 权威记忆包。
 *
 * 在线路径：MemoryRuntime（Postgres + Governance）
 * 离线迁移：migrateLegacyMemories（读旧 AutoMemory MD）
 * 仍保留：SessionMemory（L2 压缩）、ProjectMemory（PAW/CLAUDE 指令）
 *
 * 目录：
 * - runtime/  Agent 门面
 * - db/       持久化与治理实现
 * - shared/   查询清洗与共享类型
 * - session/  L2 会话记忆
 * - project/  项目指令
 * - compat/   旧 MD 读写（迁移）
 */

export {
  createMemoryRuntime,
  MemoryRuntimeImpl,
  checkMemoryHealth,
  resolveMemoryBackendFromSettings,
  migrateLegacyMemories,
  resolveScope,
  type BeginTaskInput,
  type BeginTaskResult,
  type BuildContextInput,
  type BuildContextResult,
  type CompleteTaskInput,
  type CompleteTaskResult,
  type ContextSectionItem,
  type MemoryBackendKind,
  type MemoryHealthReport,
  type MigrateLegacyOptions,
  type MigrateLegacyResult,
  type MemoryListItem,
  type MemoryRuntime,
  type MemoryRuntimeOptions,
  type OnToolResultInput,
  type PatchWorkingMemoryInput,
  type ResolvedScope,
  type SaveMemoryInput,
  type SaveMemoryResult,
  type WorkingMemoryPatch,
} from "./runtime/index.js";

export {
  extractCleanMemoryQuery,
  extractFilePaths,
  type MemoryRecord,
  type MemorySource,
  type MemoryScope,
  type MemoryPriority,
  type TaskProfile,
} from "./shared/memory-record.js";

export {
  kindFromLegacyType,
  isMemoryKind,
  isMemoryStatus,
  type MemoryKind,
  type MemoryMetadata,
  type MemoryStatus,
} from "./shared/memory-types.js";

export { loadProjectMemory, type ProjectMemory } from "./project/project-memory.js";

export { SessionMemoryStore, type SessionMemory } from "./session/session-memory.js";

export {
  AutoMemoryStore,
  type AutoMemoryEntry,
  type MemoryPriority as AutoMemoryPriority,
} from "./compat/auto-memory.js";
