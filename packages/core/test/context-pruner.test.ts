import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";

import type { ChatMessage } from "../src/context/manager.js";
import { pruneToolResults } from "../src/context/pruner.js";
import {
  DEFAULT_KEEP_RECENT_TOOLS,
  PERSISTED_OUTPUT_OPEN,
} from "../src/tool-result/storage.js";

function tempToolResultsDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "paw-tool-results-"));
}

function toolResult(
  tool: string,
  ok: boolean,
  summary: string,
  data?: string,
): string {
  const d = data ? `\n${data}` : "";
  return `[Tool ${tool} ${ok ? "completed" : "failed"}]\n${summary}${d}`;
}

describe("pruneToolResults", () => {
  test("no tool results → no pruning", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" },
    ];
    const result = pruneToolResults(messages, {
      toolResultsDir: tempToolResultsDir(),
    });
    expect(result.pruned).toBe(false);
    expect(result.freedTokens).toBe(0);
    expect(result.messages).toEqual(messages);
  });

  test("without toolResultsDir → no-op", () => {
    const longOutput = "x".repeat(60_000);
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: toolResult("read_file", true, "big file", longOutput),
      },
    ];
    const result = pruneToolResults(messages);
    expect(result.pruned).toBe(false);
    expect(result.messages[0]?.content.length).toBeGreaterThan(60_000);
  });

  test("many short lines under limits are not persisted (Phase A)", () => {
    const dir = tempToolResultsDir();
    const manyLines = "a\n".repeat(600);
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: toolResult("grep", true, "600 hits", manyLines),
      },
    ];
    const result = pruneToolResults(messages, { toolResultsDir: dir });
    expect(result.pruned).toBe(false);
    expect(result.messages[0]?.content).toContain(manyLines.slice(0, 20));
    expect(fs.readdirSync(dir).length).toBe(0);
  });

  test("persists oversized tool result by bytes", () => {
    const dir = tempToolResultsDir();
    const longOutput = "x".repeat(60_000);
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: toolResult("read_file", true, "big file", longOutput),
      },
    ];
    const result = pruneToolResults(messages, {
      toolResultsDir: dir,
      maxToolOutputBytes: 50_000,
    });
    expect(result.pruned).toBe(true);
    const pruned = result.messages[0]!;
    expect(pruned.content).toContain(PERSISTED_OUTPUT_OPEN);
    expect(pruned.content.length).toBeLessThan(10_000);
  });

  test("never persists protected tools (skill)", () => {
    const dir = tempToolResultsDir();
    const longOutput = "x".repeat(60_000);
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: toolResult("skill", true, "big skill result", longOutput),
      },
    ];
    const result = pruneToolResults(messages, {
      toolResultsDir: dir,
      maxToolOutputBytes: 50_000,
    });
    expect(result.pruned).toBe(false);
    expect(result.messages[0]?.content.length).toBeGreaterThan(60_000);
    expect(fs.readdirSync(dir).length).toBe(0);
  });

  test("persists old tool results beyond keepRecentTools", () => {
    const dir = tempToolResultsDir();
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "goal" },
      { role: "assistant", content: "ok" },
    ];
    for (let i = 0; i < 8; i++) {
      messages.push({
        role: "user",
        content: toolResult(
          "read_file",
          true,
          `file${i}`,
          "content".repeat(800),
        ),
      });
    }

    const result = pruneToolResults(messages, {
      toolResultsDir: dir,
      keepRecentTools: DEFAULT_KEEP_RECENT_TOOLS,
    });
    expect(result.pruned).toBe(true);
    expect(result.freedTokens).toBeGreaterThan(0);

    const last = result.messages[result.messages.length - 1]!;
    expect(last.content).toContain("contentcontent");
    expect(last.content).not.toContain(PERSISTED_OUTPUT_OPEN);

    const older = result.messages[result.messages.length - 6]!;
    expect(older.content).toContain(PERSISTED_OUTPUT_OPEN);
  });

  test("persists tool results but leaves non-tool messages alone", () => {
    const dir = tempToolResultsDir();
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "goal" },
      { role: "assistant", content: "let me check" },
    ];
    for (let i = 0; i < 7; i++) {
      messages.push({
        role: "user",
        content: toolResult("read_file", true, `file${i}`, "x".repeat(1000)),
      });
      messages.push({ role: "assistant", content: `step ${i}` });
    }

    const result = pruneToolResults(messages, {
      toolResultsDir: dir,
      keepRecentTools: 2,
    });
    expect(result.pruned).toBe(true);

    const assistantMsg = result.messages.find((m) => m.content === "let me check");
    expect(assistantMsg).toBeDefined();

    const oldTool = result.messages[3]!;
    expect(oldTool.content).toContain(PERSISTED_OUTPUT_OPEN);
  });

  test("returns same reference when nothing changes", () => {
    const dir = tempToolResultsDir();
    const messages: ChatMessage[] = [
      { role: "user", content: toolResult("skill", true, "small") },
    ];
    const result = pruneToolResults(messages, { toolResultsDir: dir });
    expect(result.pruned).toBe(false);
    expect(result.messages).toEqual(messages);
  });

  test("multiple tool results in one message are persisted when oversized", () => {
    const dir = tempToolResultsDir();
    const a = toolResult("read_file", true, "3 lines", "a".repeat(100));
    const b = toolResult("list_dir", true, "2 items", "b".repeat(100));
    const messages: ChatMessage[] = [{ role: "user", content: `${a}\n\n${b}` }];
    const result = pruneToolResults(messages, {
      toolResultsDir: dir,
      maxToolOutputBytes: 50,
    });
    expect(result.pruned).toBe(true);
    expect(result.messages[0]?.content).toContain(PERSISTED_OUTPUT_OPEN);
    expect(fs.readdirSync(dir).length).toBe(2);
  });

  test("idempotent when already persisted", () => {
    const dir = tempToolResultsDir();
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: toolResult("read_file", true, "big", "z".repeat(60_000)),
      },
    ];
    const first = pruneToolResults(messages, { toolResultsDir: dir });
    expect(first.pruned).toBe(true);
    const second = pruneToolResults(first.messages, { toolResultsDir: dir });
    expect(second.pruned).toBe(false);
    expect(fs.readdirSync(dir).length).toBe(1);
  });
});
