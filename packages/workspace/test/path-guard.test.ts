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
});

describe("isPathInsideRoot", () => {
  test("child is inside", () => {
    expect(isPathInsideRoot("/a/b", "/a/b/c")).toBe(true);
  });
  test("sibling is not inside", () => {
    expect(isPathInsideRoot("/a/b", "/a/c")).toBe(false);
  });
});
