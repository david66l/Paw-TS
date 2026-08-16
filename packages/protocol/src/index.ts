/**
 * @paw/protocol contains implementation-free package-boundary DTOs.
 *
 * During WP1a it is an internal compatibility bridge, not a frozen public SDK.
 * It must remain free of Paw package and runtime dependencies.
 */

export type {
  MemoryKind,
  MemoryMetadata,
  MemoryPriority,
  LegacyMemoryRecordV1,
  MemoryScope,
  MemorySource,
  MemoryStatus,
  LegacyProjectMemoryV1,
  TaskProfile,
} from "./memory.js";
