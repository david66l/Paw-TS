/**
 * Project memory — loads `.paw/CLAUDE.md` and `.paw/CLAUDE.local.md`.
 *
 * These files contain project-specific rules, conventions, and preferences
 * that should be injected into the system prompt on every session start.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export interface ProjectMemory {
  /** Content of `.paw/CLAUDE.md` (committed, shared). */
  readonly committed: string | null;
  /** Content of `.paw/CLAUDE.local.md` (local, gitignored). */
  readonly local: string | null;
}

/**
 * Load project memory files from the workspace root.
 */
export function loadProjectMemory(workspaceRoot: string): ProjectMemory {
  const committedPath = path.join(workspaceRoot, ".paw", "CLAUDE.md");
  const localPath = path.join(workspaceRoot, ".paw", "CLAUDE.local.md");

  return {
    committed: readIfExists(committedPath),
    local: readIfExists(localPath),
  };
}

function readIfExists(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  try {
    return readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}
