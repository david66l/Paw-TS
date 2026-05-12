import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

import { gitStatus, gitLog, gitDiff } from "../src/git-tools.js";

describe("git tools", () => {
  function initGitRepo(dir: string): void {
    execSync("git init", { cwd: dir });
    execSync("git config user.email 'test@test.com'", { cwd: dir });
    execSync("git config user.name 'Test'", { cwd: dir });
  }

  test("gitStatus on non-git dir returns error", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-git-"));
    const r = gitStatus(root);
    expect(r.error).toBeDefined();
  });

  test("gitStatus shows clean repo", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-git-"));
    initGitRepo(root);
    const r = gitStatus(root);
    expect(r.error).toBeUndefined();
    expect(r.branch).toBeDefined();
    expect(r.modified?.length).toBe(0);
  });

  test("gitStatus shows modified file", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-git-"));
    initGitRepo(root);
    writeFileSync(path.join(root, "a.txt"), "hello", "utf8");
    execSync("git add a.txt", { cwd: root });
    execSync("git commit -m 'initial'", { cwd: root });
    writeFileSync(path.join(root, "a.txt"), "world", "utf8");
    const r = gitStatus(root);
    expect(r.error).toBeUndefined();
    expect(r.modified?.length).toBe(1);
    expect(r.modified![0]).toBe("a.txt");
  });

  test("gitLog returns commits", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-git-"));
    initGitRepo(root);
    writeFileSync(path.join(root, "a.txt"), "hello", "utf8");
    execSync("git add a.txt", { cwd: root });
    execSync("git commit -m 'first'", { cwd: root });
    const r = gitLog(root, 5);
    expect(r.error).toBeUndefined();
    expect(r.commits?.length).toBe(1);
    expect(r.commits![0]!.message).toBe("first");
  });

  test("gitDiff shows changes", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-git-"));
    initGitRepo(root);
    writeFileSync(path.join(root, "a.txt"), "hello", "utf8");
    execSync("git add a.txt", { cwd: root });
    execSync("git commit -m 'initial'", { cwd: root });
    writeFileSync(path.join(root, "a.txt"), "world", "utf8");
    const r = gitDiff(root);
    expect(r.error).toBeUndefined();
    expect(r.diff).toContain("world");
  });
});
