import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createRecoverableWorktreeV1 } from "../src/worktree.js";

function git(cwd: string, args: readonly string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git exited with ${result.status}`);
  }
}

describe("createRecoverableWorktreeV1", () => {
  test("snapshots local changes, reopens after interruption, and cleans up", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-recoverable-wt-"));
    let first: ReturnType<typeof createRecoverableWorktreeV1> | undefined;
    let recovered: ReturnType<typeof createRecoverableWorktreeV1> | undefined;
    let replayed: ReturnType<typeof createRecoverableWorktreeV1> | undefined;
    try {
      git(root, ["init"]);
      git(root, ["config", "user.email", "paw@example.invalid"]);
      git(root, ["config", "user.name", "Paw Test"]);
      git(root, ["config", "core.autocrlf", "false"]);
      fs.writeFileSync(path.join(root, ".gitignore"), "**/.paw/*\n", "utf8");
      fs.writeFileSync(path.join(root, "tracked.txt"), "base\n", "utf8");
      git(root, ["add", "."]);
      git(root, ["commit", "-m", "base"]);

      fs.writeFileSync(path.join(root, "tracked.txt"), "local\n", "utf8");
      fs.writeFileSync(path.join(root, "untracked.txt"), "new\n", "utf8");
      first = createRecoverableWorktreeV1(root, "child-1", {
        snapshotIdentity: "revision-1",
      });
      expect(first.recovered).toBe(false);
      expect(first.snapshotIdentity).toBe("revision-1");
      expect(
        fs.readFileSync(path.join(first.worktreeRoot, "tracked.txt"), "utf8"),
      ).toBe("local\n");
      expect(
        fs.readFileSync(path.join(first.worktreeRoot, "untracked.txt"), "utf8"),
      ).toBe("new\n");

      fs.writeFileSync(
        path.join(first.worktreeRoot, "child.txt"),
        "preserved\n",
      );
      recovered = createRecoverableWorktreeV1(root, "child-1", {
        snapshotIdentity: "a-new-parent-revision-must-not-replace-the-snapshot",
      });
      expect(recovered.recovered).toBe(true);
      expect(recovered.snapshotIdentity).toBe("revision-1");
      expect(
        fs.readFileSync(path.join(recovered.worktreeRoot, "child.txt"), "utf8"),
      ).toBe("preserved\n");

      recovered.cleanup();
      expect(fs.existsSync(recovered.worktreeRoot)).toBe(false);
      expect(() => first?.cleanup()).not.toThrow();
      replayed = createRecoverableWorktreeV1(root, "child-1", {
        snapshotIdentity: "revision-1",
      });
      expect(replayed.recovered).toBe(true);
      replayed.cleanup();
      fs.writeFileSync(path.join(root, "tracked.txt"), "newer\n", "utf8");
      expect(() =>
        createRecoverableWorktreeV1(root, "child-1", {
          snapshotIdentity: "revision-2",
        }),
      ).toThrow("Parent workspace changed");
    } finally {
      replayed?.cleanup();
      recovered?.cleanup();
      first?.cleanup();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
