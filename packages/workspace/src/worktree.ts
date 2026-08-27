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
  input?: string,
): { ok: true; stdout: string } | { ok: false; error: string } {
  try {
    const result = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      ...(input === undefined ? {} : { input }),
      timeout: 15_000, // 15 秒超时，防止 git 操作挂起
      maxBuffer: 64 * 1024 * 1024,
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

export interface RecoverableWorktreeOptionsV1 {
  /** Identity of the source snapshot, persisted across crash recovery. */
  readonly snapshotIdentity?: string;
}

export interface RecoverableWorktreeV1 extends TemporaryWorktree {
  /** Snapshot identity captured when this worktree was first materialized. */
  readonly snapshotIdentity?: string;
  /** True when an already-registered worktree was reopened. */
  readonly recovered: boolean;
}

/**
 * Create or reopen a stable, ignored worktree for a durable child run.
 *
 * Unlike `createTemporaryWorktree`, this worktree lives below the repository's
 * `.paw/collaboration/worktrees` directory so package resolution can still walk
 * up to the parent repository's dependency installation. On first creation it
 * overlays tracked and untracked user changes onto detached HEAD. A crash leaves
 * the registered worktree in place; the same key reopens it without rebuilding
 * a different source snapshot.
 */
export function createRecoverableWorktreeV1(
  originalRoot: string,
  key: string,
  options: RecoverableWorktreeOptionsV1 = {},
): RecoverableWorktreeV1 {
  if (!/^[a-zA-Z0-9._-]{1,96}$/.test(key)) {
    throw new Error("Recoverable worktree key is invalid");
  }
  const gitRoot = findGitRoot(originalRoot);
  if (!gitRoot) {
    throw new Error(
      `Not a git repository (or any of the parent directories): ${originalRoot}`,
    );
  }
  const sourceRoot = fs.realpathSync.native(path.resolve(originalRoot));
  const resolvedGitRoot = fs.realpathSync.native(path.resolve(gitRoot));
  const workspaceRelative = path.relative(resolvedGitRoot, sourceRoot);
  if (
    workspaceRelative === ".." ||
    workspaceRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(workspaceRelative)
  ) {
    throw new Error("Workspace root is outside its resolved git repository");
  }

  const checkoutRoot = path.join(
    resolvedGitRoot,
    ".paw",
    "collaboration",
    "worktrees",
    key,
  );
  const metadataPath = `${checkoutRoot}.json`;
  const worktreeRoot = path.join(checkoutRoot, workspaceRelative);
  const readMetadata = (): string | undefined => {
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as {
      snapshotIdentity?: unknown;
    };
    return typeof metadata.snapshotIdentity === "string"
      ? metadata.snapshotIdentity
      : undefined;
  };
  const isRegistered = (): boolean => {
    const listed = runGit(resolvedGitRoot, ["worktree", "list", "--porcelain"]);
    if (!listed.ok)
      throw new Error(`git worktree list failed: ${listed.error}`);
    return listed.stdout
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("worktree "))
      .some(
        (line) =>
          path.resolve(line.slice("worktree ".length)) ===
          path.resolve(checkoutRoot),
      );
  };
  const removeRegistered = (): void => {
    const removed = runGit(resolvedGitRoot, [
      "worktree",
      "remove",
      "--force",
      checkoutRoot,
    ]);
    if (!removed.ok) {
      throw new Error(`git worktree remove failed: ${removed.error}`);
    }
  };
  const createHandle = (
    recovered: boolean,
    snapshotIdentity: string | undefined,
  ): RecoverableWorktreeV1 => {
    let cleaned = false;
    return Object.freeze({
      worktreeRoot,
      ...(snapshotIdentity === undefined ? {} : { snapshotIdentity }),
      recovered,
      cleanup() {
        if (cleaned) return;
        cleaned = true;
        if (isRegistered()) removeRegistered();
      },
    });
  };

  if (isRegistered()) {
    try {
      return createHandle(true, readMetadata());
    } catch {
      // A registered tree without committed metadata was interrupted during
      // initialization, before it could have been handed to a child.
      removeRegistered();
    }
  } else if (fs.existsSync(checkoutRoot)) {
    throw new Error(
      `Recoverable worktree path exists but is not registered: ${checkoutRoot}`,
    );
  }

  const metadataExisted = fs.existsSync(metadataPath);
  const anchoredSnapshotIdentity = metadataExisted
    ? readMetadata()
    : options.snapshotIdentity;
  if (
    metadataExisted &&
    options.snapshotIdentity !== undefined &&
    anchoredSnapshotIdentity !== undefined &&
    options.snapshotIdentity !== anchoredSnapshotIdentity
  ) {
    throw new Error(
      "Parent workspace changed since the recoverable child snapshot was created",
    );
  }

  fs.mkdirSync(path.dirname(checkoutRoot), { recursive: true });
  const added = runGit(resolvedGitRoot, [
    "worktree",
    "add",
    "--detach",
    checkoutRoot,
    "HEAD",
  ]);
  if (!added.ok) {
    throw new Error(`git worktree add failed: ${added.error}`);
  }
  try {
    const diff = runGit(sourceRoot, ["diff", "--binary", "HEAD", "--", "."]);
    if (!diff.ok) throw new Error(`git diff failed: ${diff.error}`);
    if (diff.stdout.length > 0) {
      const applied = runGit(
        checkoutRoot,
        ["apply", "--whitespace=nowarn", "-"],
        diff.stdout,
      );
      if (!applied.ok) throw new Error(`git apply failed: ${applied.error}`);
    }

    const listed = runGit(sourceRoot, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      ".",
    ]);
    if (!listed.ok) throw new Error(`git ls-files failed: ${listed.error}`);
    for (const relative of listed.stdout.split("\0").filter(Boolean)) {
      const source = path.resolve(sourceRoot, relative);
      const destination = path.resolve(worktreeRoot, relative);
      const relativeDestination = path.relative(worktreeRoot, destination);
      if (
        relativeDestination === ".." ||
        relativeDestination.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativeDestination)
      ) {
        throw new Error(`Untracked path escapes workspace: ${relative}`);
      }
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.cpSync(source, destination, {
        recursive: true,
        dereference: false,
        errorOnExist: false,
        force: true,
      });
    }
    if (!metadataExisted) {
      fs.writeFileSync(
        metadataPath,
        `${JSON.stringify({ snapshotIdentity: anchoredSnapshotIdentity })}\n`,
        "utf8",
      );
    }
    return createHandle(metadataExisted, anchoredSnapshotIdentity);
  } catch (error) {
    const removed = runGit(resolvedGitRoot, [
      "worktree",
      "remove",
      "--force",
      checkoutRoot,
    ]);
    if (!metadataExisted) fs.rmSync(metadataPath, { force: true });
    if (!removed.ok && error instanceof Error) {
      error.message += `; cleanup failed: ${removed.error}`;
    }
    throw error;
  }
}
