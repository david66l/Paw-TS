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
});
