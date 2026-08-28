import { describe, expect, test } from "bun:test";

import { buildAmbMemoryLlmReplayCacheKeyV1 } from "./memory-llm-replay-cache.js";

describe("memory LLM replay cache", () => {
  const request = {
    purpose: "query-plan",
    model: "deepseek-v4-flash",
    baseUrl: "https://api.deepseek.com",
    promptHash: "a".repeat(64),
    maxTokens: 4_096,
  } as const;

  test("is stable for an identical raw request", () => {
    expect(buildAmbMemoryLlmReplayCacheKeyV1(request)).toBe(
      buildAmbMemoryLlmReplayCacheKeyV1({ ...request }),
    );
  });

  test("separates purposes and request parameters", () => {
    const baseline = buildAmbMemoryLlmReplayCacheKeyV1(request);
    expect(
      buildAmbMemoryLlmReplayCacheKeyV1({
        ...request,
        purpose: "evidence-support",
      }),
    ).not.toBe(baseline);
    expect(
      buildAmbMemoryLlmReplayCacheKeyV1({ ...request, maxTokens: 2_048 }),
    ).not.toBe(baseline);
  });
});
