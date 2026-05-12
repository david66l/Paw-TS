/**
 * Git tools for the Paw workspace harness.
 */

import { spawnSync } from "node:child_process";

export interface GitStatusResult {
  readonly branch?: string;
  readonly ahead?: number;
  readonly behind?: number;
  readonly modified?: string[];
  readonly staged?: string[];
  readonly untracked?: string[];
  readonly renamed?: string[];
  readonly error?: string;
}

export interface GitLogResult {
  readonly commits?: Array<{
    readonly hash: string;
    readonly author: string;
    readonly date: string;
    readonly message: string;
  }>;
  readonly error?: string;
}

export interface GitDiffResult {
  readonly diff?: string;
  readonly error?: string;
}

export interface GitCommitResult {
  readonly ok: boolean;
  readonly message?: string;
  readonly error?: string;
}

function runGit(cwd: string, args: string[]): { ok: true; stdout: string } | { ok: false; error: string } {
  try {
    const result = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    if (result.error) {
      return { ok: false, error: result.error.message };
    }
    if (result.status !== 0) {
      return { ok: false, error: result.stderr || `git exited with code ${result.status}` };
    }
    return { ok: true, stdout: result.stdout };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}

export function gitStatus(workspaceRoot: string): GitStatusResult {
  const r = runGit(workspaceRoot, ["status", "--porcelain", "-b"]);
  if (!r.ok) {
    return { error: r.error };
  }

  const lines = r.stdout.split("\n").filter((l) => l.trim() !== "");
  const modified: string[] = [];
  const staged: string[] = [];
  const untracked: string[] = [];
  const renamed: string[] = [];
  let branch: string | undefined;
  let ahead = 0;
  let behind = 0;

  for (const line of lines) {
    // Branch line starts with "##"
    if (line.startsWith("## ")) {
      const branchInfo = line.slice(3);
      const match = branchInfo.match(/^([^\.\s]+)(?:\.\.\.([^\s]+))?\s*(?:\[([^\]]+)\])?/);
      if (match) {
        branch = match[1]!;
        const remote = match[3];
        if (remote) {
          const aheadMatch = remote.match(/ahead\s+(\d+)/);
          const behindMatch = remote.match(/behind\s+(\d+)/);
          if (aheadMatch) ahead = parseInt(aheadMatch[1]!, 10);
          if (behindMatch) behind = parseInt(behindMatch[1]!, 10);
        }
      }
      continue;
    }

    const status = line.slice(0, 2);
    const filename = line.slice(3);

    // XY format: X = index status, Y = working tree status
    if (status === "??") {
      untracked.push(filename);
    } else if (status.startsWith("R")) {
      renamed.push(filename);
    } else {
      if (status[0] !== " " && status[0] !== "?") {
        staged.push(filename);
      }
      if (status[1] !== " " && status[1] !== "?") {
        modified.push(filename);
      }
    }
  }

  return {
    branch,
    ahead,
    behind,
    modified,
    staged,
    untracked,
    renamed,
  };
}

export function gitLog(workspaceRoot: string, maxCount = 10): GitLogResult {
  const r = runGit(workspaceRoot, [
    "log",
    `--max-count=${maxCount}`,
    "--pretty=format:%H|%an|%ad|%s",
    "--date=short",
  ]);
  if (!r.ok) {
    return { error: r.error };
  }

  const commits: Array<{ hash: string; author: string; date: string; message: string }> = [];
  const lines = r.stdout.split("\n").filter((l) => l.trim() !== "");
  for (const line of lines) {
    const parts = line.split("|");
    if (parts.length >= 4) {
      commits.push({
        hash: parts[0]!,
        author: parts[1]!,
        date: parts[2]!,
        message: parts[3]!,
      });
    }
  }

  return { commits };
}

export function gitDiff(workspaceRoot: string, filePath?: string): GitDiffResult {
  const args = filePath ? ["diff", "--", filePath] : ["diff"];
  const r = runGit(workspaceRoot, args);
  if (!r.ok) {
    return { error: r.error };
  }
  return { diff: r.stdout };
}

export function gitCommit(workspaceRoot: string, message: string): GitCommitResult {
  const r = runGit(workspaceRoot, ["commit", "-m", message]);
  if (!r.ok) {
    return { ok: false, error: r.error };
  }
  return { ok: true, message: r.stdout.trim() };
}
