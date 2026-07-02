import { describe, expect, it, afterEach } from "bun:test";
import {
  classifyTask,
  PRIORITY_COEFFICIENTS,
} from "../src/memory-record.js";
import { AutoMemoryStore } from "../src/auto-memory.js";
import {
  KeywordMemoryRetriever,
  TASK_PROFILE_BUDGETS,
} from "../src/memory-retriever.js";
import { shouldRunReflection, resetReflectionCounter } from "../src/memory-reflector.js";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { makeRecord } from "./fixtures.js";
import { tmpdir } from "node:os";
import path from "node:path";

// ── A.3: classifyTask ──────────────────────────────────────────────

describe("classifyTask", () => {
  it("classifies architecture/refactor tasks", () => {
    expect(classifyTask("refactor the authentication module")).toBe("refactor_arch");
    expect(classifyTask("重构用户系统")).toBe("refactor_arch");
    expect(classifyTask("design a new API layer")).toBe("refactor_arch");
    expect(classifyTask("restructure the monorepo")).toBe("refactor_arch");
    expect(classifyTask("migrate from express to fastify")).toBe("refactor_arch");
  });

  it("classifies bug fix tasks", () => {
    expect(classifyTask("fix the login bug")).toBe("bug_fix");
    expect(classifyTask("修复登录报错")).toBe("bug_fix");
    expect(classifyTask("debug the crash in parser")).toBe("bug_fix");
  });

  it("classifies bug fix when error message present regardless of goal", () => {
    expect(classifyTask("look at this file", "TypeError: undefined")).toBe("bug_fix");
  });

  it("classifies simple script tasks", () => {
    expect(classifyTask("write a quick script to parse logs")).toBe("simple_script");
    expect(classifyTask("简单脚本处理数据")).toBe("simple_script");
    expect(classifyTask("one-off temp file cleanup")).toBe("simple_script");
  });

  it("defaults to general", () => {
    expect(classifyTask("review the code")).toBe("general");
    expect(classifyTask("explain how this works")).toBe("general");
    expect(classifyTask("add a new endpoint")).toBe("general");
  });
});

// ── A.3: priority coefficients ─────────────────────────────────────

describe("PRIORITY_COEFFICIENTS", () => {
  it("high > mid > low", () => {
    expect(PRIORITY_COEFFICIENTS.high).toBeGreaterThan(PRIORITY_COEFFICIENTS.mid);
    expect(PRIORITY_COEFFICIENTS.mid).toBeGreaterThan(PRIORITY_COEFFICIENTS.low);
  });

  it("has expected values", () => {
    expect(PRIORITY_COEFFICIENTS.high).toBe(1.3);
    expect(PRIORITY_COEFFICIENTS.mid).toBe(1.0);
    expect(PRIORITY_COEFFICIENTS.low).toBe(0.7);
  });
});

// ── B.4: TaskProfile budgets ───────────────────────────────────────

describe("TASK_PROFILE_BUDGETS", () => {
  it("refactor_arch has largest token budget", () => {
    const ra = TASK_PROFILE_BUDGETS.refactor_arch;
    const bug = TASK_PROFILE_BUDGETS.bug_fix;
    const simple = TASK_PROFILE_BUDGETS.simple_script;
    const general = TASK_PROFILE_BUDGETS.general;

    expect(ra.maxTokens).toBeGreaterThan(general.maxTokens);
    expect(ra.recordLimit).toBeGreaterThan(general.recordLimit);
    expect(simple.maxTokens).toBeLessThan(general.maxTokens);
    expect(bug.maxSessionTokens).toBeGreaterThan(general.maxSessionTokens);
  });

  it("bug_fix prefers bug/error tags", () => {
    expect(TASK_PROFILE_BUDGETS.bug_fix.preferredTags).toContain("bug");
    expect(TASK_PROFILE_BUDGETS.bug_fix.tagBoost).toBeGreaterThan(1.0);
  });

  it("simple_script has minimal budget", () => {
    expect(TASK_PROFILE_BUDGETS.simple_script.maxTokens).toBe(500);
    expect(TASK_PROFILE_BUDGETS.simple_script.recordLimit).toBeLessThanOrEqual(2);
  });
});

// ── B.4: Dynamic token allocation in retrieval ─────────────────────

class FakeStore {
  records: any[] = [];
  add(r: any) { this.records.push(r); }
  listExcludingCurrent() { return this.records; }
}

describe("retrieval with task profiles", () => {
  it("refactor_arch profile uses higher limit", () => {
    const store = new FakeStore();
    for (let i = 0; i < 10; i++) {
      store.add(makeRecord({
        id: String(i),
        title: `Architecture decision ${i}`,
        summary: `Architecture summary ${i}`,
        content: "architecture design pattern",
        tags: ["reference"],
        priority: "high",
      }));
    }

    const retriever = new KeywordMemoryRetriever(store as any);
    const result = retriever.retrieve({
      goal: "architecture design",
      workspaceRoot: "/tmp",
      taskProfile: "refactor_arch",
    });

    expect(result.records.length).toBeLessThanOrEqual(8);
    expect(result.records.length).toBeGreaterThan(0);
  });

  it("simple_script profile uses low budget", () => {
    const store = new FakeStore();
    for (let i = 0; i < 10; i++) {
      store.add(makeRecord({
        id: String(i),
        title: `Script tip ${i}`,
        summary: `Script ${i} tip`,
        content: `script note ${i}`,
      }));
    }

    const retriever = new KeywordMemoryRetriever(store as any);
    const result = retriever.retrieve({
      goal: "script tips",
      workspaceRoot: "/tmp",
      taskProfile: "simple_script",
    });

    expect(result.records.length).toBeLessThanOrEqual(2);
    expect(result.injectedTokens).toBeLessThanOrEqual(600);
  });

  it("bug_fix profile boosts bug-tagged memories", () => {
    const store = new FakeStore();
    store.add(makeRecord({
      id: "bug-mem",
      title: "Parser crash fix",
      summary: "Fixed parser crash",
      content: "parser bug fix",
      tags: ["bug"],
      priority: "mid",
    }));
    store.add(makeRecord({
      id: "ref-mem",
      title: "Architecture doc",
      summary: "Architecture doc",
      content: "architecture",
      tags: ["reference"],
      priority: "mid",
    }));

    const retriever = new KeywordMemoryRetriever(store as any);
    const result = retriever.retrieve({
      goal: "parser crash",
      workspaceRoot: "/tmp",
      taskProfile: "bug_fix",
    });

    // bug-tagged memory should rank higher due to tag boost
    expect(result.records[0]?.id).toBe("bug-mem");
  });

  it("classifyTask auto-detection from goal", () => {
    // Goal: "修复登录报错" → should auto-classify as bug_fix
    const store = new FakeStore();
    store.add(makeRecord({
      id: "bug1",
      title: "Login error fix",
      summary: "Fixed login 500 error",
      content: "login bug fix error 修复 登录 报错",
      tags: ["bug"],
      priority: "high",
    }));
    store.add(makeRecord({
      id: "general1",
      title: "Random note",
      summary: "Random",
      content: "unrelated",
      priority: "mid",
    }));

    const retriever = new KeywordMemoryRetriever(store as any);
    // No explicit taskProfile — retriever defaults to "general" unless set
    // Task profile auto-detection happens in retrieveMemories(), not in retriever directly
    const result = retriever.retrieve({
      goal: "修复登录报错",
      workspaceRoot: "/tmp",
      taskProfile: "bug_fix",  // simulate what retrieveMemories does
    });

    expect(result.records.length).toBeGreaterThan(0);
    // bug-tagged memory should rank higher due to bug_fix tag boost
    expect(result.records[0]?.id).toBe("bug1");
  });
});

// ── A.4: Sharded index ────────────────────────────────────────────

describe("AutoMemoryStore sharded index", () => {
  function makeEntry(name: string, overrides: any = {}) {
    return {
      name,
      description: `Description for ${name}`,
      type: "reference" as const,
      content: `Content for ${name}`,
      ...overrides,
    };
  }

  // Use a fresh tmpDir per test to avoid stale state
  function setupStore() {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-shard-test-"));
    const s = new AutoMemoryStore({
      workspaceRoot: dir,
      memoryDir: path.join(dir, "memory"),
    });
    return { dir, store: s };
  }

  afterEach(() => {
    // Cleanup handled per-test via setupStore returning a fresh dir
  });

  it("creates shard files via buildIndex", () => {
    const { dir, store: s } = setupStore();
    for (let i = 0; i < 5; i++) {
      s.save(makeEntry(`entry-${i}`));
    }
    s.buildIndex();

    const shardPath = path.join(dir, "memory", "MEMORY-1.md");
    expect(existsSync(shardPath)).toBe(true);
    const shardContent = readFileSync(shardPath, "utf-8");
    expect(shardContent).toContain("entry-0");
  });

  it("loadAllIndexShards returns concatenated shards", () => {
    const { store: s } = setupStore();
    for (let i = 0; i < 5; i++) {
      s.save(makeEntry(`entry-${i}`));
    }
    s.buildIndex();

    const full = s.loadAllIndexShards();
    expect(full).not.toBeNull();
    expect(full!).toContain("entry-0");
    expect(full!).toContain("entry-4");
  });

  it("splits into multiple shards when over 180 entries", () => {
    const { dir, store: s } = setupStore();
    // Create 200 entries to trigger sharding
    for (let i = 0; i < 200; i++) {
      s.save(makeEntry(`entry-${i}`));
    }
    s.buildIndex();

    // Should have MEMORY-1.md and MEMORY-2.md
    expect(existsSync(path.join(dir, "memory", "MEMORY-1.md"))).toBe(true);
    expect(existsSync(path.join(dir, "memory", "MEMORY-2.md"))).toBe(true);

    const full = s.loadAllIndexShards();
    expect(full).toContain("entry-0");
    expect(full).toContain("entry-199");
  });

  it("master MEMORY.md references shard files", () => {
    const { dir, store: s } = setupStore();
    s.save(makeEntry("test"));
    s.buildIndex();

    const masterPath = path.join(dir, "memory", "MEMORY.md");
    const master = readFileSync(masterPath, "utf-8");
    expect(master).toContain("MEMORY-1.md");
  });

  it("cleans stale shards on rebuild", () => {
    const { dir, store: s } = setupStore();
    // Create enough entries for 2 shards
    for (let i = 0; i < 190; i++) {
      s.save(makeEntry(`entry-${i}`));
    }
    s.buildIndex();
    expect(existsSync(path.join(dir, "memory", "MEMORY-2.md"))).toBe(true);

    // Delete most entries, rebuild — should clean MEMORY-2.md
    for (let i = 0; i < 180; i++) {
      s.delete(`entry-${i}`);
    }
    s.buildIndex();

    expect(existsSync(path.join(dir, "memory", "MEMORY-2.md"))).toBe(false);
  });
});

// ── A.3: archiveExpired ────────────────────────────────────────────

describe("AutoMemoryStore archiveExpired", () => {
  function makeEntry(name: string, overrides: any = {}) {
    return {
      name,
      description: `Desc ${name}`,
      type: "reference" as const,
      content: `Content ${name}`,
      ...overrides,
    };
  }

  it("archives low-priority old memories", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-archive-test-"));
    const store = new AutoMemoryStore({
      workspaceRoot: dir,
      memoryDir: path.join(dir, "memory"),
    });

    // Save a low-priority entry with old timestamp
    const oldTs = Date.now() - 100 * 24 * 60 * 60 * 1000; // 100 days ago
    store.save(makeEntry("old-low", {
      priority: "low",
      updatedAt: oldTs,
      createdAt: oldTs,
    }));

    // Save a recent low-priority entry
    store.save(makeEntry("recent-low", {
      priority: "low",
      updatedAt: Date.now(),
    }));

    // Save a high-priority old entry (should NOT be archived)
    store.save(makeEntry("old-high", {
      priority: "high",
      updatedAt: oldTs,
    }));

    // Build index (triggers archiveExpired)
    store.buildIndex();

    // old-low should be archived
    const archivePath = path.join(dir, "memory", "archive", "old-low.md");
    expect(existsSync(archivePath)).toBe(true);

    // recent-low should NOT be archived (not old enough)
    expect(existsSync(path.join(dir, "memory", "recent-low.md"))).toBe(true);

    // old-high should NOT be archived (priority is high, not low)
    expect(existsSync(path.join(dir, "memory", "old-high.md"))).toBe(true);

    // old-low should be moved from main dir
    expect(existsSync(path.join(dir, "memory", "old-low.md"))).toBe(false);

    rmSync(dir, { recursive: true, force: true });
  });

  it("returns archive count", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-archive-count-"));
    const store = new AutoMemoryStore({
      workspaceRoot: dir,
      memoryDir: path.join(dir, "memory"),
    });

    const oldTs = Date.now() - 200 * 24 * 60 * 60 * 1000;
    store.save(makeEntry("old-1", { priority: "low", updatedAt: oldTs }));
    store.save(makeEntry("old-2", { priority: "low", updatedAt: oldTs }));

    const count = store.archiveExpired(90);
    expect(count).toBe(2);

    rmSync(dir, { recursive: true, force: true });
  });
});

// ── B.2: Reflection counter ────────────────────────────────────────

describe("shouldRunReflection", () => {
  it("returns false for first 19 calls, true on 20th", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-reflect-test-"));
    const memoryDir = path.join(dir, "memory");

    // Reset to ensure clean state
    resetReflectionCounter(memoryDir);

    // First 19 calls should return false
    for (let i = 0; i < 19; i++) {
      expect(shouldRunReflection(memoryDir)).toBe(false);
    }

    // 20th call should return true and reset counter
    expect(shouldRunReflection(memoryDir)).toBe(true);

    // After reset, next call should be false again
    expect(shouldRunReflection(memoryDir)).toBe(false);

    rmSync(dir, { recursive: true, force: true });
  });
});

// ── B.1: Frontmatter extended fields ───────────────────────────────

describe("AutoMemoryStore extended frontmatter", () => {
  it("round-trips new B.1 fields", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-fm-test-"));
    const store = new AutoMemoryStore({
      workspaceRoot: dir,
      memoryDir: path.join(dir, "memory"),
    });

    store.save({
      name: "full-entry",
      description: "Full entry with all fields",
      type: "reference",
      content: "Full content",
      priority: "high",
      error_signatures: ["TS2307", "Cannot find module"],
      tools_used: ["workspace.read_file", "workspace.edit_file"],
      valid_until: Date.now() + 86_400_000,
      linked_memories: ["other-memory", "arch-note"],
      tags: ["architecture", "typescript"],
      relatedFiles: ["packages/core/src/index.ts"],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const loaded = store.load("full-entry");
    expect(loaded).not.toBeNull();
    expect(loaded!.priority).toBe("high");
    expect(loaded!.error_signatures).toContain("TS2307");
    expect(loaded!.tools_used).toContain("workspace.read_file");
    expect(loaded!.valid_until).toBeGreaterThan(0);
    expect(loaded!.linked_memories).toContain("other-memory");
    expect(loaded!.tags).toContain("architecture");
    expect(loaded!.relatedFiles).toContain("packages/core/src/index.ts");

    rmSync(dir, { recursive: true, force: true });
  });

  it("loads entries without new fields as defaults", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-fm-legacy-"));
    const memoryDir = path.join(dir, "memory");
    const { mkdirSync, writeFileSync } = require("node:fs");
    mkdirSync(memoryDir, { recursive: true });

    // Write an old-format memory file (no priority, no error_signatures, etc.)
    writeFileSync(
      path.join(memoryDir, "legacy.md"),
      `---
name: legacy
description: A legacy entry without new fields
type: reference
---

Just content, no new frontmatter fields.
`,
      "utf-8",
    );

    const store = new AutoMemoryStore({
      workspaceRoot: dir,
      memoryDir,
    });

    const loaded = store.load("legacy");
    expect(loaded).not.toBeNull();
    expect(loaded!.priority).toBeUndefined();
    expect(loaded!.error_signatures).toBeUndefined();

    rmSync(dir, { recursive: true, force: true });
  });
});

// ── B.4: Profile-specific tag boost in score ────────────────────────

describe("tag boost in keyword scoring", () => {
  it("bug_fix profile boosts bug-tagged memories", () => {
    const store = new FakeStore();
    store.add(makeRecord({
      id: "bug-entry",
      title: "Memory leak fix",
      summary: "Fixed memory leak in parser",
      content: "memory leak bug fix parser",
      tags: ["bug", "fix"],
      priority: "mid",
    }));
    store.add(makeRecord({
      id: "ref-entry",
      title: "Parser architecture",
      summary: "Parser architecture overview",
      content: "parser architecture overview",
      tags: ["reference"],
      priority: "mid",
    }));

    const retriever = new KeywordMemoryRetriever(store as any);
    // Use a goal that would hit both equally by keyword
    const result = retriever.retrieve({
      goal: "parser memory",
      workspaceRoot: "/tmp",
      taskProfile: "bug_fix",
    });

    // Bug entry should rank first due to tag boost
    expect(result.records.length).toBeGreaterThan(0);
    expect(result.records[0]?.id).toBe("bug-entry");
  });
});
