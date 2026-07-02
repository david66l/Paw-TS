import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { searchWorkspaceText } from "../src/files/read.js";

describe("searchWorkspaceText", () => {
  test("finds literal substring", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-search-"));
    writeFileSync(path.join(root, "a.txt"), "hello\nneedle line\n", "utf8");
    const r = searchWorkspaceText(root, ".", { pattern: "needle" });
    expect(r.error).toBeUndefined();
    expect(r.match_count).toBe(1);
    expect(r.matches?.[0]?.path).toBe("a.txt");
    expect(r.matches?.[0]?.line).toBe(2);
  });

  test("rejects escape path", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-search-e-"));
    const r = searchWorkspaceText(root, "..", { pattern: "x" });
    expect(r.error).toContain("escapes");
  });
});
