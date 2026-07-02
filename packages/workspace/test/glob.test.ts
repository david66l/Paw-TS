import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { globWorkspaceFiles } from "../src/files/read.js";

describe("globWorkspaceFiles", () => {
  test("matches files in current directory", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-glob-"));
    writeFileSync(path.join(root, "a.ts"), "", "utf8");
    writeFileSync(path.join(root, "b.js"), "", "utf8");
    writeFileSync(path.join(root, "c.ts"), "", "utf8");
    const r = globWorkspaceFiles(root, ".", { pattern: "*.ts" });
    expect(r.error).toBeUndefined();
    expect(r.filenames?.sort()).toEqual(["a.ts", "c.ts"]);
    expect(r.numFiles).toBe(2);
  });

  test("** matches recursively", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-glob-"));
    mkdirSync(path.join(root, "src", "components"), { recursive: true });
    writeFileSync(path.join(root, "src", "a.ts"), "", "utf8");
    writeFileSync(path.join(root, "src", "components", "b.tsx"), "", "utf8");
    writeFileSync(path.join(root, "c.js"), "", "utf8");
    const r = globWorkspaceFiles(root, ".", { pattern: "**/*.ts" });
    expect(r.error).toBeUndefined();
    expect(r.filenames?.sort()).toEqual(["src/a.ts"]);
  });

  test("**/* matches all nested files", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-glob-"));
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(path.join(root, "src", "a.ts"), "", "utf8");
    writeFileSync(path.join(root, "src", "b.tsx"), "", "utf8");
    const r = globWorkspaceFiles(root, ".", { pattern: "src/**/*" });
    expect(r.error).toBeUndefined();
    expect(r.filenames?.sort()).toEqual(["src/a.ts", "src/b.tsx"]);
  });

  test("rejects path escape", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-glob-"));
    const r = globWorkspaceFiles(root, "../escape", { pattern: "*" });
    expect(r.error).toBeDefined();
  });

  test("returns empty for non-matching pattern", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-glob-"));
    writeFileSync(path.join(root, "a.ts"), "", "utf8");
    const r = globWorkspaceFiles(root, ".", { pattern: "*.py" });
    expect(r.error).toBeUndefined();
    expect(r.filenames).toEqual([]);
    expect(r.numFiles).toBe(0);
  });

  test("truncates at max results", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-glob-"));
    for (let i = 0; i < 250; i++) {
      writeFileSync(path.join(root, `f${i}.txt`), "", "utf8");
    }
    const r = globWorkspaceFiles(root, ".", { pattern: "*.txt" });
    expect(r.error).toBeUndefined();
    expect(r.truncated).toBe(true);
    expect(r.numFiles).toBe(200);
  });
});
