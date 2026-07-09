import type { AutoMemoryEntry } from "../compat/auto-memory.js";

export type MemoryKind =
  | "project_rule"
  | "user_preference"
  | "task_episode"
  | "failure_pattern"
  | "module_summary"
  | "procedure"
  | "reference";

export type MemoryStatus = "active" | "deprecated" | "superseded";

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

export function kindFromLegacyType(type: AutoMemoryEntry["type"]): MemoryKind {
  switch (type) {
    case "user":
      return "user_preference";
    case "feedback":
      return "failure_pattern";
    case "project":
      return "project_rule";
    case "reference":
      return "reference";
  }
}

export function isMemoryKind(value: string): value is MemoryKind {
  return (
    value === "project_rule" ||
    value === "user_preference" ||
    value === "task_episode" ||
    value === "failure_pattern" ||
    value === "module_summary" ||
    value === "procedure" ||
    value === "reference"
  );
}

export function isMemoryStatus(value: string): value is MemoryStatus {
  return value === "active" || value === "deprecated" || value === "superseded";
}
