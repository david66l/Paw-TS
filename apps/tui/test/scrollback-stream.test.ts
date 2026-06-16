import { describe, expect, test } from "bun:test";

import { stripAssistantTextForScrollback } from "../src/scrollback-text.js";

describe("stripAssistantTextForScrollback", () => {
  test("优先使用 final_answer 的 summary 而不是原始 JSON", () => {
    const raw =
      '{"action":"final_answer","summary":"## Hello\n\nWorld with **bold**."}';
    expect(stripAssistantTextForScrollback(raw)).toBe(
      "## Hello\n\nWorld with **bold**.",
    );
  });

  test("去掉工具调用 JSON 并保留普通文本", () => {
    const raw =
      'Intro text.\n{"tool":"workspace.brief","args":{"path":"."}}\nMore text.';
    expect(stripAssistantTextForScrollback(raw)).toBe(
      "Intro text.\n\nMore text.",
    );
  });

  test("移除 thinking 标签", () => {
    expect(
      stripAssistantTextForScrollback(
        "<thinking>internal</thinking>\nVisible answer.",
      ),
    ).toBe("Visible answer.");
  });
});
