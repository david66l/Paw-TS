/**
 * Stable, implementation-free memory contracts shared across Paw packages.
 *
 * This module intentionally contains no storage, retrieval, rendering, or IO.
 * The memory package owns those behaviors and implements contracts expressed
 * with these values.
 */

/**
 * Internal compatibility DTOs for the pre-protocol memory stack.
 *
 * These names deliberately include `Legacy` and a schema version. They are a
 * temporary package-boundary bridge for WP1a, not Paw's future public memory
 * protocol.
 */

/** Origin of a context-injectable legacy memory record. */
export type MemorySource = "session" | "auto" | "project" | "user_explicit";

/** Visibility boundary of a context-injectable legacy memory record. */
export type MemoryScope = "project" | "workspace" | "global";

/** Retrieval priority carried by a context-injectable legacy memory record. */
export type MemoryPriority = "high" | "mid" | "low";

/** Semantic category used by the legacy unified memory record. */
export type MemoryKind =
  | "project_rule"
  | "user_preference"
  | "task_episode"
  | "failure_pattern"
  | "module_summary"
  | "procedure"
  | "reference";

/** Lifecycle status used by the legacy unified memory record. */
export type MemoryStatus = "active" | "deprecated" | "superseded";

/** Version-neutral metadata attached to legacy automatic memories. */
export interface MemoryMetadata {
  readonly kind: MemoryKind;
  readonly confidence: number;
  readonly status: MemoryStatus;
  readonly evidence: readonly string[];
  readonly validUntil?: number;
  readonly gitCommit?: string;
  readonly branch?: string;
  readonly symbols?: readonly string[];
  readonly tests?: readonly string[];
  readonly supersedes?: readonly string[];
}

/** Rule-based task category used to allocate memory retrieval context. */
export type TaskProfile =
  | "refactor_arch"
  | "bug_fix"
  | "simple_script"
  | "general";

/**
 * Read-only record consumed by context selection and system-prompt rendering.
 *
 * This is a compatibility contract for the current memory stack. It does not
 * grant callers permission to persist or mutate a formal memory.
 */
export interface LegacyMemoryRecordV1 {
  readonly id: string;
  readonly source: MemorySource;
  readonly scope: MemoryScope;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly title: string;
  readonly summary: string;
  readonly content: string;
  readonly tags: readonly string[];
  readonly relatedFiles: readonly string[];
  readonly relatedErrors: readonly string[];
  readonly embedding?: number[];
  readonly priority: MemoryPriority;
  readonly kind?: MemoryKind;
  readonly confidence?: number;
  readonly status?: MemoryStatus;
  readonly evidence?: readonly string[];
  readonly gitCommit?: string;
  readonly branch?: string;
  readonly symbols?: readonly string[];
  readonly tests?: readonly string[];
  readonly supersedes?: readonly string[];
  readonly toolsUsed: readonly string[];
  readonly validUntil: number;
  readonly linkedMemories: readonly string[];
}

/** Project instruction files loaded by the current memory implementation. */
export interface LegacyProjectMemoryV1 {
  /** Contents of the repository-shared `.paw/CLAUDE.md`, when present. */
  readonly committed: string | null;
  /** Contents of the local `.paw/CLAUDE.local.md`, when present. */
  readonly local: string | null;
}
