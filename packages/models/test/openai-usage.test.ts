import { describe, expect, test } from "bun:test";

import { parseOpenAiUsageJson } from "../src/openai-stream-parse.js";

describe("OpenAI-compatible usage parsing", () => {
  test("records DeepSeek cache hit and miss counters", () => {
    expect(
      parseOpenAiUsageJson({
        prompt_tokens: 10_000,
        completion_tokens: 250,
        total_tokens: 10_250,
        prompt_cache_hit_tokens: 8_192,
        prompt_cache_miss_tokens: 1_808,
      }),
    ).toEqual({
      promptTokens: 10_000,
      completionTokens: 250,
      totalTokens: 10_250,
      cachedPromptTokens: 8_192,
      cacheMissPromptTokens: 1_808,
    });
  });

  test("derives OpenAI cache misses from prompt details", () => {
    expect(
      parseOpenAiUsageJson({
        prompt_tokens: 4_096,
        completion_tokens: 32,
        prompt_tokens_details: { cached_tokens: 3_072 },
      }),
    ).toEqual({
      promptTokens: 4_096,
      completionTokens: 32,
      cachedPromptTokens: 3_072,
      cacheMissPromptTokens: 1_024,
    });
  });

  test("reconstructs prompt total when a compatible provider reports only hit and miss", () => {
    expect(
      parseOpenAiUsageJson({
        prompt_cache_hit_tokens: 640,
        prompt_cache_miss_tokens: 64,
      }),
    ).toEqual({
      promptTokens: 704,
      cachedPromptTokens: 640,
      cacheMissPromptTokens: 64,
    });
  });
});
