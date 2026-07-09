import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadProjectMemory } from "../src/project/project-memory.js";

describe("loadProjectMemory", () => {
  let tmpDir: string;
  let pawDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "paw-project-memory-"));
    pawDir = path.join(tmpDir, ".paw");
    mkdirSync(pawDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null for both when files do not exist", () => {
    const result = loadProjectMemory(tmpDir);
    expect(result.committed).toBeNull();
    expect(result.local).toBeNull();
  });

  it("reads committed memory", () => {
    writeFileSync(
      path.join(pawDir, "CLAUDE.md"),
      "# Project Rules\nUse TypeScript.",
    );
    const result = loadProjectMemory(tmpDir);
    expect(result.committed).toBe("# Project Rules\nUse TypeScript.");
    expect(result.local).toBeNull();
  });

  it("reads local memory", () => {
    writeFileSync(
      path.join(pawDir, "CLAUDE.local.md"),
      "# Local Preferences\nUse 2 spaces.",
    );
    const result = loadProjectMemory(tmpDir);
    expect(result.committed).toBeNull();
    expect(result.local).toBe("# Local Preferences\nUse 2 spaces.");
  });

  it("reads both files", () => {
    writeFileSync(path.join(pawDir, "CLAUDE.md"), "Committed rules");
    writeFileSync(path.join(pawDir, "CLAUDE.local.md"), "Local rules");
    const result = loadProjectMemory(tmpDir);
    expect(result.committed).toBe("Committed rules");
    expect(result.local).toBe("Local rules");
  });

  it("handles unreadable files gracefully", () => {
    // Create a directory instead of a file at CLAUDE.md path
    mkdirSync(path.join(pawDir, "CLAUDE.md"));
    const result = loadProjectMemory(tmpDir);
    expect(result.committed).toBeNull();
    expect(result.local).toBeNull();
  });
});
