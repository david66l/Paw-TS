import { describe, expect, it } from "bun:test";

import {
  isArchitectureQuery,
  isMemoryMetaQuery,
  isReferenceMemory,
} from "../src/memory-record.js";
import type { MemoryRecord } from "../src/memory-record.js";

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
    priority: "mid",
    ...overrides,
  };
}

describe("isMemoryMetaQuery", () => {
  it("matches explicit meta questions", () => {
    expect(isMemoryMetaQuery("还记得之前的记忆吗")).toBe(true);
    expect(isMemoryMetaQuery("有哪些 reference 记忆")).toBe(true);
    expect(isMemoryMetaQuery("what memories do you have")).toBe(true);
    expect(isMemoryMetaQuery("do you remember our last session")).toBe(true);
  });

  it("does not match technical memory-task queries", () => {
    expect(
      isMemoryMetaQuery(
        "只读任务：检查 packages/core/src/memory-retriever.ts，说明 path scoring",
      ),
    ).toBe(false);
    expect(isMemoryMetaQuery("Explain memory-retriever scoring")).toBe(false);
    expect(isMemoryMetaQuery("上下文记忆机制如何实现")).toBe(false);
    expect(isMemoryMetaQuery("memory retrieval benchmark v11")).toBe(false);
  });
});

describe("isArchitectureQuery", () => {
  it("detects architecture keywords", () => {
    expect(isArchitectureQuery("explain orchestrator architecture")).toBe(true);
    expect(isArchitectureQuery("path-guard behavior")).toBe(true);
  });
});

describe("isReferenceMemory", () => {
  it("detects reference tag", () => {
    expect(isReferenceMemory(makeRecord({ tags: ["reference"] }))).toBe(true);
    expect(isReferenceMemory(makeRecord({ tags: ["project"] }))).toBe(false);
  });
});
