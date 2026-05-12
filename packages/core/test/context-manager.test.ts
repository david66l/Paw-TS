import { describe, expect, test } from "bun:test";

import { ContextManager } from "../src/context-manager.js";

describe("ContextManager", () => {
  test("builds messages with system and user", () => {
    const cm = new ContextManager();
    cm.setSystem("You are a helpful assistant.");
    cm.addUser("Hello");
    const msgs = cm.buildMessages();
    expect(msgs.length).toBe(2);
    expect(msgs[0]!.role).toBe("system");
    expect(msgs[0]!.content).toBe("You are a helpful assistant.");
    expect(msgs[1]!.role).toBe("user");
    expect(msgs[1]!.content).toBe("Hello");
  });

  test("adds assistant and tool result", () => {
    const cm = new ContextManager();
    cm.setSystem("Sys");
    cm.addUser("Goal");
    cm.addAssistant("I will help.");
    cm.addToolResult("read_file", true, "3 lines", { lines: 3 });
    const msgs = cm.buildMessages();
    expect(msgs.length).toBe(4);
    expect(msgs[2]!.role).toBe("assistant");
    expect(msgs[3]!.role).toBe("user");
    expect(msgs[3]!.content).toContain("read_file");
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
    expect(msgs[1]!.content).toBe("C");
    expect(msgs[2]!.content).toBe("D");
    expect(msgs[3]!.content).toBe("E");
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
    expect(msgs[0]!.content).toBe("New");
    expect(msgs[1]!.content).toBe("Y");
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
      { type: "image", name: "photo.png", content: "base64...", mimeType: "image/png" },
    ]);
    const msgs = cm.buildMessages();
    expect(msgs[0]!.attachments!.length).toBe(1);
    expect(msgs[0]!.attachments![0]!.name).toBe("photo.png");
  });

  test("addAssistant with thinking", () => {
    const cm = new ContextManager();
    cm.addAssistant("The answer is 42", "Let me calculate...");
    const msgs = cm.buildMessages();
    expect(msgs[0]!.thinking).toBe("Let me calculate...");
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
    expect(msgs[2]!.role).toBe("user");
    expect(msgs[2]!.content).toContain("read_file");
    expect(msgs[2]!.content).toContain("list_dir");
    expect(msgs[2]!.content).toContain("3 lines");
    expect(msgs[2]!.content).toContain("2 items");
  });

  test("estimatedTokens counts all messages", () => {
    const cm = new ContextManager();
    cm.setSystem("sys"); // 3 chars → 1 token
    cm.addUser("hello"); // 5 chars → 2 tokens
    cm.addAssistant("world"); // 5 chars → 2 tokens
    expect(cm.estimatedTokens).toBe(5);
  });

  test("prune compacts old tool results", () => {
    const cm = new ContextManager();
    cm.setSystem("sys");
    cm.addUser("goal");
    cm.addAssistant("ok");
    for (let i = 0; i < 5; i++) {
      cm.addToolResult("read_file", true, `file${i}`, { content: "x".repeat(1000) });
    }
    const before = cm.estimatedTokens;
    const result = cm.prune({ protectRecentTokens: 300 });
    expect(result.pruned).toBe(true);
    expect(result.freedTokens).toBeGreaterThan(0);
    expect(cm.estimatedTokens).toBeLessThan(before);
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
    const cm = new ContextManager({ maxTokens: 10 });
    cm.setSystem("sys"); // 1 token
    cm.addUser("hello world"); // 3 tokens
    cm.addAssistant("how are you today"); // 5 tokens
    // Total so far: 1 + 3 + 5 = 9 tokens, under limit
    cm.addUser("fine thanks"); // 3 tokens → total 12, exceeds 10
    const msgs = cm.buildMessages();
    // Should drop oldest non-system message to get under 10
    expect(msgs.length).toBeLessThan(4);
    expect(cm.estimatedTokens).toBeLessThanOrEqual(10);
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
