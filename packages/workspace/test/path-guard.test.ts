import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { checkWorkspacePath, isPathInsideRoot } from "../src/path-guard.js";

describe("checkWorkspacePath", () => {
  test("allows relative path under root (existence not checked here)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-ws-"));
    const d = checkWorkspacePath(root, "any.txt");
    expect(d.allowed).toBe(true);
    expect(d.resolvedPath).toBe(path.resolve(root, "any.txt"));
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("rejects parent escape", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-ws-"));
    const d = checkWorkspacePath(root, "../etc/passwd");
    expect(d.allowed).toBe(false);
    expect(d.risk).toBe("escaped");
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("rejects .git segment", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-ws-"));
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    const d = checkWorkspacePath(root, ".git/config");
    expect(d.allowed).toBe(false);
    expect(d.risk).toBe("sensitive");
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("does not inherit sensitive segments from workspace ancestors", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "paw-ws-"));
    const root = path.join(parent, ".paw", "worktrees", "verifier");
    fs.mkdirSync(path.join(root, "src"), { recursive: true });

    expect(checkWorkspacePath(root, "src/a.ts").allowed).toBe(true);
    expect(checkWorkspacePath(root, ".paw/secret.json").risk).toBe("sensitive");

    fs.rmSync(parent, { recursive: true, force: true });
  });

  test("rejects symlink escape for existing target", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-ws-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "paw-out-"));
    fs.writeFileSync(path.join(outside, "secret.txt"), "nope");
    fs.symlinkSync(outside, path.join(root, "linked"), "dir");

    const d = checkWorkspacePath(root, "linked/secret.txt");
    expect(d.allowed).toBe(false);
    expect(d.risk).toBe("escaped");

    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  test("rejects symlink escape when target file does not exist yet", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-ws-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "paw-out-"));
    fs.symlinkSync(outside, path.join(root, "linked"), "dir");

    const d = checkWorkspacePath(root, "linked/new.txt");
    expect(d.allowed).toBe(false);
    expect(d.risk).toBe("escaped");

    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  test("enforces run-scoped read and write roots without expanding workspace authority", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-ws-"));
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.mkdirSync(path.join(root, "test"), { recursive: true });
    const policy = {
      readRoots: ["src"],
      writeRoots: [] as string[],
      denyPaths: ["src/private"],
    };

    expect(checkWorkspacePath(root, "src/a.ts", { policy }).allowed).toBe(true);
    expect(checkWorkspacePath(root, "test/a.ts", { policy }).risk).toBe(
      "out_of_scope",
    );
    expect(
      checkWorkspacePath(root, "src/a.ts", {
        operation: "write",
        policy,
      }).allowed,
    ).toBe(false);
    expect(
      checkWorkspacePath(root, "src/private/key.ts", { policy }).allowed,
    ).toBe(false);

    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("isPathInsideRoot", () => {
  test("child is inside", () => {
    expect(isPathInsideRoot("/a/b", "/a/b/c")).toBe(true);
  });
  test("sibling is not inside", () => {
    expect(isPathInsideRoot("/a/b", "/a/c")).toBe(false);
  });
});
