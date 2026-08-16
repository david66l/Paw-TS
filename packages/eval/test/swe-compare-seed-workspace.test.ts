import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { mergeInstanceGeneratedFiles } from "../src/swe-compare/verification-environment.js";

function git(cwd: string, args: readonly string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr?.trim() ?? "unknown"}`,
    );
  }
}

function initRepo(root: string): void {
  fs.mkdirSync(root, { recursive: true });
  git(root, ["init"]);
  git(root, ["config", "user.email", "seed@example.invalid"]);
  git(root, ["config", "user.name", "Seed Test"]);
  git(root, ["config", "core.autocrlf", "false"]);
}

describe("instance image workspace seeding", () => {
  test("merge keeps base tracked state, ignored generated files, and drops strays", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "paw-seed-base-"));
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), "paw-seed-image-"));
    try {
      // workspace：隔离 checkout（base 状态）
      initRepo(base);
      fs.mkdirSync(path.join(base, "src"), { recursive: true });
      fs.writeFileSync(path.join(base, "src", "app.py"), "value = 1\n");
      fs.writeFileSync(path.join(base, ".gitignore"), "gen/_version.py\n");
      git(base, ["add", "."]);
      git(base, ["commit", "-m", "base"]);

      // staging：模拟镜像 /testbed——tracked 被 eval commit 改过、
      // 有 ignored 生成文件、还有 untracked 杂物
      initRepo(staging);
      fs.mkdirSync(path.join(staging, "src"), { recursive: true });
      fs.writeFileSync(path.join(staging, "src", "app.py"), "value = 99\n");
      fs.mkdirSync(path.join(staging, "gen"), { recursive: true });
      fs.writeFileSync(
        path.join(staging, "gen", "_version.py"),
        "version = '1'\n",
      );
      fs.writeFileSync(path.join(staging, "stray.txt"), "stray\n");

      mergeInstanceGeneratedFiles(staging, base);

      // tracked 回到 base，不被镜像内容污染
      expect(fs.readFileSync(path.join(base, "src", "app.py"), "utf8")).toBe(
        "value = 1\n",
      );
      // ignored 生成文件保留（这是修复的意义所在）
      expect(fs.existsSync(path.join(base, "gen", "_version.py"))).toBeTrue();
      // untracked 非 ignored 杂物被清掉
      expect(fs.existsSync(path.join(base, "stray.txt"))).toBeFalse();
      // staging 的 .git 没有覆盖工作区仓库
      const dotGit = fs.statSync(path.join(base, ".git"));
      expect(dotGit.isDirectory()).toBeTrue();
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
      fs.rmSync(staging, { recursive: true, force: true });
    }
  });
});
