import { describe, expect, test } from "bun:test";

import {
  buildAnthropicUserContent,
  buildOpenAiMessageContent,
} from "../src/message-content.js";

describe("buildOpenAiMessageContent", () => {
  test("returns plain string when no attachments", () => {
    expect(
      buildOpenAiMessageContent({ role: "user", content: "hello" }),
    ).toBe("hello");
  });

  test("builds image_url parts for image attachments", () => {
    const content = buildOpenAiMessageContent({
      role: "user",
      content: "what is this?",
      attachments: [
        {
          type: "image",
          name: "shot.png",
          content: "abc123",
          mimeType: "image/png",
        },
      ],
    });
    expect(Array.isArray(content)).toBe(true);
    const parts = content as Array<{ type: string; image_url?: { url: string } }>;
    expect(parts[0]?.type).toBe("text");
    expect(parts[1]?.type).toBe("image_url");
    expect(parts[1]?.image_url?.url).toBe("data:image/png;base64,abc123");
  });

  test("inlines file attachments as text parts", () => {
    const content = buildOpenAiMessageContent({
      role: "user",
      content: "review",
      attachments: [
        { type: "file", name: "a.txt", content: "line one" },
      ],
    });
    const parts = content as Array<{ type: string; text?: string }>;
    expect(parts.some((p) => p.text?.includes("[File: a.txt]"))).toBe(true);
  });
});

describe("buildAnthropicUserContent", () => {
  test("returns plain string when no attachments", () => {
    expect(
      buildAnthropicUserContent({ role: "user", content: "hello" }),
    ).toBe("hello");
  });

  test("builds base64 image blocks", () => {
    const content = buildAnthropicUserContent({
      role: "user",
      content: "describe",
      attachments: [
        {
          type: "image",
          name: "ui.webp",
          content: "Zm9v",
          mimeType: "image/webp",
        },
      ],
    });
    expect(Array.isArray(content)).toBe(true);
    const blocks = content as Array<{
      type: string;
      source?: { media_type: string; data: string };
    }>;
    expect(blocks[1]?.type).toBe("image");
    expect(blocks[1]?.source?.media_type).toBe("image/webp");
    expect(blocks[1]?.source?.data).toBe("Zm9v");
  });
});
