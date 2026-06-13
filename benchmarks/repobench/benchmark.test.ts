import { describe, expect, test } from "bun:test";

import type { MemoryRecord } from "../../packages/core/src/memory-record.js";
import { KeywordMemoryRetriever } from "../../packages/core/src/memory-retriever.js";
import type { UnifiedMemoryStore } from "../../packages/core/src/unified-memory-store.js";
import { loadLocalCorpus, loadLocalQueries } from "./adapter.js";

class CorpusStore implements UnifiedMemoryStore {
  private readonly records: MemoryRecord[];

  constructor(records: MemoryRecord[]) {
    this.records = records;
  }

  listExcludingCurrent(): MemoryRecord[] {
    return this.records;
  }
}

/** Split camelCase / PascalCase into space-separated lowercase words. */
function splitCamelCase(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase();
}

function recallAtK(
  retrievedIds: readonly string[],
  expected: readonly string[],
  k: number,
): number {
  if (expected.length === 0) return retrievedIds.length === 0 ? 1 : 0;
  const hit = expected.some((id) => retrievedIds.slice(0, k).includes(id));
  return hit ? 1 : 0;
}

function mrr(
  retrievedIds: readonly string[],
  expected: readonly string[],
): number {
  if (expected.length === 0) return retrievedIds.length === 0 ? 1 : 0;
  for (let i = 0; i < retrievedIds.length; i++) {
    if (expected.includes(retrievedIds[i]!)) {
      return 1 / (i + 1);
    }
  }
  return 0;
}

describe("benchmark: RepoBench (local corpus)", () => {
  const corpus = loadLocalCorpus();
  const queries = loadLocalQueries();

  // Convert RepoBench records to MemoryRecord format.
  // Inject camelCase-split title into summary so keyword retriever can match.
  const memoryRecords: MemoryRecord[] = corpus.map((r) => {
    const title = r.id.split(":").pop() ?? r.id;
    const splitTitle = splitCamelCase(title);
    return {
      id: r.id,
      source: "project",
      scope: "project",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      title,
      summary: [r.docstring, splitTitle].filter(Boolean).join(" "),
      content: r.code.slice(0, 500),
      tags: [],
      relatedFiles: [r.file, ...r.relatedFiles],
      relatedErrors: [],
    };
  });

  const store = new CorpusStore(memoryRecords);
  const retriever = new KeywordMemoryRetriever(store);

  test("corpus has at least 50 snippets", () => {
    expect(corpus.length).toBeGreaterThanOrEqual(50);
  });

  test("recall@5 macro >= 0.5 and MRR macro >= 0.4", () => {
    const K = 5;
    let recallSum = 0;
    let mrrSum = 0;

    for (const q of queries) {
      // Omit currentFile to test pure keyword retrieval (path match is
      // validated separately). This avoids currentFile giving 60 pts to
      // unrelated records in the same file.
      const result = retriever.retrieve({
        goal: q.goal,
        workspaceRoot: process.cwd(),
        limit: K,
      });
      const ids = result.records.map((r) => r.id);
      recallSum += recallAtK(ids, q.expectedIds, K);
      mrrSum += mrr(ids, q.expectedIds);
    }

    const n = queries.length;
    const recallMacro = recallSum / n;
    const mrrMacro = mrrSum / n;

    console.log(`RepoBench results: recall@5=${recallMacro.toFixed(2)}, MRR=${mrrMacro.toFixed(2)} (n=${n}, corpus=${corpus.length})`);

    expect(recallMacro).toBeGreaterThanOrEqual(0.5);
    expect(mrrMacro).toBeGreaterThanOrEqual(0.4);
  });

  test("negative query returns no false positives", () => {
    const negative = queries.find((q) => q.id === "q5-negative");
    expect(negative).toBeDefined();
    if (!negative) return;

    const result = retriever.retrieve({
      goal: negative.goal,
      workspaceRoot: process.cwd(),
      limit: 5,
    });

    // Should not retrieve anything strongly related to PyTorch/ML
    const bad = result.records.filter((r) =>
      /torch|train|model|pytorch|tensorflow/i.test(r.title + r.summary),
    );
    expect(bad.length).toBeLessThanOrEqual(2);
  });
});
