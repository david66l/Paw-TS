import { describe, expect, it } from "bun:test";

import {
  formatMemoryManifest,
  shouldEscalateToLlmFallback,
} from "../src/memory-retrieval-cascade.js";
import type { MemoryRetrievalResult } from "../src/memory-retriever.js";
import { retrieveMemories } from "../src/memory-retrieve.js";
import { makeRecord } from "./fixtures.js";

describe("shouldEscalateToLlmFallback", () => {
  it("escalates on empty keyword results", () => {
    const result: MemoryRetrievalResult = {
      records: [],
      totalCandidates: 0,
      scores: [],
      injectedTokens: 0,
    };
    expect(shouldEscalateToLlmFallback(result, [], 3)).toBe(true);
  });

  it("does not escalate when meta fallback already ran", () => {
    const result: MemoryRetrievalResult = {
      records: [makeRecord()],
      totalCandidates: 2,
      scores: [1],
      injectedTokens: 10,
      usedMetaFallback: true,
    };
    expect(shouldEscalateToLlmFallback(result, [], 2)).toBe(false);
  });

  it("escalates on low top score", () => {
    const record = makeRecord({ id: "a" });
    const result: MemoryRetrievalResult = {
      records: [record],
      totalCandidates: 1,
      scores: [20],
      injectedTokens: 10,
    };
    expect(
      shouldEscalateToLlmFallback(result, [{ record, score: 20 }], 1),
    ).toBe(true);
  });

  it("escalates on weak separation between top candidates", () => {
    const first = makeRecord({ id: "a" });
    const second = makeRecord({ id: "b" });
    const result: MemoryRetrievalResult = {
      records: [first],
      totalCandidates: 2,
      scores: [35],
      injectedTokens: 10,
    };
    expect(
      shouldEscalateToLlmFallback(
        result,
        [
          { record: first, score: 35 },
          { record: second, score: 32 },
        ],
        2,
      ),
    ).toBe(true);
  });

  it("does not escalate when keyword confidence is strong", () => {
    const record = makeRecord({ id: "strong" });
    const result: MemoryRetrievalResult = {
      records: [record],
      totalCandidates: 1,
      scores: [80],
      injectedTokens: 10,
    };
    expect(
      shouldEscalateToLlmFallback(result, [{ record, score: 80 }], 1),
    ).toBe(false);
  });
});

describe("formatMemoryManifest", () => {
  it("includes id, source, title, and summary", () => {
    const manifest = formatMemoryManifest([
      makeRecord({
        id: "mem-1",
        source: "session",
        title: "Auth flow",
        summary: "Use JWT middleware",
        tags: ["auth"],
      }),
    ]);
    expect(manifest).toContain("[mem-1]");
    expect(manifest).toContain("[session]");
    expect(manifest).toContain("Auth flow");
    expect(manifest).toContain("tags: auth");
  });
});

describe("retrieveMemories cascade mode", () => {
  it("uses LLM fallback when keyword confidence is low", async () => {
    const store = {
      listExcludingCurrent: () => [
        makeRecord({
          id: "billing",
          title: "Billing architecture",
          summary: "Invoice totals and API usage metering",
          content: "Detailed billing notes",
        }),
        makeRecord({
          id: "unrelated",
          title: "Filesystem watcher",
          summary: "Monitors external file changes",
          content: "Watcher details",
        }),
      ],
    };

    const result = await retrieveMemories(
      store as never,
      {
        goal: "how should we refactor the authentication middleware",
        workspaceRoot: "/tmp",
        limit: 1,
        minScore: 15,
      },
      {
        mode: "cascade",
        llmSelect: async () => ["billing"],
      },
    );

    expect(result.retrievalMode).toBe("cascade");
    expect(result.usedLlmFallback).toBe(true);
    expect(result.records[0]?.id).toBe("billing");
  });

  it("skips LLM when keyword confidence is strong", async () => {
    const store = {
      listExcludingCurrent: () => [
        makeRecord({
          id: "parser",
          title: "Parser bug fix",
          summary: "Fixed parser crash on empty input",
          content: "parser parser parser",
          tags: ["parser"],
        }),
      ],
    };

    let llmCalled = false;
    const result = await retrieveMemories(
      store as never,
      { goal: "parser bug crash", workspaceRoot: "/tmp", limit: 1 },
      {
        mode: "cascade",
        llmSelect: async () => {
          llmCalled = true;
          return ["parser"];
        },
      },
    );

    expect(result.retrievalMode).toBe("cascade");
    expect(result.usedLlmFallback).toBe(false);
    expect(result.records[0]?.id).toBe("parser");
    expect(llmCalled).toBe(false);
  });
});
