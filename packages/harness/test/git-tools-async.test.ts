import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeTool } from "../src/registry/index.js";

test("runtime Git inspection uses native processes, preserves results and honors cancellation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-git-async-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      windowsHide: true,
      timeout: 10_000,
      stdio: "pipe",
    });
  try {
    git("init", "-q");
    fs.writeFileSync(path.join(root, "tracked.txt"), "before\n");
    git("add", "tracked.txt");
    git(
      "-c",
      "user.name=Paw Test",
      "-c",
      "user.email=paw@localhost",
      "commit",
      "-qm",
      "initial",
    );
    fs.writeFileSync(path.join(root, "tracked.txt"), "after\n");
    fs.writeFileSync(path.join(root, "untracked.txt"), "new\n");
    const results = await Promise.all([
      executeTool({ workspaceRoot: root }, "workspace.git_status", {}),
      executeTool({ workspaceRoot: root }, "workspace.git_log", {
        max_count: 1,
      }),
      executeTool({ workspaceRoot: root }, "workspace.git_diff", {
        path: "tracked.txt",
      }),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(results[0]?.payload).toMatchObject({
      modified: ["tracked.txt"],
      untracked: ["untracked.txt"],
    });
    expect(results[1]?.payload).toMatchObject({
      commits: [{ message: "initial" }],
    });
    expect(JSON.stringify(results[2]?.payload)).toContain("+after");
    const cancelled = await executeTool(
      { workspaceRoot: root, abortSignal: AbortSignal.abort() },
      "workspace.git_status",
      {},
    );
    expect(cancelled.ok).toBe(false);
    expect(cancelled.summary).toMatch(/abort|cancel/i);
    const outside = fs.mkdtempSync(path.join(root, "not-repo-"));
    // The invalid cwd fails as a tool result instead of escaping as a rejection.
    const missing = await executeTool(
      { workspaceRoot: path.join(outside, "missing") },
      "workspace.git_status",
      {},
    );
    expect(missing.ok).toBe(false);
  } finally {
    const resolved = path.resolve(root);
    if (
      path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
      !path.basename(resolved).startsWith("paw-git-async-")
    )
      throw new Error("Unexpected fixture path");
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
