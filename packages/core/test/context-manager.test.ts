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

  test("upserts dynamic control state immediately before the latest message", () => {
    const cm = new ContextManager();
    cm.addUser("Goal");
    cm.upsertUserByPrefixBeforeLatest("[Status]", "[Status]\none");
    cm.addAssistant("work");
    cm.addToolResult("read_file", true, "done");
    cm.upsertUserByPrefixBeforeLatest("[Status]", "[Status]\ntwo");

    const messages = cm.buildMessages();
    expect(
      messages.filter((message) => message.content.startsWith("[Status]")),
    ).toHaveLength(1);
    expect(messages.at(-2)?.content).toBe("[Status]\ntwo");
    expect(messages.at(-1)?.content).toContain("read_file");
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
    // The soft message cap keeps the newest complete assistant-boundary unit.
    expect(msgs.length).toBe(3);
    expect(msgs[1]?.content).toBe("D");
    expect(msgs[2]?.content).toBe("E");
  });

  test("maxMessages never orphans a tool observation", () => {
    const cm = new ContextManager({ maxMessages: 1 });
    cm.addAssistant('{"tool":"workspace.read_file","args":{"path":"a.ts"}}');
    cm.addToolResult("workspace.read_file", true, "read a.ts");
    const messages = cm.buildMessages();
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe("assistant");
    expect(messages[1]?.content).toContain(
      "[Tool workspace.read_file completed]",
    );
  });

  test("maxMessages keeps the latest tool unit even beside an old constraint", () => {
    const cm = new ContextManager({ maxMessages: 1 });
    cm.setHistoryRaw([
      { role: "user", content: "只能修改当前目录，不要动外部文件" },
      {
        role: "assistant",
        content: '{"tool":"workspace.read_file","args":{"path":"a.ts"}}',
      },
      {
        role: "user",
        content: "[Tool workspace.read_file completed]\nread a.ts",
      },
    ]);
    cm.truncateNow();
    const messages = cm.buildMessages();
    expect(messages.map((message) => message.content)).toEqual([
      "只能修改当前目录，不要动外部文件",
      '{"tool":"workspace.read_file","args":{"path":"a.ts"}}',
      "[Tool workspace.read_file completed]\nread a.ts",
    ]);
  });

  test("batch truncation keeps a continuous newest whole-unit suffix", () => {
    const history = [
      { role: "user" as const, content: "A" },
      { role: "assistant" as const, content: "B" },
      { role: "user" as const, content: "C" },
      { role: "assistant" as const, content: "D" },
      { role: "user" as const, content: "E" },
    ];
    const raw = new ContextManager({ maxMessages: 3 });
    raw.setHistoryRaw(history);
    raw.truncateNow();
    expect(raw.buildMessages().map((message) => message.content)).toEqual([
      "D",
      "E",
    ]);

    const replaced = new ContextManager({ maxMessages: 3 });
    replaced.replaceHistory(history);
    expect(replaced.buildMessages().map((message) => message.content)).toEqual([
      "D",
      "E",
    ]);
  });

  test("an oversized latest tool turn soft-exceeds the character budget", () => {
    const cm = new ContextManager({ maxChars: 20 });
    cm.addAssistant('{"tool":"workspace.run_shell","args":{"command":"test"}}');
    cm.addToolResult("workspace.run_shell", false, "failed", {
      stderr: "x".repeat(200),
    });
    const messages = cm.buildMessages();
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe("assistant");
    expect(messages[1]?.content).toContain("[Tool workspace.run_shell failed]");
    expect(cm.charCount).toBeGreaterThan(20);
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

  test("soft-exceeds maxChars for the initial goal and latest whole unit", () => {
    const cm = new ContextManager({ maxChars: 50 });
    cm.setSystem("Sys");
    cm.addUser("A".repeat(30));
    cm.addAssistant("B".repeat(30));
    const msgs = cm.buildMessages();
    expect(msgs.map((message) => message.content)).toEqual([
      "Sys",
      "A".repeat(30),
      "B".repeat(30),
    ]);
    expect(cm.charCount).toBeGreaterThan(50);
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

  test("addAssistant keeps audit thinking out of request history", () => {
    const cm = new ContextManager();
    cm.addAssistant("The answer is 42", "Let me calculate...");
    const msgs = cm.buildMessages();
    expect(msgs[0]?.thinking).toBeUndefined();
  });

  test("legacy history is stripped of audit thinking before truncation", () => {
    const cm = new ContextManager({ maxMessages: 100, maxChars: 20 });
    cm.setSystem("sys");
    cm.replaceHistory([
      { role: "assistant", content: "hi", thinking: "long thinking text" },
    ]);
    const msgs = cm.buildMessages();
    expect(msgs.length).toBe(2);
    expect(msgs[1]?.thinking).toBeUndefined();
    expect(cm.charCount).toBe(5);
  });

  test("raw resume history is stripped of audit thinking", () => {
    const cm = new ContextManager();
    cm.setHistoryRaw([
      { role: "assistant", content: "legacy", thinking: "old audit" },
    ]);

    expect(cm.buildMessages()).toEqual([
      { role: "assistant", content: "legacy" },
    ]);
  });

  test("24 turns do not grow the request budget with audit thinking", () => {
    const cm = new ContextManager({ maxMessages: 100 });
    for (let turn = 0; turn < 24; turn++) {
      cm.addAssistant(`answer-${turn}`, "x".repeat(10_000));
      cm.addUser(`observation-${turn}`);
    }

    expect(cm.buildMessages().every((message) => !message.thinking)).toBe(true);
    expect(cm.charCount).toBeLessThan(1_000);
  });

  test("stores a complete native tool turn as one atomic history item", () => {
    const cm = new ContextManager({ maxMessages: 1 });
    cm.addNativeToolTurn(
      "checking",
      "reasoning passback",
      [
        {
          callId: "a",
          providerName: "read_file",
          rawArguments: '{"path":"a.ts"}',
        },
        {
          callId: "b",
          providerName: "read_file",
          rawArguments: '{"path":"b.ts"}',
        },
      ],
      [
        { callId: "a", tool: "workspace.read_file", ok: true, summary: "A" },
        { callId: "b", tool: "workspace.read_file", ok: true, summary: "B" },
      ],
    );

    const messages = cm.buildMessages();
    expect(messages).toHaveLength(1);
    expect(
      messages[0]?.nativeToolTurn?.calls.map((call) => call.callId),
    ).toEqual(["a", "b"]);
    expect(
      messages[0]?.nativeToolTurn?.results.map((result) => result.callId),
    ).toEqual(["a", "b"]);
    expect(messages[0]?.thinking).toBeUndefined();
    expect(cm.charCount).toBeGreaterThan("reasoning passback".length);
  });

  test("raw resume preserves valid native passback but drops malformed envelopes", () => {
    const valid = {
      schemaVersion: 1 as const,
      protocol: "openai-compatible" as const,
      assistantContent: "",
      reasoningPassback: "keep for native replay",
      calls: [
        {
          callId: "a",
          providerName: "read_file",
          rawArguments: "{}",
        },
      ],
      results: [{ callId: "a", content: "ok" }],
    };
    const cm = new ContextManager();
    cm.setHistoryRaw([
      {
        role: "assistant",
        content: "valid fallback",
        thinking: "drop audit",
        nativeToolTurn: valid,
      },
      {
        role: "assistant",
        content: "malformed fallback",
        nativeToolTurn: {
          ...valid,
          results: [{ callId: "wrong", content: "bad" }],
        },
      },
    ]);

    expect(cm.buildMessages()[0]?.nativeToolTurn).toEqual(valid);
    expect(cm.buildMessages()[0]?.thinking).toBeUndefined();
    expect(cm.buildMessages()[1]?.nativeToolTurn).toBeUndefined();
    expect(cm.buildMessages()[1]?.content).toBe("malformed fallback");
  });

  test("raw resume preserves a provider-neutral native turn as one message", () => {
    const valid = {
      schemaVersion: 2 as const,
      protocol: "provider-neutral" as const,
      assistantContent: "inspect",
      calls: [
        {
          callId: "a",
          providerName: "read_file",
          rawArguments: '{"path":"a.ts"}',
        },
      ],
      results: [
        {
          callId: "a",
          status: "unknown" as const,
          isError: true,
          content: "execution result was not proven",
        },
      ],
    };
    const cm = new ContextManager();
    cm.setHistoryRaw([
      {
        role: "assistant",
        content: "fallback",
        thinking: "audit only",
        nativeToolTurn: valid,
      },
    ]);

    expect(cm.buildMessages()).toEqual([
      { role: "assistant", content: "fallback", nativeToolTurn: valid },
    ]);
  });

  test("raw resume never throws on corrupt native envelope shapes", () => {
    const corruptTurns: unknown[] = [
      null,
      {},
      { schemaVersion: 1, protocol: "openai-compatible", calls: {} },
      {
        schemaVersion: 1,
        protocol: "openai-compatible",
        assistantContent: "",
        calls: [{ callId: "", providerName: "read_file", rawArguments: "{}" }],
        results: [{ callId: "", content: "bad" }],
      },
      {
        schemaVersion: 1,
        protocol: "openai-compatible",
        assistantContent: "",
        calls: [
          { callId: "a", providerName: "read_file", rawArguments: "{}" },
          { callId: "a", providerName: "read_file", rawArguments: "{}" },
        ],
        results: [
          { callId: "a", content: "one" },
          { callId: "a", content: "two" },
        ],
      },
      {
        schemaVersion: 1,
        protocol: "openai-compatible",
        assistantContent: "",
        calls: [{ callId: "a", providerName: "", rawArguments: "{}" }],
        results: [{ callId: "a", content: "bad" }],
      },
    ];
    const cm = new ContextManager();

    expect(() =>
      cm.setHistoryRaw(
        corruptTurns.map(
          (nativeToolTurn, index) =>
            ({
              role: "assistant",
              content: `fallback-${index}`,
              nativeToolTurn,
            }) as unknown as import("../src/context/manager.js").ChatMessage,
        ),
      ),
    ).not.toThrow();

    expect(cm.buildMessages()).toEqual(
      corruptTurns.map((_turn, index) => ({
        role: "assistant",
        content: `fallback-${index}`,
      })),
    );
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

  test("soft-exceeds maxTokens for the goal and latest assistant unit", () => {
    // TiktokenEstimator includes 4 tokens overhead per message + 2 priming,
    // so maxTokens needs to account for message-format overhead.
    const cm = new ContextManager({ maxTokens: 8 });
    cm.setSystem("sys");
    cm.addUser("hello world");
    cm.addAssistant("how are you today");
    cm.addUser("fine thanks");
    // The history exceeds 8 tokens. The initial goal and newest complete
    // assistant-boundary unit are both protected, so this is a soft limit.
    const msgs = cm.buildMessages();
    expect(msgs.map((message) => message.content)).toEqual([
      "sys",
      "hello world",
      "how are you today",
      "fine thanks",
    ]);
    expect(cm.historyEstimatedTokens).toBeGreaterThan(8);
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
