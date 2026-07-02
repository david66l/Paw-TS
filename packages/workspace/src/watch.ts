/**
 * 轻量级文件系统监听器 — 检测外部文件修改。
 * ===========================================
 *
 * 使用 `fs.watch`（递归模式）检测 Agent 外部的文件变更。
 * Agent 自己写入的文件通过 markAgentWritten() 标记后会被过滤，
 * 只报告真正来自外部的修改（如用户在 IDE 中编辑了文件）。
 *
 * 面试要点：
 * - 为什么需要区分内部/外部变更？Agent 每轮都可能写文件，
 *   如果不区分，每轮都会看到"文件变更"提示，形成噪音
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
