import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { listWorkspaceFiles, readWorkspaceFile } from "../src/local-fs.js";

describe("readWorkspaceFile", () => {
  test("reads utf8 file with offset/limit", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-ws-"));
    fs.writeFileSync(path.join(root, "a.txt"), "l0\nl1\nl2", "utf8");
    const r = readWorkspaceFile(root, "a.txt", { offset: 1, limit: 1 });
    expect(r.error).toBeUndefined();
    expect(r.content).toBe("l1");
    expect(r.line_count).toBe(1);
    expect(r.total_lines).toBe(3);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("rejects escape", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-ws-"));
    const r = readWorkspaceFile(root, "../outside.txt");
    expect(r.error).toContain("escapes");
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("listWorkspaceFiles", () => {
  test("non-recursive lists names", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-ws-"));
    fs.writeFileSync(path.join(root, "x.ts"), "", "utf8");
    fs.writeFileSync(path.join(root, "y.ts"), "", "utf8");
    const r = listWorkspaceFiles(root, ".", { recursive: false });
    expect(r.error).toBeUndefined();
    expect(r.files?.sort()).toEqual(["x.ts", "y.ts"]);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
