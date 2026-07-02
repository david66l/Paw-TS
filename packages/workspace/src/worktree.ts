/**
 * Git worktree 隔离环境 —— 为 Paw agent 运行提供独立的工作区副本。
 *
 * ## 为什么需要这个模块
 * Paw agent 在执行过程中可能修改文件系统中的内容（创建、编辑、删除文件）。
 * 用户通常希望 agent 的变更在确认前不影响原始工作目录。
 * Git worktree 提供了轻量级的隔离机制：基于现有仓库创建独立的工作树，
 * agent 在临时目录中操作，任务完成后可选择保留或丢弃变更。
 *
 * ## 核心设计决策
 * 1. **detached HEAD**：worktree 以 detached HEAD 模式创建，
 *    从当前 HEAD 的 commit 快照开始，不创建新分支。
 * 2. **临时目录 + 唯一名称**：worktree 建立在 OS 临时目录下，
 *    名称包含时间戳和随机后缀，确保多实例不冲突。
 * 3. **幂等 cleanup**：cleanup 函数可重复调用，第二次调用是 no-op。
 *    使用 `cleaned` 标志防止重复执行。
 * 4. **尽力清理**：如果 `git worktree remove` 失败，
 *    回退到手动 `rm -rf`，确保临时文件不泄漏。
 * 5. **超时和缓冲区限制**：git 子进程设置 15 秒超时和 1MB 输出上限，
 *    防止意外挂起或输出爆炸。
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** 临时 worktree 的句柄。 */
export interface TemporaryWorktree {
  /** worktree 的根路径，agent 在此目录内运行。 */
  readonly worktreeRoot: string;
  /**
   * 移除 worktree 及其目录。
   * 幂等操作：重复调用是安全的（第二次调用为 no-op）。
   */
  readonly cleanup: () => void;
}

/**
 * 执行 git 命令的包装器。
 *
 * 统一处理错误、超时、非零退出码等异常情况。
 *
 * @param cwd - git 命令的工作目录
 * @param args - git 子命令参数
 * @returns 成功时 { ok: true, stdout }，失败时 { ok: false, error }
 */
function runGit(
  cwd: string,
  args: string[],
): { ok: true; stdout: string } | { ok: false; error: string } {
  try {
    const result = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 15_000, // 15 秒超时，防止 git 操作挂起
      maxBuffer: 1024 * 1024, // 1MB 输出上限
    });
    if (result.error) {
      return { ok: false, error: result.error.message };
    }
    if (result.status !== 0) {
      return {
        ok: false,
        error: result.stderr || `git exited with code ${result.status}`,
      };
    }
    return { ok: true, stdout: result.stdout };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}

/**
 * 查找包含指定目录的 git 仓库根目录。
 *
 * @param dir - 起始搜索目录
 * @returns git 根目录路径，不在仓库中则返回 null
 */
export function findGitRoot(dir: string): string | null {
  const r = runGit(dir, ["rev-parse", "--show-toplevel"]);
  if (!r.ok) {
    return null;
  }
  return r.stdout.trim() || null;
}

/**
 * 从包含 `originalRoot` 的 git 仓库创建临时 worktree。
 *
 * 工作流程：
 * 1. 验证 originalRoot 在 git 仓库内
 * 2. 在系统临时目录创建唯一命名的 worktree
 * 3. 以 detached HEAD 模式检出当前 commit
 * 4. 返回 worktree 路径和 cleanup 函数
 *
 * 注意事项：
 * - worktree 在 detached HEAD 模式下创建（从当前分支/commit 开始）
 * - cleanup 函数是幂等的
 * - 如果 `git worktree add` 失败，会自动清理临时目录
 *
 * @param originalRoot - 原始工作区中的某个路径（需在 git 仓库内）
 * @returns 包含 worktreeRoot 和 cleanup 的 TemporaryWorktree 对象
 * @throws 如果 originalRoot 不在 git 仓库中
 */
export function createTemporaryWorktree(
  originalRoot: string,
): TemporaryWorktree {
  // 步骤 1：定位 git 仓库根目录
  const gitRoot = findGitRoot(originalRoot);
  if (!gitRoot) {
    throw new Error(
      `Not a git repository (or any of the parent directories): ${originalRoot}`,
    );
  }

  // 步骤 2：创建临时基础目录
  const tmpBase = mkdtempSync(path.join(tmpdir(), "paw-wt-"));
  // 生成唯一名称：时间戳 + 随机后缀，防止并发冲突
  const worktreeName = `paw-isolated-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const worktreeRoot = path.join(tmpBase, worktreeName);

  // 步骤 3：以 detached HEAD 模式添加 worktree
  const add = runGit(gitRoot, ["worktree", "add", "--detach", worktreeRoot]);
  if (!add.ok) {
    // 创建失败时清理临时目录，避免泄漏
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      // 清理失败也忽略，不掩盖原始错误
    }
    throw new Error(`git worktree add failed: ${add.error}`);
  }

  // 步骤 4：构造幂等的 cleanup 函数
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) {
      return; // 已清理，幂等
    }
    cleaned = true;
    // 从 git 的 worktree 追踪中移除
    const rm = runGit(gitRoot, ["worktree", "remove", "--force", worktreeRoot]);
    if (!rm.ok) {
      // git 移除失败时，尽力手动清理目录
      try {
        fs.rmSync(worktreeRoot, { recursive: true, force: true });
      } catch {
        // 忽略清理错误
      }
    }
    // 清理临时基础目录
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      // 忽略清理错误
    }
  };

  return { worktreeRoot, cleanup };
}
