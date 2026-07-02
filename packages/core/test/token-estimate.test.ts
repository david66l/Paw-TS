import { describe, expect, test } from "bun:test";

import type { ChatMessage } from "../src/context/manager.js";
import {
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateTokens,
} from "../src/token-estimate.js";

describe("estimateTokens", () => {
  test("empty string is 0 tokens", () => {
    expect(estimateTokens("")).toBe(0);
  });

  test("short text rounds up", () => {
    expect(estimateTokens("hello")).toBe(2); // 5 / 4 = 1.25 → 2
  });

  test("exact multiple", () => {
    expect(estimateTokens("abcd")).toBe(1); // 4 / 4 = 1
  });

  test("long text", () => {
    const text = "a".repeat(1000);
    expect(estimateTokens(text)).toBe(250);
  });
});

describe("estimateMessageTokens", () => {
  test("simple user message", () => {
    const msg: ChatMessage = { role: "user", content: "hello world" };
    expect(estimateMessageTokens(msg)).toBe(3); // 11 / 4 = 2.75 → 3
  });

  test("assistant with thinking", () => {
    const msg: ChatMessage = {
      role: "assistant",
      content: "answer",
      thinking: "let me think",
    };
    expect(estimateMessageTokens(msg)).toBe(5); // (6 + 12) / 4 = 4.5 → 5
  });

  test("user with image attachment", () => {
    const msg: ChatMessage = {
      role: "user",
      content: "look",
      attachments: [{ type: "image", name: "pic.png", content: "base64" }],
    };
    expect(estimateMessageTokens(msg)).toBe(1001); // 4/4 + 1000 for image
  });

  test("user with file attachment", () => {
    const msg: ChatMessage = {
      role: "user",
      content: "read",
      attachments: [{ type: "file", name: "doc.txt", content: "hello world" }],
    };
    // content: "read" = 4 chars → 1 token
    // attachment content: "hello world" = 11 chars → 3 tokens
    // total = 1 + 3 = 4
    expect(estimateMessageTokens(msg)).toBe(4);
  });
});

describe("estimateMessagesTokens", () => {
  test("sums multiple messages", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" },
    ];
    // sys: 3/4=1, hello: 5/4=2, world: 5/4=2 → total 5
    expect(estimateMessagesTokens(messages)).toBe(5);
  });

  test("empty array is 0", () => {
    expect(estimateMessagesTokens([])).toBe(0);
  });
});
