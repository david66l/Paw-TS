/**
 * Lightweight filesystem watcher for external file modifications.
 *
 * Uses `fs.watch` (recursive where supported) to detect changes made
 * outside the agent. Files written by the agent itself are filtered out
 * so only truly external edits are reported.
 */

import fs from "node:fs";
import path from "node:path";

export class WorkspaceWatcher {
  private watcher: fs.FSWatcher | null = null;
  /** Files changed since last check (relative paths). */
  private changedFiles = new Set<string>();
  /** Files the agent wrote since last check (relative paths). */
  private agentWrittenFiles = new Set<string>();
  private workspaceRoot: string;
  private active = false;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = path.resolve(workspaceRoot);
  }

  /** Start watching the workspace. */
  start(): void {
    if (this.active) {
      return;
    }
    this.active = true;

    try {
      this.watcher = fs.watch(
        this.workspaceRoot,
        { recursive: true },
        (_eventType, filename) => {
          if (!filename || typeof filename !== "string") {
            return;
          }
          // Ignore .git, .paw, node_modules, and common build artifacts
          const parts = filename.split(path.sep);
          if (
            parts.includes(".git") ||
            parts.includes(".paw") ||
            parts.includes("node_modules") ||
            parts.includes(".next")
          ) {
            return;
          }
          this.changedFiles.add(filename);
        },
      );
    } catch (err) {
      // fs.watch with recursive may fail on some platforms (e.g., Linux).
      // Fall back to non-recursive watch on the workspace root as best effort.
      this.active = false;
      try {
        this.watcher = fs.watch(this.workspaceRoot, (_eventType, filename) => {
          if (!filename || typeof filename !== "string") return;
          const parts = filename.split(path.sep);
          if (
            parts.includes(".git") ||
            parts.includes(".paw") ||
            parts.includes("node_modules") ||
            parts.includes(".next")
          )
            return;
          this.changedFiles.add(filename);
        });
        this.active = true;
      } catch {
        // Both recursive and non-recursive failed — watcher is non-functional.
        this.watcher = null;
      }
    }
  }

  /** Stop watching and release resources. */
  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    this.active = false;
    this.changedFiles.clear();
    this.agentWrittenFiles.clear();
  }

  /** Mark a file as having been written by the agent (so it won't be reported as external). */
  markAgentWritten(relPath: string): void {
    const normalized = relPath.replace(/\\/g, "/");
    this.agentWrittenFiles.add(normalized);
    this.changedFiles.delete(normalized);
  }

  /**
   * Return files that were modified externally since the last check,
   * and clear the tracking sets.
   */
  takeExternallyModified(): string[] {
    const external: string[] = [];
    for (const f of this.changedFiles) {
      if (!this.agentWrittenFiles.has(f)) {
        external.push(f);
      }
    }
    this.changedFiles.clear();
    this.agentWrittenFiles.clear();
    return external;
  }
}
