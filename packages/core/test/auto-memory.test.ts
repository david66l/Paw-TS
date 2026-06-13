import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type AutoMemoryEntry, AutoMemoryStore } from "../src/auto-memory.js";

describe("AutoMemoryStore", () => {
  let tmpDir: string;
  let store: AutoMemoryStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "paw-auto-memory-"));
    store = new AutoMemoryStore({
      workspaceRoot: tmpDir,
      memoryDir: path.join(tmpDir, "memory"),
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeEntry(
    name: string,
    overrides?: Partial<AutoMemoryEntry>,
  ): AutoMemoryEntry {
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
      expect(loaded?.name).toBe("test-entry");
      expect(loaded?.description).toBe("Test description");
      expect(loaded?.type).toBe("reference");
      expect(loaded?.content).toBe("Test content");
    });

    it("returns null for missing entry", () => {
      const loaded = store.load("nonexistent");
      expect(loaded).toBeNull();
    });

    it("overwrites existing entry", () => {
      store.save(makeEntry("entry", { content: "First" }));
      store.save(makeEntry("entry", { content: "Second" }));
      const loaded = store.load("entry");
      expect(loaded?.content).toBe("Second");
    });

    it("creates MEMORY.md index on buildIndex", () => {
      store.save(makeEntry("entry-a"));
      store.buildIndex();
      const indexPath = path.join(tmpDir, "memory", "MEMORY.md");
      expect(existsSync(indexPath)).toBe(true);
      const index = readFileSync(indexPath, "utf-8");
      expect(index).toContain("entry-a");
    });

    it("loadIndex returns truncated index", () => {
      for (let i = 0; i < 5; i++) {
        store.save(makeEntry(`entry-${i}`, { description: `desc ${i}` }));
      }
      store.buildIndex();
      const full = store.loadIndex(200);
      expect(full).toContain("entry-0");
      const truncated = store.loadIndex(3);
      expect(truncated).toContain("omitted");
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

  describe("upsert", () => {
    it("creates when no similar entry exists", () => {
      const action = store.upsert(makeEntry("new-entry"));
      expect(action).toBe("created");
      expect(store.load("new-entry")).not.toBeNull();
    });

    it("updates by matching description", () => {
      store.save(makeEntry("original", { description: "Same desc" }));
      const action = store.upsert(
        makeEntry("different-name", {
          description: "Same desc",
          content: "Updated body",
        }),
      );
      expect(action).toBe("updated");
      expect(store.load("original")?.content).toBe("Updated body");
      expect(store.load("different-name")).toBeNull();
    });

    it("updates by exact name", () => {
      store.save(makeEntry("entry", { content: "v1" }));
      const action = store.upsert(makeEntry("entry", { content: "v2" }));
      expect(action).toBe("updated");
      expect(store.load("entry")?.content).toBe("v2");
    });

    it("preserves createdAt on update", () => {
      const created = 1_700_000_000_000;
      store.save(
        makeEntry("entry", { content: "v1", createdAt: created, updatedAt: created }),
      );
      store.upsert(
        makeEntry("entry", {
          content: "v2",
          updatedAt: created + 1000,
        }),
      );
      const loaded = store.load("entry");
      expect(loaded?.createdAt).toBe(created);
      expect(loaded?.updatedAt).toBe(created + 1000);
    });
  });

  describe("type validation", () => {
    it("accepts valid types", () => {
      for (const type of [
        "user",
        "feedback",
        "project",
        "reference",
      ] as const) {
        store.save(makeEntry(type, { type }));
        const loaded = store.load(type);
        expect(loaded?.type).toBe(type);
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
