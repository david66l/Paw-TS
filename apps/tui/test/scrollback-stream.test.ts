import { describe, expect, test } from "bun:test";

import { stripAssistantTextForScrollback } from "../src/scrollback-text.js";

describe("stripAssistantTextForScrollback", () => {
  test("uses final_answer summary instead of raw JSON", () => {
    const raw =
      '{"action":"final_answer","summary":"## Hello\\n\\nWorld with **bold**."}';
    expect(stripAssistantTextForScrollback(raw)).toBe(
      "## Hello\n\nWorld with **bold**.",
    );
  });

  test("strips tool_call JSON and keeps prose", () => {
    const raw =
      'Intro text.\n{"tool":"workspace.brief","args":{"path":"."}}\nMore text.';
    expect(stripAssistantTextForScrollback(raw)).toBe(
      "Intro text.\n\nMore text.",
    );
  });

  test("removes thinking tags", () => {
    expect(
      stripAssistantTextForScrollback(
        "<thinking>internal</thinking>\nVisible answer.",
      ),
    ).toBe("Visible answer.");
  });
});
