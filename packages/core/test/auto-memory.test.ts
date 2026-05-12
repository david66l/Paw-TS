import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AutoMemoryStore, type AutoMemoryEntry } from "../src/auto-memory.js";

describe("AutoMemoryStore", () => {
  let tmpDir: string;
  let store: AutoMemoryStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "paw-auto-memory-"));
    store = new AutoMemoryStore({ workspaceRoot: tmpDir, memoryDir: path.join(tmpDir, "memory") });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeEntry(name: string, overrides?: Partial<AutoMemoryEntry>): AutoMemoryEntry {
    return {
      name,
      description: "Test description",
      type: "reference",
      content: "Test content",
      ...overrides,
    };
  }

  describe("save and load", () => {
    it("round-trips an entry", () => {
      const entry = makeEntry("test-entry");
      store.save(entry);
      const loaded = store.load("test-entry");
      expect(loaded).not.toBeNull();
      expect(loaded!.name).toBe("test-entry");
      expect(loaded!.description).toBe("Test description");
      expect(loaded!.type).toBe("reference");
      expect(loaded!.content).toBe("Test content");
    });

    it("returns null for missing entry", () => {
      const loaded = store.load("nonexistent");
      expect(loaded).toBeNull();
    });

    it("overwrites existing entry", () => {
      store.save(makeEntry("entry", { content: "First" }));
      store.save(makeEntry("entry", { content: "Second" }));
      const loaded = store.load("entry");
      expect(loaded!.content).toBe("Second");
    });

    it("creates MEMORY.md index on buildIndex", () => {
      store.save(makeEntry("entry-a"));
      store.buildIndex();
      const indexPath = path.join(tmpDir, "memory", "MEMORY.md");
      expect(existsSync(indexPath)).toBe(true);
      const index = readFileSync(indexPath, "utf-8");
      expect(index).toContain("entry-a");
    });
  });

  describe("list", () => {
    it("returns empty array when no entries", () => {
      expect(store.list()).toEqual([]);
    });

    it("returns all entries excluding MEMORY.md", () => {
      store.save(makeEntry("entry-a", { type: "user" }));
      store.save(makeEntry("entry-b", { type: "project" }));
      const entries = store.list();
      expect(entries).toHaveLength(2);
      const names = entries.map((e) => e.name).sort();
      expect(names).toEqual(["entry-a", "entry-b"]);
    });

    it("ignores invalid markdown files", () => {
      const badPath = path.join(tmpDir, "memory", "bad.md");
      rmSync(path.dirname(badPath), { recursive: true, force: true });
      const { mkdirSync, writeFileSync } = require("node:fs");
      mkdirSync(path.dirname(badPath), { recursive: true });
      writeFileSync(badPath, "not frontmatter");
      const entries = store.list();
      expect(entries).toEqual([]);
    });
  });

  describe("delete", () => {
    it("removes an entry", () => {
      store.save(makeEntry("to-delete"));
      store.delete("to-delete");
      expect(store.load("to-delete")).toBeNull();
    });

    it("rebuilds index after delete", () => {
      store.save(makeEntry("keep"));
      store.save(makeEntry("to-delete"));
      store.delete("to-delete");
      store.buildIndex();
      const indexPath = path.join(tmpDir, "memory", "MEMORY.md");
      const index = readFileSync(indexPath, "utf-8");
      expect(index).toContain("keep");
      expect(index).not.toContain("to-delete");
    });

    it("is safe for non-existent entries", () => {
      store.delete("nonexistent");
      expect(store.list()).toEqual([]);
    });
  });

  describe("type validation", () => {
    it("accepts valid types", () => {
      for (const type of ["user", "feedback", "project", "reference"] as const) {
        store.save(makeEntry(type, { type }));
        const loaded = store.load(type);
        expect(loaded!.type).toBe(type);
      }
    });

    it("rejects invalid type in frontmatter", () => {
      const filePath = path.join(tmpDir, "memory", "invalid-type.md");
      const { mkdirSync, writeFileSync } = require("node:fs");
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(
        filePath,
        "---\nname: invalid-type\ndescription: test\ntype: badtype\n---\n\ncontent",
      );
      const loaded = store.load("invalid-type");
      expect(loaded).toBeNull();
    });
  });
});
