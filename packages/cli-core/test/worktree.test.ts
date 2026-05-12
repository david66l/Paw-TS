import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { findGitRoot, createTemporaryWorktree } from "../src/worktree.js";
import { runStubRun } from "../src/operations.js";

describe("worktree", () => {
  test("findGitRoot returns null for non-git directory", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-notgit-"));
    const root = findGitRoot(dir);
    expect(root).toBeNull();
  });

  test("findGitRoot returns repo root for git directory", () => {
    // This test runs inside the paw-ts repo
    const repoRoot = findGitRoot(process.cwd());
    expect(repoRoot).not.toBeNull();
    expect(existsSync(path.join(repoRoot!, ".git"))).toBe(true);
  });

  test("createTemporaryWorktree creates and cleans up", () => {
    const repoRoot = findGitRoot(process.cwd());
    if (!repoRoot) {
      throw new Error("Not in a git repo");
    }

    const wt = createTemporaryWorktree(repoRoot);
    expect(existsSync(wt.worktreeRoot)).toBe(true);
    expect(existsSync(path.join(wt.worktreeRoot, ".git"))).toBe(true);

    wt.cleanup();
    expect(existsSync(wt.worktreeRoot)).toBe(false);
  });

  test("createTemporaryWorktree cleanup is idempotent", () => {
    const repoRoot = findGitRoot(process.cwd());
    if (!repoRoot) {
      throw new Error("Not in a git repo");
    }

    const wt = createTemporaryWorktree(repoRoot);
    wt.cleanup();
    expect(() => wt.cleanup()).not.toThrow();
  });

  test("createTemporaryWorktree throws outside git repo", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-notgit-"));
    expect(() => createTemporaryWorktree(dir)).toThrow("Not a git repository");
  });

  test("runStubRun with useWorktree runs in isolated worktree", async () => {
    const repoRoot = findGitRoot(process.cwd());
    if (!repoRoot) {
      throw new Error("Not in a git repo");
    }

    // The worktree starts detached from the same commit; the model may
    // bail early if there are no API keys, but the run itself should
    // execute without crashing.
    const result = await runStubRun("say hello only", {
      workspaceRoot: repoRoot,
      useWorktree: true,
      maxSteps: 1,
      resultTextFormat: "minimal",
    });
    // We expect either success (0) or unimplemented (3) — both mean the
    // orchestrator managed to start the run inside the worktree.
    expect([0, 3]).toContain(result.exitCode);
  });
});
