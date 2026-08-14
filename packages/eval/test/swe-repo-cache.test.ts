import { describe, expect, test } from "bun:test";
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

import {
  ensureRepoClone,
  repoCachePath,
  writeArmPawConfig,
} from "../src/swe-exp/repo-cache.js";

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "git failed").trim());
  }
  return (result.stdout ?? "").trim();
}

describe("SWE repository cache", () => {
  test("isolated arm settings never contain host provider credentials", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-swe-config-"));
    try {
      writeArmPawConfig({
        workspaceRoot: root,
        repositoryId: "qualification-demo",
        memoryEnable: false,
      });
      const settings = JSON.parse(
        readFileSync(path.join(root, ".paw", "settings.local.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(settings).toEqual({
        memory_backend: "db",
        repository_id: "qualification-demo",
        user_id: "swe-exp",
      });
      expect(JSON.stringify(settings)).not.toMatch(
        /api[_-]?key|token|secret|password/i,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("replaces an interrupted .git-only clone with a verified checkout", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-swe-cache-"));
    const remote = path.join(root, "remote");
    mkdirSync(remote, { recursive: true });
    git(remote, ["init"]);
    git(remote, ["config", "user.email", "paw@example.invalid"]);
    git(remote, ["config", "user.name", "Paw Test"]);
    writeFileSync(path.join(remote, "product.py"), "value = 1\n", "utf8");
    git(remote, ["add", "product.py"]);
    git(remote, ["commit", "-m", "base"]);
    const expectedHead = git(remote, ["rev-parse", "HEAD"]);

    const broken = repoCachePath(root, "demo/repo");
    mkdirSync(broken, { recursive: true });
    git(broken, ["init"]);
    writeFileSync(path.join(broken, "partial.lock"), "interrupted", "utf8");

    const checkout = ensureRepoClone("demo/repo", root, {
      fetch: false,
      cloneUrl: remote,
    });

    expect(checkout).toBe(broken);
    expect(git(checkout, ["rev-parse", "--verify", "HEAD^{commit}"])).toBe(
      expectedHead,
    );
    expect(readFileSync(path.join(checkout, "product.py"), "utf8")).toBe(
      "value = 1\n",
    );
    expect(existsSync(path.join(checkout, "partial.lock"))).toBe(false);
  });
});
