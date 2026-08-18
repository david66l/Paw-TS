import { describe, expect, test } from "bun:test";
import fs, { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { writeWorkspaceFile } from "../src/files/write.js";

describe("writeWorkspaceFile", () => {
  test("writes utf8 and creates parent dirs", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-ws-write-"));
    const r = writeWorkspaceFile(root, "src/a.txt", "hello\n");
    expect(r.error).toBeUndefined();
    expect(r.bytes_written).toBeGreaterThan(0);
    const abs = path.join(root, "src", "a.txt");
    expect(fs.readFileSync(abs, "utf8")).toBe("hello\n");
  });

  test("rejects escape", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-ws-write2-"));
    const r = writeWorkspaceFile(root, "../../../etc/passwd", "x");
    expect(r.error).toBeDefined();
  });

  test("reports whether an overwrite materially changed content", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-ws-write-change-"));
    expect(writeWorkspaceFile(root, "x.txt", "same\n").changed).toBe(true);
    expect(writeWorkspaceFile(root, "x.txt", "same\n").changed).toBe(false);
    expect(writeWorkspaceFile(root, "empty.txt", "").changed).toBe(true);
  });

  test("createOnly atomically refuses to overwrite an existing path", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-write-create-only-"));
    const first = writeWorkspaceFile(root, "x.txt", "first\n", {
      createOnly: true,
    });
    const second = writeWorkspaceFile(root, "x.txt", "second\n", {
      createOnly: true,
    });

    expect(first.changed).toBe(true);
    expect(second.error).toContain("file already exists");
    expect(fs.readFileSync(path.join(root, "x.txt"), "utf8")).toBe("first\n");
  });
});
