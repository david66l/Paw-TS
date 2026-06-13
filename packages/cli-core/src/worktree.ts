/**
 * Git worktree isolation for Paw agent runs.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export interface TemporaryWorktree {
  readonly worktreeRoot: string;
  /** Remove the worktree and its directory. Idempotent. */
  readonly cleanup: () => void;
}

function runGit(
  cwd: string,
  args: string[],
): { ok: true; stdout: string } | { ok: false; error: string } {
  try {
    const result = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
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

/** Find the git repository root containing `dir`, or `null`. */
export function findGitRoot(dir: string): string | null {
  const r = runGit(dir, ["rev-parse", "--show-toplevel"]);
  if (!r.ok) {
    return null;
  }
  return r.stdout.trim() || null;
}

/**
 * Create a temporary git worktree from the repo containing `originalRoot`.
 * The worktree is created in a temp directory and starts from the current
 * branch/commit (detached HEAD). Returns the worktree path and a cleanup
 * function that removes it.
 */
export function createTemporaryWorktree(
  originalRoot: string,
): TemporaryWorktree {
  const gitRoot = findGitRoot(originalRoot);
  if (!gitRoot) {
    throw new Error(
      `Not a git repository (or any of the parent directories): ${originalRoot}`,
    );
  }

  const tmpBase = mkdtempSync(path.join(tmpdir(), "paw-wt-"));
  const worktreeName = `paw-isolated-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const worktreeRoot = path.join(tmpBase, worktreeName);

  const add = runGit(gitRoot, ["worktree", "add", "--detach", worktreeRoot]);
  if (!add.ok) {
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      // ignore cleanup failure
    }
    throw new Error(`git worktree add failed: ${add.error}`);
  }

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    // Remove the worktree from git's tracking
    const rm = runGit(gitRoot, ["worktree", "remove", "--force", worktreeRoot]);
    if (!rm.ok) {
      // Best-effort manual cleanup so the directory doesn't leak
      try {
        fs.rmSync(worktreeRoot, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    // Also remove the temp base directory if still present
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      // ignore
    }
  };

  return { worktreeRoot, cleanup };
}
