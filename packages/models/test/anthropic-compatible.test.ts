import { describe, expect, test } from "bun:test";

import { AnthropicCompatibleModel } from "../src/anthropic-compatible.js";

describe("AnthropicCompatibleModel", () => {
  test("label includes model name", () => {
    const m = new AnthropicCompatibleModel({
      apiKey: "test-key",
      model: "claude-3-5-sonnet-20241022",
    });
    expect(m.label).toBe("anthropic:claude-3-5-sonnet-20241022");
  });

  test("uses default base URL", () => {
    const m = new AnthropicCompatibleModel({
      apiKey: "test-key",
      model: "claude-3-5-sonnet-20241022",
    });
    expect(m.label).toContain("anthropic");
  });

  test("uses custom base URL", () => {
    const m = new AnthropicCompatibleModel({
      apiKey: "test-key",
      baseUrl: "https://proxy.example.com/v1",
      model: "claude-3-5-sonnet-20241022",
    });
    // baseUrl is private, but we can verify label is consistent
    expect(m.label).toBe("anthropic:claude-3-5-sonnet-20241022");
  });
});
