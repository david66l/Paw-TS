/**
 * SWE-bench 仓库缓存 + 每臂独立 worktree（同 commit，防串扰）
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { formatPatch, structuredPatch } from "diff";

export interface ArmWorkspace {
  readonly root: string;
  readonly cleanup: () => void;
}

export interface GitDiffCapture {
  readonly diff?: string;
  readonly error?: string;
}

function runGit(
  cwd: string,
  args: string[],
  timeoutMs = 300_000,
): { ok: true; stdout: string } | { ok: false; error: string } {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (r.error) return { ok: false, error: r.error.message };
  if (r.status !== 0) {
    return {
      ok: false,
      error: (r.stderr || r.stdout || `git exit ${r.status}`).trim(),
    };
  }
  return { ok: true, stdout: r.stdout ?? "" };
}

export function repoCachePath(cacheDir: string, repo: string): string {
  const slug = repo.replace(/[\\/]/g, "__");
  return path.join(cacheDir, "repos", slug);
}

/** 确保 mirror/clone 存在；返回本地 git 根 */
export function ensureRepoClone(
  repo: string,
  cacheDir: string,
  opts: {
    readonly fetch?: boolean;
    /** Explicit trusted mirror used by offline callers and deterministic tests. */
    readonly cloneUrl?: string;
  } = {},
): string {
  const dest = repoCachePath(cacheDir, repo);
  mkdirSync(path.dirname(dest), { recursive: true });
  const existingHead = existsSync(path.join(dest, ".git"))
    ? runGit(dest, ["rev-parse", "--verify", "HEAD^{commit}"])
    : undefined;
  if (existingHead?.ok) {
    runGit(dest, ["config", "core.autocrlf", "false"]);
    if (opts.fetch !== false) {
      const fetch = runGit(dest, ["fetch", "--all", "--tags"], 600_000);
      if (!fetch.ok) {
        console.warn(`[swe-exp] git fetch warn ${repo}: ${fetch.error}`);
      }
    }
    return dest;
  }
  if (existsSync(dest)) {
    console.warn(
      `[swe-exp] removing unusable repository cache ${repo}: ${
        existingHead && !existingHead.ok
          ? existingHead.error
          : "missing .git directory"
      }`,
    );
    rmSync(dest, { recursive: true, force: true });
  }
  const url = opts.cloneUrl ?? `https://github.com/${repo}.git`;
  console.error(`[swe-exp] cloning ${url} → ${dest}`);
  mkdirSync(dest, { recursive: true });
  // 完整 clone：SWE-bench base_commit 常在历史深处，blob:none 偏克隆取不到 commit
  const clone = spawnSync(
    "git",
    ["-c", "core.autocrlf=false", "clone", url, dest],
    {
      encoding: "utf8",
      timeout: 900_000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  if (clone.status !== 0) {
    try {
      rmSync(dest, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    throw new Error(
      `git clone failed ${repo}: ${(
        clone.stderr ||
          clone.stdout ||
          clone.error?.message ||
          `git exit ${clone.status}`
      ).trim()}`,
    );
  }
  const clonedHead = runGit(dest, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (!clonedHead.ok) {
    rmSync(dest, { recursive: true, force: true });
    throw new Error(
      `git clone produced unusable checkout ${repo}: ${clonedHead.error}`,
    );
  }
  runGit(dest, ["config", "core.autocrlf", "false"]);
  return dest;
}

/**
 * 在指定 commit 上创建独立 worktree（detached）。
 * off/on 各一份，互不影响工作区文件。
 */
export function createCommitWorktree(
  gitRoot: string,
  commit: string,
  label: string,
): ArmWorkspace {
  const tmpBase = mkdtempSync(path.join(tmpdir(), `paw-swe-${label}-`));
  const worktreeRoot = path.join(tmpBase, "wt");

  // 确保 commit 可达
  const cat = runGit(gitRoot, ["cat-file", "-e", `${commit}^{commit}`]);
  if (!cat.ok) {
    const fetch = runGit(gitRoot, ["fetch", "origin", commit], 600_000);
    if (!fetch.ok) {
      // 有些仓库需 unshallow / 全量
      runGit(gitRoot, ["fetch", "--unshallow"], 600_000);
      const again = runGit(gitRoot, ["fetch", "origin", commit], 600_000);
      if (!again.ok) {
        throw new Error(
          `commit ${commit} not found in ${gitRoot}: ${cat.error}`,
        );
      }
    }
  }

  // Prefer LF in worktrees (match upstream / Linux harness; avoid edit_file CRLF misses)
  runGit(gitRoot, ["config", "core.autocrlf", "false"]);

  mkdirSync(worktreeRoot, { recursive: true });
  const init = runGit(
    worktreeRoot,
    ["-c", "core.autocrlf=false", "init"],
    600_000,
  );
  if (!init.ok) {
    try {
      rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    throw new Error(`isolated benchmark init failed: ${init.error}`);
  }
  const configured = runGit(worktreeRoot, ["config", "core.autocrlf", "false"]);
  if (!configured.ok) {
    throw new Error(
      `isolated benchmark Git config failed: ${configured.error}`,
    );
  }
  const fetched = runGit(
    worktreeRoot,
    [
      "-c",
      "protocol.file.allow=always",
      "fetch",
      "--depth=1",
      "--no-tags",
      gitRoot,
      commit,
    ],
    600_000,
  );
  if (!fetched.ok) {
    try {
      rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    throw new Error(`isolated benchmark fetch failed: ${fetched.error}`);
  }

  const checkout = runGit(worktreeRoot, [
    "-c",
    "core.autocrlf=false",
    "checkout",
    "--detach",
    "FETCH_HEAD",
  ]);
  if (!checkout.ok) {
    try {
      rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      /* ignore cleanup failure; surface the isolation failure below */
    }
    throw new Error(`isolated benchmark checkout failed: ${checkout.error}`);
  }

  // Fetching one exact commit into a fresh shallow repository avoids exposing
  // any later branch/ref/object and never configures a remote for the agent.
  const refs = runGit(worktreeRoot, ["for-each-ref", "--format=%(refname)"]);
  if (!refs.ok) {
    throw new Error(`benchmark ref isolation failed: ${refs.error}`);
  }
  for (const ref of refs.stdout.split(/\r?\n/).map((x) => x.trim())) {
    if (!ref) continue;
    const deleted = runGit(worktreeRoot, ["update-ref", "-d", ref]);
    if (!deleted.ok) {
      throw new Error(
        `benchmark ref isolation failed for ${ref}: ${deleted.error}`,
      );
    }
  }
  const expired = runGit(worktreeRoot, [
    "reflog",
    "expire",
    "--expire=now",
    "--all",
  ]);
  const pruned = runGit(worktreeRoot, ["gc", "--prune=now"]);
  if (!expired.ok || !pruned.ok) {
    throw new Error(
      `benchmark object isolation failed: ${
        !expired.ok ? expired.error : !pruned.ok ? pruned.error : "unknown"
      }`,
    );
  }

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  };

  return { root: worktreeRoot, cleanup };
}

export function gitDiff(workspaceRoot: string): string {
  const captured = captureGitDiff(workspaceRoot);
  if (captured.error) return "";
  return captured.diff ?? "";
}

/** Capture both the patch and collection failure so evals cannot silently score empty. */
export function captureGitDiff(
  workspaceRoot: string,
  filePaths: readonly string[] = [],
): GitDiffCapture {
  if (filePaths.length > 0) {
    return captureExplicitFileDiff(workspaceRoot, filePaths);
  }
  const diffArgs = [
    "-c",
    "core.autocrlf=false",
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--binary",
  ];
  const pathspec = filePaths.length > 0 ? ["--", ...filePaths] : [];
  const r = runGit(workspaceRoot, [...diffArgs, ...pathspec], 60_000);
  if (!r.ok) return { error: r.error };
  // 也包含 staged；SWE 通常改已有 tracked 文件
  const staged = runGit(
    workspaceRoot,
    [...diffArgs, "--cached", ...pathspec],
    60_000,
  );
  const parts = [r.stdout.trim()];
  if (!staged.ok) return { error: staged.error };
  if (staged.stdout.trim()) parts.push(staged.stdout.trim());
  return { diff: parts.filter(Boolean).join("\n") };
}

function captureExplicitFileDiff(
  workspaceRoot: string,
  filePaths: readonly string[],
): GitDiffCapture {
  const parts: string[] = [];
  for (const filePath of [...new Set(filePaths)].sort()) {
    const normalized = filePath.replace(/\\/g, "/");
    if (
      !normalized ||
      normalized.startsWith("/") ||
      normalized.split("/").includes("..")
    ) {
      return { error: `unsafe explicit patch path: ${filePath}` };
    }
    const currentPath = path.join(workspaceRoot, ...normalized.split("/"));
    const currentExists = existsSync(currentPath);
    let current = "";
    if (currentExists) {
      try {
        current = readFileSync(currentPath, "utf8");
      } catch (error) {
        return {
          error: `cannot read edited path ${normalized}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
    }
    const baseline = runGit(
      workspaceRoot,
      ["show", `HEAD:${normalized}`],
      60_000,
    );
    if (!baseline.ok) {
      const tracked = runGit(
        workspaceRoot,
        ["ls-files", "--error-unmatch", "--", normalized],
        60_000,
      );
      if (tracked.ok) {
        return {
          error: `cannot read HEAD version of ${normalized}: ${baseline.error}`,
        };
      }
    }
    const original = baseline.ok ? baseline.stdout : "";
    if (original === current && baseline.ok === currentExists) continue;
    const oldName = baseline.ok ? `a/${normalized}` : "/dev/null";
    const newName = currentExists ? `b/${normalized}` : "/dev/null";
    const patch = formatPatch(
      structuredPatch(oldName, newName, original, current, "", ""),
    ).trim();
    parts.push(`diff --git a/${normalized} b/${normalized}\n${patch}`);
  }
  return { diff: parts.join("\n") };
}

/** 写入每臂隔离的 .paw 配置 */
export function writeArmPawConfig(opts: {
  workspaceRoot: string;
  repositoryId: string;
  memoryEnable: boolean;
  /** 可选：从宿主复制的 settings 片段（模型密钥等） */
  hostSettings?: Record<string, unknown>;
}): void {
  const paw = path.join(opts.workspaceRoot, ".paw");
  mkdirSync(paw, { recursive: true });
  const settings: Record<string, unknown> = {
    ...(opts.hostSettings ?? {}),
    memory_backend: "db",
    repository_id: opts.repositoryId,
    user_id: "swe-exp",
  };
  writeFileSync(
    path.join(paw, "settings.local.json"),
    `${JSON.stringify(settings, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    path.join(paw, "memory-config.json"),
    `${JSON.stringify(
      { enable: opts.memoryEnable, readonly: false, shadow: false },
      null,
      2,
    )}\n`,
    "utf8",
  );
}
