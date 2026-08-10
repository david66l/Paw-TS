/**
 * @paw/memory Runtime 门面导出。
 * Agent 集成新记忆系统时只应从这里（或包根 re-export）导入。
 */

import { MemoryRuntimeV2 } from "./memory-runtime-v2.js";
import { MemoryRuntimeImpl } from "./memory-runtime.js";
import type { MemoryRuntime, MemoryRuntimeOptions } from "./types.js";

/**
 * 创建 MemoryRuntime。
 * 默认 v2（spec v2 长记忆管线）；v1 仅经 opts.runtime === "v1"
 * 或 PAW_MEMORY_RUNTIME=v1 显式回滚时使用。
 */
export async function createMemoryRuntime(
  opts: MemoryRuntimeOptions,
): Promise<MemoryRuntime> {
  const kind = opts.runtime ?? process.env.PAW_MEMORY_RUNTIME ?? "v2";
  if (kind === "v1") return new MemoryRuntimeImpl(opts);
  return new MemoryRuntimeV2(opts);
}

export { MemoryRuntimeImpl } from "./memory-runtime.js";
export {
  MemoryRuntimeV2,
  resetMemoryV2Core,
  getMemoryV2CoreForTests,
} from "./memory-runtime-v2.js";
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
  MemoryCandidateEnricher,
  MemoryCandidateEnrichmentDraft,
  MemoryListItem,
  MemoryRuntime,
  MemoryRuntimeLlm,
  MemoryRuntimeOptions,
  OnToolResultInput,
  PatchWorkingMemoryInput,
  SaveMemoryInput,
  SaveMemoryResult,
  WorkingMemoryPatch,
} from "./types.js";
