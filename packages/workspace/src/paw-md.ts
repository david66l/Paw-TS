/**
 * Load paw.md (or .paw/paw.md) from the workspace root.
 * This file contains project-specific instructions for the agent.
 */

import fs from "node:fs";
import path from "node:path";

export interface PawMdResult {
  readonly content?: string;
  readonly path?: string;
}

/**
 * Search for paw.md in workspace root or .paw/ subdirectory.
 * Returns the content and path if found.
 */
export function loadPawMd(workspaceRoot: string): PawMdResult {
  const candidates = [
    path.join(workspaceRoot, "paw.md"),
    path.join(workspaceRoot, ".paw", "paw.md"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p) && fs.statSync(p).isFile()) {
      try {
        const content = fs.readFileSync(p, "utf8");
        return { content, path: path.relative(workspaceRoot, p) };
      } catch {
        // ignore read errors
      }
    }
  }
  return {};
}
