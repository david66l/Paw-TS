import { describe, expect, it } from "bun:test";
import type { MemoryRecord } from "../src/memory-record.js";
import { extractCleanMemoryQuery } from "../src/memory-record.js";
import { KeywordMemoryRetriever } from "../src/memory-retriever.js";

function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "test",
    source: "auto",
    scope: "project",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    title: "Test",
    summary: "Summary",
    content: "Content",
    tags: [],
    relatedFiles: [],
    relatedErrors: [],
    ...overrides,
  };
}

class FakeStore {
  private records: MemoryRecord[] = [];

  add(r: MemoryRecord) {
    this.records.push(r);
  }

  listExcludingCurrent(): MemoryRecord[] {
    return this.records;
  }
}

describe("KeywordMemoryRetriever", () => {
  it("retrieves by keyword match", () => {
    const store = new FakeStore();
    store.add(
      makeRecord({ id: "a", title: "Fix parser bug", content: "parser issue" }),
    );
    store.add(
      makeRecord({ id: "b", title: "Update docs", content: "documentation" }),
    );

    const retriever = new KeywordMemoryRetriever(store as any);
    const result = retriever.retrieve({
      goal: "parser bug",
      workspaceRoot: "/tmp",
    });

    expect(result.records.length).toBeGreaterThanOrEqual(1);
    expect(result.records[0]?.title).toBe("Fix parser bug");
  });

  it("scores same file path highest", () => {
    const store = new FakeStore();
    store.add(
      makeRecord({
        id: "same",
        title: "Same file",
        relatedFiles: ["src/context-manager.ts"],
      }),
    );
    store.add(
      makeRecord({
        id: "diff",
        title: "Different file",
        relatedFiles: ["src/orchestrator.ts"],
      }),
    );

    const retriever = new KeywordMemoryRetriever(store as any);
    const result = retriever.retrieve({
      goal: "work",
      currentFile: "src/context-manager.ts",
      workspaceRoot: "/tmp",
    });

    expect(result.records[0]?.id).toBe("same");
  });

  it("scores same directory higher than different when text is relevant", () => {
    const store = new FakeStore();
    store.add(
      makeRecord({
        id: "same-dir",
        title: "Same dir",
        content: "parser implementation detail",
        relatedFiles: ["src/utils/helper.ts"],
      }),
    );
    store.add(
      makeRecord({
        id: "diff-dir",
        title: "Diff dir",
        content: "parser implementation detail",
        relatedFiles: ["test/helper.ts"],
      }),
    );

    const retriever = new KeywordMemoryRetriever(store as any);
    const result = retriever.retrieve({
      goal: "parser implementation",
      currentFile: "src/utils/main.ts",
      workspaceRoot: "/tmp",
    });

    expect(result.records[0]?.id).toBe("same-dir");
  });

  it("does not retrieve by broad same-directory path alone", () => {
    const store = new FakeStore();
    store.add(
      makeRecord({
        id: "unrelated",
        title: "Run result tracking",
        summary: "Sub-agent step accounting",
        content:
          "Tracks stepsTaken for launched sub agents in packages/core/src/run.ts.",
        relatedFiles: ["packages/core/src/run.ts"],
      }),
    );

    const retriever = new KeywordMemoryRetriever(store as any);
    const result = retriever.retrieve({
      goal: "Review packages/core/src/cost-tracker.ts",
      currentFile: "packages/core/src/cost-tracker.ts",
      workspaceRoot: "/tmp",
    });

    expect(result.records.map((r) => r.id)).not.toContain("unrelated");
  });

  it("uses file basename terms without matching generic directory segments", () => {
    const store = new FakeStore();
    store.add(
      makeRecord({
        id: "path-memory",
        title: "Path escape workspace",
        summary: "Workspace boundary checks",
      }),
    );
    store.add(
      makeRecord({
        id: "directory-noise",
        title: "Workspace watcher",
        summary: "External file monitoring",
      }),
    );

    const retriever = new KeywordMemoryRetriever(store as any);
    const result = retriever.retrieve({
      goal: "Review packages/workspace/src/path-guard.ts",
      currentFile: "packages/workspace/src/path-guard.ts",
      workspaceRoot: "/tmp",
    });

    expect(result.records[0]?.id).toBe("path-memory");
    expect(result.records.map((r) => r.id)).not.toContain("directory-noise");
  });

  it("respects limit", () => {
    const store = new FakeStore();
    for (let i = 0; i < 10; i++) {
      store.add(makeRecord({ id: String(i), title: `Memory ${i}` }));
    }

    const retriever = new KeywordMemoryRetriever(store as any);
    const result = retriever.retrieve({
      goal: "memory",
      workspaceRoot: "/tmp",
      limit: 3,
    });

    expect(result.records.length).toBeLessThanOrEqual(3);
  });

  it("respects token budget", () => {
    const store = new FakeStore();
    // Long title + summary to consume tokens
    const longText = "a".repeat(400); // ~100 tokens
    store.add(makeRecord({ id: "1", title: longText, summary: longText }));
    store.add(makeRecord({ id: "2", title: longText, summary: longText }));
    store.add(makeRecord({ id: "3", title: longText, summary: longText }));

    const retriever = new KeywordMemoryRetriever(store as any);
    const result = retriever.retrieve({
      goal: "a",
      workspaceRoot: "/tmp",
      limit: 10,
      maxTokens: 250, // should fit ~2 records (~200 tokens each)
    });

    expect(result.injectedTokens).toBeLessThanOrEqual(250);
    expect(result.records.length).toBeLessThanOrEqual(2);
  });

  it("boosts recent memories", () => {
    const store = new FakeStore();
    store.add(
      makeRecord({
        id: "old",
        title: "Old memory",
        updatedAt: Date.now() - 1000 * 60 * 60 * 24 * 60, // 60 days ago
      }),
    );
    store.add(
      makeRecord({
        id: "new",
        title: "New memory",
        updatedAt: Date.now(),
      }),
    );

    const retriever = new KeywordMemoryRetriever(store as any);
    const result = retriever.retrieve({
      goal: "memory",
      workspaceRoot: "/tmp",
    });

    expect(result.records[0]?.id).toBe("new");
  });

  it("matches error signatures", () => {
    const store = new FakeStore();
    store.add(
      makeRecord({
        id: "err",
        title: "TypeError fix",
        relatedErrors: ["TypeError", "Cannot read property"],
      }),
    );
    store.add(makeRecord({ id: "other", title: "Other" }));

    const retriever = new KeywordMemoryRetriever(store as any);
    const result = retriever.retrieve({
      goal: "work",
      errorMessage: "TypeError: Cannot read property 'x' of undefined",
      workspaceRoot: "/tmp",
    });

    expect(result.records[0]?.id).toBe("err");
  });

  it("includes scores in result", () => {
    const store = new FakeStore();
    store.add(makeRecord({ id: "a", title: "Alpha" }));

    const retriever = new KeywordMemoryRetriever(store as any);
    const result = retriever.retrieve({
      goal: "alpha",
      workspaceRoot: "/tmp",
    });

    expect(result.scores.length).toBe(result.records.length);
    expect(result.scores[0]).toBeGreaterThan(0);
  });

  it("returns totalCandidates", () => {
    const store = new FakeStore();
    store.add(makeRecord({ id: "1", title: "One" }));
    store.add(makeRecord({ id: "2", title: "Two" }));

    const retriever = new KeywordMemoryRetriever(store as any);
    const result = retriever.retrieve({
      goal: "one",
      workspaceRoot: "/tmp",
      limit: 1,
    });

    expect(result.totalCandidates).toBeGreaterThanOrEqual(1);
  });

  it("uses recentFiles for path matching", () => {
    const store = new FakeStore();
    store.add(
      makeRecord({
        id: "match",
        title: "Match",
        relatedFiles: ["src/parser.ts"],
      }),
    );

    const retriever = new KeywordMemoryRetriever(store as any);
    const result = retriever.retrieve({
      goal: "work",
      recentFiles: ["src/parser.ts"],
      workspaceRoot: "/tmp",
    });

    expect(result.records.length).toBeGreaterThanOrEqual(1);
    expect(result.records[0]?.id).toBe("match");
  });

  it("penalizes memories whose relatedFiles are unrelated to query path", () => {
    const store = new FakeStore();
    store.add(
      makeRecord({
        id: "noise",
        title: "Run result tracking",
        summary: "Tracks stepsTaken for launched sub agents",
        content:
          "If adding steps/turns to RunResult, wire it through the return path in orchestrator.ts:610.",
        relatedFiles: ["packages/core/src/run.ts"],
      }),
    );

    const retriever = new KeywordMemoryRetriever(store as any);
    const result = retriever.retrieve({
      goal: "只读任务：检查 packages/workspace/src/path-guard.ts",
      currentFile: "packages/workspace/src/path-guard.ts",
      workspaceRoot: "/tmp",
    });

    expect(result.records.map((r) => r.id)).not.toContain("noise");
  });

  it("keeps memories without relatedFiles when they have weak keyword match", () => {
    const store = new FakeStore();
    store.add(
      makeRecord({
        id: "relevant",
        title: "Path escape workspace",
        summary: "Workspace boundary checks",
        relatedFiles: [],
      }),
    );

    const retriever = new KeywordMemoryRetriever(store as any);
    const result = retriever.retrieve({
      goal: "只读任务：检查 packages/workspace/src/path-guard.ts",
      currentFile: "packages/workspace/src/path-guard.ts",
      workspaceRoot: "/tmp",
    });

    expect(result.records.map((r) => r.id)).toContain("relevant");
  });

  it("extracts clean memory query from resumed session context", () => {
    const polluted = `[Background: previous context]
Previous goal: 只读任务：检查 packages/workspace/src/path-guard.ts，说明路径逃逸防护。不要修改文件。
Progress: completed

[Current user request]
只读任务：检查 packages/core/src/cost-tracker.ts，说明成本统计如何格式化。不要修改文件。`;
    const clean = extractCleanMemoryQuery(polluted);
    expect(clean).toBe(
      "只读任务：检查 packages/core/src/cost-tracker.ts，说明成本统计如何格式化。不要修改文件。",
    );

    // Without marker, returns the original string
    expect(extractCleanMemoryQuery("plain goal")).toBe("plain goal");
  });

  it("does not retrieve unrelated memories when goal contains resumed context", () => {
    const store = new FakeStore();
    store.add(
      makeRecord({
        id: "path-guard-memory",
        title: "Path escape workspace",
        summary: "Workspace boundary checks for path-guard.ts",
        relatedFiles: ["packages/workspace/src/path-guard.ts"],
      }),
    );

    const retriever = new KeywordMemoryRetriever(store as any);

    const pollutedGoal = `[Background: previous context]
Previous goal: 只读任务：检查 packages/workspace/src/path-guard.ts，说明路径逃逸防护。不要修改文件。
Progress: completed

[Current user request]
只读任务：检查 packages/core/src/cost-tracker.ts，说明成本统计如何格式化。不要修改文件。`;

    const cleanQuery = extractCleanMemoryQuery(pollutedGoal);
    const result = retriever.retrieve({
      goal: cleanQuery,
      currentFile: "packages/core/src/cost-tracker.ts",
      workspaceRoot: "/tmp",
    });

    // path-guard memory should not be recalled for cost-tracker query
    expect(result.records.map((r) => r.id)).not.toContain("path-guard-memory");
  });

  it("meta memory query falls back to recent entries", () => {
    const store = new FakeStore();
    store.add(
      makeRecord({
        id: "old",
        title: "old entry",
        summary: "old",
        updatedAt: Date.now() - 86_400_000,
      }),
    );
    store.add(
      makeRecord({
        id: "recent",
        title: "user preference",
        summary: "Chinese communication",
        updatedAt: Date.now(),
      }),
    );

    const retriever = new KeywordMemoryRetriever(store as any);
    const result = retriever.retrieve({
      goal: "还记得之前的记忆吗",
      workspaceRoot: "/tmp",
    });

    expect(result.records.length).toBeGreaterThan(0);
    expect(result.records[0]?.id).toBe("recent");
  });

  it("caps session memories in top-k", () => {
    const store = new FakeStore();
    const longText = "session context detail ".repeat(20);
    for (let i = 0; i < 4; i++) {
      store.add(
        makeRecord({
          id: `session-${i}`,
          source: "session",
          title: `Session task ${i}`,
          summary: longText,
          content: longText,
          updatedAt: Date.now() - i * 1000,
        }),
      );
    }
    store.add(
      makeRecord({
        id: "auto-match",
        title: "Session task auto",
        summary: "session task detail",
        content: "session task detail",
      }),
    );

    const retriever = new KeywordMemoryRetriever(store as any);
    const result = retriever.retrieve({
      goal: "session task detail",
      workspaceRoot: "/tmp",
      limit: 5,
      maxTokens: 5000,
    });

    const sessionIds = result.records
      .filter((r) => r.source === "session")
      .map((r) => r.id);
    expect(sessionIds.length).toBeLessThanOrEqual(2);
  });

  it("respects session token budget", () => {
    const store = new FakeStore();
    const longSummary = "x".repeat(2400);
    store.add(
      makeRecord({
        id: "s1",
        source: "session",
        title: "Budget session one",
        summary: longSummary,
        content: longSummary,
      }),
    );
    store.add(
      makeRecord({
        id: "s2",
        source: "session",
        title: "Budget session two",
        summary: longSummary,
        content: longSummary,
      }),
    );

    const retriever = new KeywordMemoryRetriever(store as any);
    const result = retriever.retrieve({
      goal: "budget session",
      workspaceRoot: "/tmp",
      limit: 5,
      maxTokens: 10_000,
    });

    const sessionRecords = result.records.filter((r) => r.source === "session");
    expect(sessionRecords.length).toBeLessThanOrEqual(1);
  });

  it("reports meta fallback candidate count", () => {
    const store = new FakeStore();
    store.add(
      makeRecord({
        id: "ref",
        title: "Memory reference",
        tags: ["reference"],
      }),
    );
    store.add(
      makeRecord({
        id: "noise",
        title: "unrelated topic",
        updatedAt: Date.now() - 86_400_000 * 30,
      }),
    );

    const retriever = new KeywordMemoryRetriever(store as any);
    const result = retriever.retrieve({
      goal: "还记得之前的记忆吗",
      workspaceRoot: "/tmp",
    });

    expect(result.usedMetaFallback).toBe(true);
    expect(result.totalCandidates).toBe(1);
    expect(result.records[0]?.id).toBe("ref");
  });

  it("does not treat memory mechanism queries as meta", () => {
    const store = new FakeStore();
    store.add(
      makeRecord({
        id: "retriever-doc",
        title: "Memory retriever scoring",
        summary: "path scoring logic",
        content: "memory-retriever keyword scoring",
      }),
    );

    const retriever = new KeywordMemoryRetriever(store as any);
    const result = retriever.retrieve({
      goal: "Explain memory-retriever path scoring",
      currentFile: "packages/core/src/memory-retriever.ts",
      workspaceRoot: "/tmp",
    });

    expect(result.usedMetaFallback).toBeUndefined();
    expect(result.records[0]?.id).toBe("retriever-doc");
  });

  it("boosts reference memories for architecture queries", () => {
    const store = new FakeStore();
    store.add(
      makeRecord({
        id: "project",
        title: "orchestrator notes",
        summary: "general orchestrator notes",
        tags: ["project"],
      }),
    );
    store.add(
      makeRecord({
        id: "reference",
        title: "Orchestrator architecture",
        summary: "orchestrator loop and tool runner",
        tags: ["reference"],
      }),
    );

    const retriever = new KeywordMemoryRetriever(store as any);
    const result = retriever.retrieve({
      goal: "explain orchestrator architecture",
      workspaceRoot: "/tmp",
    });

    expect(result.records[0]?.id).toBe("reference");
  });

  it("meta fallback prefers reference memories", () => {
    const store = new FakeStore();
    store.add(
      makeRecord({
        id: "ref",
        title: "Memory system reference",
        summary: "How memory retrieval works",
        tags: ["reference"],
        updatedAt: Date.now() - 86_400_000,
      }),
    );
    store.add(
      makeRecord({
        id: "recent-auto",
        title: "Recent auto note",
        summary: "unrelated",
        updatedAt: Date.now(),
      }),
    );

    const retriever = new KeywordMemoryRetriever(store as any);
    const result = retriever.retrieve({
      goal: "有哪些 reference 记忆",
      workspaceRoot: "/tmp",
    });

    expect(result.records[0]?.id).toBe("ref");
  });
});
