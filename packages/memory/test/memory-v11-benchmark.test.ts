import { describe, expect, it } from "bun:test";
import type { MemoryRecord } from "../src/memory-record.js";
import { KeywordMemoryRetriever } from "../src/memory-retriever.js";
import { makeRecord } from "./fixtures.js";

interface BenchmarkQuery {
  readonly goal: string;
  readonly currentFile?: string;
  readonly expectTop1?: string;
  readonly expectAnyOf?: readonly string[];
}

class FixtureStore {
  constructor(private readonly records: MemoryRecord[]) {}

  listExcludingCurrent(): MemoryRecord[] {
    return this.records;
  }
}

const FIXTURE_MEMORIES: MemoryRecord[] = [
  makeRecord({
    id: "path-guard",
    title: "Path escape workspace",
    summary: "Workspace boundary checks for path-guard.ts",
    content: "path-guard prevents directory traversal",
    tags: ["reference"],
    relatedFiles: ["packages/workspace/src/path-guard.ts"],
  }),
  makeRecord({
    id: "memory-retriever",
    title: "Memory retriever scoring",
    summary: "Keyword memory retriever with recency and path match",
    content: "memory-retriever.ts scoring dimensions",
    tags: ["reference"],
    relatedFiles: ["packages/core/src/memory-retriever.ts"],
  }),
  makeRecord({
    id: "cost-tracker",
    title: "Cost tracker formatting",
    summary: "Token cost estimation and currency formatting",
    content: "cost-tracker formats USD and CNY",
    tags: ["project"],
    relatedFiles: ["packages/core/src/cost-tracker.ts"],
  }),
  makeRecord({
    id: "session-compactor",
    source: "session",
    title: "Compactor threshold tuning",
    summary: "Adjusted L2 compact threshold for history pool",
    content: "compactor uses history budget 70%",
    tags: ["memory"],
    relatedFiles: ["packages/core/src/context-compactor.ts"],
  }),
  makeRecord({
    id: "session-path-guard",
    source: "session",
    createdAt: Date.now() - 86_400_000,
    updatedAt: Date.now() - 86_400_000,
    title: "Review path-guard.ts",
    summary: "Previous session reviewed path escape rules",
    content: "path guard symlink checks",
    relatedFiles: ["packages/workspace/src/path-guard.ts"],
  }),
  makeRecord({
    id: "orchestrator-ref",
    title: "Orchestrator loop",
    summary: "Multi-turn orchestrator with compression gates",
    content: "orchestrator.ts run loop",
    tags: ["reference"],
    relatedFiles: ["packages/agent/src/orchestrator.ts"],
  }),
  makeRecord({
    id: "user-pref",
    title: "User Chinese preference",
    summary: "User prefers Chinese communication",
    content: "respond in Chinese",
    tags: ["user"],
  }),
];

const V11_QUERIES: BenchmarkQuery[] = [
  {
    goal: "Review packages/workspace/src/path-guard.ts",
    currentFile: "packages/workspace/src/path-guard.ts",
    expectTop1: "path-guard",
  },
  {
    goal: "Explain memory-retriever scoring",
    currentFile: "packages/core/src/memory-retriever.ts",
    expectTop1: "memory-retriever",
  },
  {
    goal: "How does cost-tracker format currency?",
    currentFile: "packages/core/src/cost-tracker.ts",
    expectTop1: "cost-tracker",
  },
  {
    goal: "explain orchestrator architecture",
    expectTop1: "orchestrator-ref",
  },
  {
    goal: "上次讨论的 compactor 策略是什么",
    expectAnyOf: ["session-compactor", "orchestrator-ref"],
  },
  {
    goal: "之前 run 的 path-guard 问题",
    expectAnyOf: ["session-path-guard", "path-guard"],
  },
  {
    goal: "有哪些 reference 记忆",
    expectAnyOf: ["path-guard", "memory-retriever", "orchestrator-ref"],
  },
  {
    goal: "还记得之前的记忆吗",
    expectAnyOf: ["user-pref", "path-guard", "memory-retriever"],
  },
  {
    goal: "parser bug in context manager",
    currentFile: "packages/core/src/context-manager.ts",
    expectAnyOf: [],
  },
  {
    goal: "registry tool catalog",
    expectAnyOf: ["orchestrator-ref", "memory-retriever"],
  },
];

describe("memory v11 benchmark", () => {
  it("meets hit-rate target on fixture queries", () => {
    const retriever = new KeywordMemoryRetriever(new FixtureStore(FIXTURE_MEMORIES) as any);
    let hits = 0;
    let scored = 0;

    for (const q of V11_QUERIES) {
      if (!q.expectTop1 && !q.expectAnyOf?.length) continue;
      scored++;
      const result = retriever.retrieve({
        goal: q.goal,
        currentFile: q.currentFile,
        workspaceRoot: "/tmp",
      });
      const top1 = result.records[0]?.id;
      const topIds = result.records.map((r) => r.id);
      const hit =
        (q.expectTop1 && top1 === q.expectTop1) ||
        (q.expectAnyOf && q.expectAnyOf.some((id) => topIds.includes(id)));
      if (hit) hits++;
    }

    const hitRate = hits / scored;
    expect(hitRate).toBeGreaterThanOrEqual(0.85);
  });
});
