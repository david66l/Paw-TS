import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadPawMd } from "../src/paw-md.js";

describe("loadPawMd", () => {
  test("returns empty when no paw.md exists", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-md-"));
    const r = loadPawMd(root);
    expect(r.content).toBeUndefined();
    expect(r.path).toBeUndefined();
  });

  test("reads paw.md from workspace root", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-md-"));
    writeFileSync(path.join(root, "paw.md"), "# Rules\n\nUse TypeScript.\n", "utf8");
    const r = loadPawMd(root);
    expect(r.content).toBe("# Rules\n\nUse TypeScript.\n");
    expect(r.path).toBe("paw.md");
  });

  test("reads paw.md from .paw/ subdirectory", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-md-"));
    const pawDir = path.join(root, ".paw");
    mkdirSync(pawDir, { recursive: true });
    writeFileSync(path.join(pawDir, "paw.md"), "# Subdir rules\n", "utf8");
    const r = loadPawMd(root);
    expect(r.content).toBe("# Subdir rules\n");
    expect(r.path).toBe(path.join(".paw", "paw.md"));
  });

  test("prefers root paw.md over .paw/paw.md", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-md-"));
    writeFileSync(path.join(root, "paw.md"), "root rules\n", "utf8");
    const pawDir = path.join(root, ".paw");
    mkdirSync(pawDir, { recursive: true });
    writeFileSync(path.join(pawDir, "paw.md"), "subdir rules\n", "utf8");
    const r = loadPawMd(root);
    expect(r.content).toBe("root rules\n");
    expect(r.path).toBe("paw.md");
  });

  test("ignores directories named paw.md", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-md-"));
    mkdirSync(path.join(root, "paw.md"), { recursive: true });
    const r = loadPawMd(root);
    expect(r.content).toBeUndefined();
  });
});
