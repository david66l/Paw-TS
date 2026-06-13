import { describe, expect, it } from "bun:test";
import type { MemoryRecord } from "../src/memory-record.js";
import { buildSystemPromptWithBudget } from "../src/system-prompt.js";

function makeMemory(id: string, content: string): MemoryRecord {
  return {
    id,
    source: "auto",
    scope: "project",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    title: id,
    summary: content.slice(0, 120),
    content,
    tags: [],
    relatedFiles: [],
    relatedErrors: [],
  };
}

describe("buildSystemPromptWithBudget", () => {
  it("returns full prompt when under budget", () => {
    const result = buildSystemPromptWithBudget(
      {
        workspaceRoot: "/tmp/project",
        toolCatalog: "tool.a",
        modelLabel: "test",
        modelId: "test",
        memoryDir: "/tmp/memory",
        hasAutoMemory: true,
      },
      50_000,
      (text) => Math.ceil(text.length / 4),
    );
    expect(result.trimmed).toEqual([]);
    expect(result.content).toContain("You are Paw");
  });

  it("trims memory detail when over system budget", () => {
    const hugeIndex = Array.from({ length: 300 }, (_, i) => `- [m${i}](m${i}.md)`).join(
      "\n",
    );
    const memories = Array.from({ length: 5 }, (_, i) =>
      makeMemory(`mem-${i}`, "detail ".repeat(500)),
    );

    const full = buildSystemPromptWithBudget(
      {
        workspaceRoot: "/tmp/project",
        toolCatalog: "tool.a",
        modelLabel: "test",
        modelId: "test",
        memoryDir: "/tmp/memory",
        hasAutoMemory: true,
        memoryIndex: hugeIndex,
        relevantMemories: memories,
        pawMd: "x".repeat(20_000),
      },
      8_000,
      (text) => Math.ceil(text.length / 4),
    );

    expect(full.trimmed.length).toBeGreaterThan(0);
    expect(full.content).not.toContain("Detail:");
  });

  it("guarantees assembled prompt fits within system budget", () => {
    const hugeIndex = Array.from({ length: 300 }, (_, i) => `- [m${i}](m${i}.md)`).join(
      "\n",
    );
    const memories = Array.from({ length: 5 }, (_, i) =>
      makeMemory(`mem-${i}`, "detail ".repeat(500)),
    );
    const systemBudget = 8_000;
    const estimate = (text: string) => Math.ceil(text.length / 4);

    const result = buildSystemPromptWithBudget(
      {
        workspaceRoot: "/tmp/project",
        toolCatalog: "tool.line\n".repeat(4000),
        skills: "skill ".repeat(2000),
        modelLabel: "test",
        modelId: "test",
        memoryDir: "/tmp/memory",
        hasAutoMemory: true,
        memoryIndex: hugeIndex,
        relevantMemories: memories,
        pawMd: "x".repeat(20_000),
      },
      systemBudget,
      estimate,
    );

    expect(estimate(result.content)).toBeLessThanOrEqual(systemBudget);
    expect(result.trimmed.length).toBeGreaterThan(0);
  });
});
