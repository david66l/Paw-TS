import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ContextManager } from "../src/context/manager.js";

describe("ContextManager", () => {
  test("builds messages with system and user", () => {
    const cm = new ContextManager();
    cm.setSystem("You are a helpful assistant.");
    cm.addUser("Hello");
    const msgs = cm.buildMessages();
    expect(msgs.length).toBe(2);
    expect(msgs[0]?.role).toBe("system");
    expect(msgs[0]?.content).toBe("You are a helpful assistant.");
    expect(msgs[1]?.role).toBe("user");
    expect(msgs[1]?.content).toBe("Hello");
  });

  test("adds assistant and tool result", () => {
    const cm = new ContextManager();
    cm.setSystem("Sys");
    cm.addUser("Goal");
    cm.addAssistant("I will help.");
    cm.addToolResult("read_file", true, "3 lines", { lines: 3 });
    const msgs = cm.buildMessages();
    expect(msgs.length).toBe(4);
    expect(msgs[2]?.role).toBe("assistant");
    expect(msgs[3]?.role).toBe("user");
    expect(msgs[3]?.content).toContain("read_file");
  });

  test("upserts user message by prefix", () => {
    const cm = new ContextManager();
    cm.addUser("[Context Package]\none");
    cm.addAssistant("ok");
    cm.upsertUserByPrefix("[Context Package]", "[Context Package]\ntwo");
    const packages = cm
      .buildMessages()
      .filter((m) => m.content.startsWith("[Context Package]"));
    expect(packages).toHaveLength(1);
    expect(packages[0]?.content).toContain("two");
  });

  test("truncates by maxMessages", () => {
    const cm = new ContextManager({ maxMessages: 3 });
    cm.setSystem("Sys");
    cm.addUser("A");
    cm.addAssistant("B");
    cm.addUser("C");
    cm.addAssistant("D");
    cm.addUser("E");
    const msgs = cm.buildMessages();
    // system + 3 most recent
    expect(msgs.length).toBe(4);
    expect(msgs[1]?.content).toBe("C");
    expect(msgs[2]?.content).toBe("D");
    expect(msgs[3]?.content).toBe("E");
  });

  test("maxMessages preserves explicit user constraints", () => {
    const cm = new ContextManager({ maxMessages: 4 });
    cm.addUser("只能修改当前目录，不要动外部文件");
    cm.addAssistant("Ack");
    cm.addUser("Step 1");
    cm.addAssistant("Result 1");
    cm.addUser("Step 2");
    cm.addAssistant("Result 2");
    const contents = cm.buildMessages().map((m) => m.content);
    expect(contents).toContain("只能修改当前目录，不要动外部文件");
    expect(contents).toContain("Result 2");
  });

  test("truncates by maxChars", () => {
    const cm = new ContextManager({ maxChars: 50 });
    cm.setSystem("Sys");
    cm.addUser("A".repeat(30));
    cm.addAssistant("B".repeat(30));
    const msgs = cm.buildMessages();
    // system + at least one message, but total under 50 chars
    // After truncation, should keep system + last message if it fits
    const totalChars = msgs.reduce((acc, m) => acc + m.content.length, 0);
    expect(totalChars).toBeLessThanOrEqual(50 + 10); // small buffer for system
  });

  test("replaceHistory replaces all", () => {
    const cm = new ContextManager();
    cm.setSystem("Old");
    cm.addUser("X");
    cm.replaceHistory([
      { role: "system", content: "New" },
      { role: "user", content: "Y" },
      { role: "assistant", content: "Z" },
    ]);
    const msgs = cm.buildMessages();
    expect(msgs.length).toBe(3);
    expect(msgs[0]?.content).toBe("New");
    expect(msgs[1]?.content).toBe("Y");
  });

  test("counts length and chars", () => {
    const cm = new ContextManager();
    cm.setSystem("Sys");
    cm.addUser("Hello");
    cm.addAssistant("World");
    expect(cm.length).toBe(2);
    expect(cm.charCount).toBe("Sys".length + "Hello".length + "World".length);
  });

  test("addUser with attachments", () => {
    const cm = new ContextManager();
    cm.addUser("look at this", [
      {
        type: "image",
        name: "photo.png",
        content: "base64...",
        mimeType: "image/png",
      },
    ]);
    const msgs = cm.buildMessages();
    expect(msgs[0]?.attachments?.length).toBe(1);
    expect(msgs[0]?.attachments?.[0]?.name).toBe("photo.png");
  });

  test("addAssistant with thinking", () => {
    const cm = new ContextManager();
    cm.addAssistant("The answer is 42", "Let me calculate...");
    const msgs = cm.buildMessages();
    expect(msgs[0]?.thinking).toBe("Let me calculate...");
  });

  test("truncation by char count includes thinking", () => {
    const cm = new ContextManager({ maxMessages: 100, maxChars: 20 });
    cm.setSystem("sys");
    cm.addAssistant("hi", "long thinking text");
    const msgs = cm.buildMessages();
    // sys (3) + hi (2) + thinking (18) = 23 > 20, but we keep at least 1 history msg
    expect(msgs.length).toBe(2);
    expect(cm.charCount).toBeGreaterThan(20);
  });

  test("addToolResults combines multiple results into one user message", () => {
    const cm = new ContextManager();
    cm.setSystem("Sys");
    cm.addUser("Goal");
    cm.addToolResults([
      { tool: "read_file", ok: true, summary: "3 lines" },
      { tool: "list_dir", ok: true, summary: "2 items" },
    ]);
    const msgs = cm.buildMessages();
    expect(msgs.length).toBe(3);
    expect(msgs[2]?.role).toBe("user");
    expect(msgs[2]?.content).toContain("read_file");
    expect(msgs[2]?.content).toContain("list_dir");
    expect(msgs[2]?.content).toContain("3 lines");
    expect(msgs[2]?.content).toContain("2 items");
  });

  test("estimatedTokens counts all messages", () => {
    const cm = new ContextManager();
    cm.setSystem("sys");
    cm.addUser("hello");
    cm.addAssistant("world");
    // TiktokenEstimator counts message-format overhead (4 per msg + 2 priming)
    // so total is higher than the old length/4 heuristic.
    expect(cm.estimatedTokens).toBeGreaterThan(0);
  });

  test("prune compacts old tool results", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-cm-prune-"));
    const cm = new ContextManager();
    cm.setSystem("sys");
    cm.addUser("goal");
    cm.addAssistant("ok");
    for (let i = 0; i < 8; i++) {
      cm.addToolResult("read_file", true, `file${i}`, {
        content: "x".repeat(5000),
      });
    }
    const before = cm.estimatedTokens;
    const result = cm.prune({ toolResultsDir: dir, keepRecentTools: 3 });
    expect(result.pruned).toBe(true);
    expect(result.freedTokens).toBeGreaterThan(0);
    expect(cm.estimatedTokens).toBeLessThan(before);
    rmSync(dir, { recursive: true });
  });

  test("prune returns false when nothing to prune", () => {
    const cm = new ContextManager();
    cm.setSystem("sys");
    cm.addUser("hello");
    const result = cm.prune();
    expect(result.pruned).toBe(false);
    expect(result.freedTokens).toBe(0);
  });

  test("truncates by maxTokens when configured", () => {
    // TiktokenEstimator includes 4 tokens overhead per message + 2 priming,
    // so maxTokens needs to account for message-format overhead.
    const cm = new ContextManager({ maxTokens: 25 });
    cm.setSystem("sys");
    cm.addUser("hello world");
    cm.addAssistant("how are you today");
    // Total ~21 tokens (with overhead), under 25
    cm.addUser("fine thanks");
    // Total ~27 tokens, exceeds 25 → triggers truncation
    const msgs = cm.buildMessages();
    // Should drop oldest non-system message to get under 25
    expect(msgs.length).toBeLessThan(4);
    expect(cm.estimatedTokens).toBeLessThanOrEqual(25);
  });

  test("maxTokens takes priority over maxChars", () => {
    const cm = new ContextManager({ maxChars: 10, maxTokens: 1000 });
    cm.setSystem("s");
    cm.addUser("a".repeat(100)); // 25 tokens, well under 1000
    const msgs = cm.buildMessages();
    // maxTokens is set, so maxChars is ignored → message kept
    expect(msgs.length).toBe(2);
  });
});
