import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type SessionMemory,
  SessionMemoryStore,
} from "../src/session/session-memory.js";

describe("SessionMemoryStore", () => {
  let tmpDir: string;
  let store: SessionMemoryStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "paw-session-memory-"));
    store = new SessionMemoryStore({
      workspaceRoot: tmpDir,
      sessionsDir: path.join(tmpDir, "session-memory"),
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeMemory(
    session: string,
    overrides?: Partial<SessionMemory>,
  ): SessionMemory {
    return {
      session,
      project: "test-project",
      updatedAt: Date.now(),
      task: "Test task",
      ...overrides,
    };
  }

  describe("save and load", () => {
    it("round-trips a memory object", () => {
      const memory = makeMemory("session-1");
      store.save("session-1", memory);
      const loaded = store.load("session-1");
      expect(loaded).not.toBeNull();
      expect(loaded?.session).toBe("session-1");
      expect(loaded?.project).toBe("test-project");
      expect(loaded?.task).toBe("Test task");
    });

    it("returns null for missing session", () => {
      const loaded = store.load("nonexistent");
      expect(loaded).toBeNull();
    });

    it("overwrites existing session", () => {
      store.save("session-1", makeMemory("session-1", { task: "First" }));
      store.save("session-1", makeMemory("session-1", { task: "Second" }));
      const loaded = store.load("session-1");
      expect(loaded?.task).toBe("Second");
    });
  });

  describe("toMarkdown / fromMarkdown", () => {
    it("round-trips all fields", () => {
      const memory: SessionMemory = {
        session: "s1",
        project: "p1",
        updatedAt: 1_700_000_000_000,
        task: "Task A",
        currentState: "In progress",
        filesAndFunctions: ["src/foo.ts", "src/bar.ts"],
        keyDecisions: ["Use X instead of Y"],
        errorsAndFixes: ["Fixed Z"],
        relevantContext: "Next: do W",
      };
      const md = store.toMarkdown(memory);
      const parsed = store.fromMarkdown(md);
      expect(parsed).not.toBeNull();
      expect(parsed?.session).toBe("s1");
      expect(parsed?.project).toBe("p1");
      expect(parsed?.updatedAt).toBe(1_700_000_000_000);
      expect(parsed?.task).toBe("Task A");
      expect(parsed?.currentState).toBe("In progress");
      expect(parsed?.filesAndFunctions).toEqual(["src/foo.ts", "src/bar.ts"]);
      expect(parsed?.keyDecisions).toEqual(["Use X instead of Y"]);
      expect(parsed?.errorsAndFixes).toEqual(["Fixed Z"]);
      expect(parsed?.relevantContext).toBe("Next: do W");
    });

    it("handles minimal memory", () => {
      const memory: SessionMemory = {
        session: "s1",
        project: "p1",
        updatedAt: 1,
      };
      const md = store.toMarkdown(memory);
      const parsed = store.fromMarkdown(md);
      expect(parsed).not.toBeNull();
      expect(parsed?.task).toBeUndefined();
    });

    it("returns null for invalid markdown", () => {
      const parsed = store.fromMarkdown("not frontmatter");
      expect(parsed).toBeNull();
    });

    it("returns null for missing required fields", () => {
      const parsed = store.fromMarkdown("---\nfoo: bar\n---\n");
      expect(parsed).toBeNull();
    });
  });

  describe("loadLatest", () => {
    it("returns null when no sessions exist", () => {
      const latest = store.loadLatest();
      expect(latest).toBeNull();
    });

    it("returns the most recently updated session", () => {
      store.save("old", makeMemory("old", { updatedAt: 1_000 }));
      store.save("new", makeMemory("new", { updatedAt: 2_000 }));
      const latest = store.loadLatest();
      expect(latest).not.toBeNull();
      expect(latest?.session).toBe("new");
    });

    it("ignores non-markdown files", () => {
      store.save("a", makeMemory("a", { updatedAt: 1_000 }));
      // Create a non-markdown file directly
      const otherPath = path.join(tmpDir, "session-memory", "readme.txt");
      const { writeFileSync } = require("node:fs");
      writeFileSync(otherPath, "hello");
      const latest = store.loadLatest();
      expect(latest).not.toBeNull();
      expect(latest?.session).toBe("a");
    });
  });

  describe("listRecent", () => {
    it("returns empty array when no sessions exist", () => {
      expect(store.listRecent()).toEqual([]);
    });

    it("returns sessions newest first up to limit", () => {
      store.save("s1", makeMemory("s1", { task: "First" }));
      store.save("s2", makeMemory("s2", { task: "Second" }));
      store.save("s3", makeMemory("s3", { task: "Third" }));
      const recent = store.listRecent(2);
      expect(recent).toHaveLength(2);
      expect(recent[0]?.session).toBe("s3");
      expect(recent[1]?.session).toBe("s2");
    });
  });
});
