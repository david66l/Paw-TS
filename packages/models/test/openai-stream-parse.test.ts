import { describe, expect, test } from "bun:test";

import {
  parseOpenAiChatCompletionStreamDataPayload,
  parseOpenAiUsageJson,
} from "../src/openai-stream-parse.js";

describe("parseOpenAiChatCompletionStreamDataPayload", () => {
  test("parses content delta", () => {
    const line = JSON.stringify({
      choices: [{ delta: { content: "hello" } }],
    });
    const r = parseOpenAiChatCompletionStreamDataPayload(line);
    expect(r.isDoneMarker).toBe(false);
    expect(r.textDelta).toBe("hello");
  });

  test("[DONE] marker", () => {
    const r = parseOpenAiChatCompletionStreamDataPayload("[DONE]");
    expect(r.isDoneMarker).toBe(true);
    expect(r.textDelta).toBe("");
  });

  test("usage on chunk", () => {
    const line = JSON.stringify({
      choices: [],
      usage: {
        prompt_tokens: 1,
        completion_tokens: 2,
        total_tokens: 3,
      },
    });
    const r = parseOpenAiChatCompletionStreamDataPayload(line);
    expect(r.usage).toEqual({
      promptTokens: 1,
      completionTokens: 2,
      totalTokens: 3,
    });
  });
});

describe("parseOpenAiUsageJson", () => {
  test("camelCase keys", () => {
    expect(
      parseOpenAiUsageJson({
        promptTokens: 10,
        completionTokens: 20,
        totalTokens: 30,
      }),
    ).toEqual({
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
    });
  });
});
