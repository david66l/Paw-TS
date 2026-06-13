import { describe, expect, it } from "bun:test";

import {
  formatConversationForMemoryExtraction,
  shouldAttemptMemoryExtraction,
} from "../src/format-conversation-for-memory.js";

describe("formatConversationForMemoryExtraction", () => {
  it("skips system messages and formats user/assistant turns", () => {
    const text = formatConversationForMemoryExtraction([
      { role: "system", content: "tool catalog..." },
      { role: "user", content: "Fix the parser" },
      { role: "assistant", content: "I'll read the file first." },
    ]);
    expect(text).not.toContain("tool catalog");
    expect(text).toContain("[User]\nFix the parser");
    expect(text).toContain("[Assistant]\nI'll read the file first.");
  });
});

describe("shouldAttemptMemoryExtraction", () => {
  it("requires at least two non-system messages", () => {
    expect(
      shouldAttemptMemoryExtraction([
        { role: "system", content: "sys" },
        { role: "user", content: "only goal" },
      ]),
    ).toBe(false);
    expect(
      shouldAttemptMemoryExtraction([
        { role: "user", content: "goal" },
        { role: "assistant", content: "ok" },
      ]),
    ).toBe(true);
  });
});
