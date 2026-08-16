import type { MemoryKind, MemoryStatus } from "@paw/protocol";
import type { AutoMemoryEntry } from "../compat/auto-memory.js";

export type { MemoryKind, MemoryMetadata, MemoryStatus } from "@paw/protocol";

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
