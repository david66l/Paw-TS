import { describe, expect, it } from "bun:test";
import type { ChatMessage } from "../src/context-manager.js";
import {
  ApproximateEstimator,
  TiktokenEstimator,
} from "../src/token-estimator.js";

describe("TiktokenEstimator", () => {
  const estimator = new TiktokenEstimator();

  it("counts English text accurately", () => {
    // "hello world" is 2 tokens in cl100k_base
    expect(estimator.count("hello world")).toBeGreaterThanOrEqual(2);
    expect(estimator.count("hello world")).toBeLessThanOrEqual(3);
  });

  it("counts Chinese text (approximate)", () => {
    // Chinese characters are ~1-2 tokens each in cl100k_base
    const count = estimator.count("你好世界");
    expect(count).toBeGreaterThanOrEqual(3);
    expect(count).toBeLessThanOrEqual(8);
  });

  it("counts empty string as 0", () => {
    expect(estimator.count("")).toBe(0);
  });

  it("counts messages with format overhead", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Hello!" },
    ];
    const tokens = estimator.countMessages(messages);
    // 2 messages * 4 overhead + content tokens + 2 priming
    expect(tokens).toBeGreaterThan(10);
  });

  it("counts thinking content", () => {
    const messages: ChatMessage[] = [
      { role: "assistant", content: "Hi", thinking: "Let me think..." },
    ];
    const tokens = estimator.countMessages(messages);
    expect(tokens).toBeGreaterThanOrEqual(4 + 1 + 4 + 2); // overhead + hi + thinking + priming
  });

  it("counts image attachments as 1000 tokens each", () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: "What is this?",
        attachments: [
          { type: "image", name: "img.png", content: "base64data" },
        ],
      },
    ];
    const tokens = estimator.countMessages(messages);
    expect(tokens).toBeGreaterThanOrEqual(4 + 4 + 1000 + 2); // overhead + content + image + priming
  });
});

describe("ApproximateEstimator", () => {
  it("extends TiktokenEstimator", () => {
    const est = new ApproximateEstimator();
    expect(est.count("test")).toBeGreaterThan(0);
  });
});
