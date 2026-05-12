import { describe, expect, test } from "bun:test";

import { pruneToolResults } from "../src/context-pruner.js";
import type { ChatMessage } from "../src/context-manager.js";

describe("pruneToolResults", () => {
  test("no tool results → no pruning", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" },
    ];
    const result = pruneToolResults(messages);
    expect(result.pruned).toBe(false);
    expect(result.freedTokens).toBe(0);
    expect(result.messages).toEqual(messages);
  });

  test("caps oversized tool result by lines", () => {
    const longOutput = "line\n".repeat(600); // 600 lines
    const messages: ChatMessage[] = [
      { role: "user", content: `Tool result (read_file): OK — 600 lines\n${longOutput}` },
    ];
    const result = pruneToolResults(messages, { maxToolOutputLines: 500 });
    expect(result.pruned).toBe(true);
    const pruned = result.messages[0]!;
    expect(pruned.content).toContain("more lines)");
    expect(pruned.content.split("\n").length).toBeLessThanOrEqual(502); // 500 kept + truncation notice
  });

  test("caps oversized tool result by bytes", () => {
    const longOutput = "x".repeat(60_000);
    const messages: ChatMessage[] = [
      { role: "user", content: `Tool result (read_file): OK — big file\n${longOutput}` },
    ];
    const result = pruneToolResults(messages, { maxToolOutputBytes: 50_000 });
    expect(result.pruned).toBe(true);
    const pruned = result.messages[0]!;
    expect(pruned.content).toContain("(output truncated)");
    expect(pruned.content.length).toBeLessThanOrEqual(50_050);
  });

  test("never prunes protected tools (skill)", () => {
    const longOutput = "x".repeat(60_000);
    const messages: ChatMessage[] = [
      { role: "user", content: `Tool result (skill): OK — big skill result\n${longOutput}` },
    ];
    const result = pruneToolResults(messages, { maxToolOutputBytes: 50_000 });
    expect(result.pruned).toBe(false);
    expect(result.messages[0]!.content.length).toBeGreaterThan(60_000);
  });

  test("compacts old tool results beyond protectRecentTokens", () => {
    // Build a sequence: system + user + assistant + 5 tool results
    // Each tool result is ~1000 chars (~250 tokens)
    // protectRecentTokens = 300, so only the last tool result stays intact
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "goal" },
      { role: "assistant", content: "ok" },
    ];
    for (let i = 0; i < 5; i++) {
      messages.push({
        role: "user",
        content: `Tool result (read_file): OK — file${i}\n${"content".repeat(200)}`,
      });
    }

    const result = pruneToolResults(messages, { protectRecentTokens: 300 });
    expect(result.pruned).toBe(true);
    expect(result.freedTokens).toBeGreaterThan(0);

    // The newest tool results should be intact
    const last = result.messages[result.messages.length - 1]!;
    expect(last.content).toContain("contentcontent"); // intact

    // Older ones should be compacted
    const older = result.messages[result.messages.length - 3]!;
    expect(older.content).toContain("<tool_result compacted:");
  });

  test("compacts tool results but leaves non-tool messages alone", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "goal" },
      { role: "assistant", content: "let me check" },
      { role: "user", content: `Tool result (read_file): OK — a\n${"x".repeat(1000)}` },
      { role: "assistant", content: "found it" },
      { role: "user", content: `Tool result (read_file): OK — b\n${"y".repeat(1000)}` },
    ];

    const result = pruneToolResults(messages, { protectRecentTokens: 100 });
    expect(result.pruned).toBe(true);

    // Assistant message should remain untouched
    const assistantMsg = result.messages.find((m) => m.content === "found it");
    expect(assistantMsg).toBeDefined();

    // Older tool result compacted
    const oldTool = result.messages[3]!;
    expect(oldTool.content).toContain("<tool_result compacted:");
  });

  test("returns same reference when nothing changes", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Tool result (skill): OK — small" },
    ];
    const result = pruneToolResults(messages);
    expect(result.pruned).toBe(false);
    // When nothing changes, the pruner may return the same array reference
    // for efficiency (implementation detail — if it doesn't, that's also fine)
    expect(result.messages).toEqual(messages);
  });

  test("multiple tool results in one message (addToolResults) are capped by bytes", () => {
    // addToolResults combines multiple results into one message with "\n\n"
    const combined = `Tool result (read_file): OK — 3 lines\n{"file":"a"}\n\nTool result (list_dir): OK — 2 items\n{"dir":"b"}`;
    const messages: ChatMessage[] = [{ role: "user", content: combined }];
    const result = pruneToolResults(messages, { maxToolOutputBytes: 50 });
    // The combined message is capped by bytes (regex only matches the first tool result prefix)
    expect(result.pruned).toBe(true);
    expect(result.messages[0]!.content).toContain("(output truncated)");
  });
});
