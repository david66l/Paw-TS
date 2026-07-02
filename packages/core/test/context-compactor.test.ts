import { describe, expect, it } from "bun:test";
import {
  CONTEXT_SUMMARY_PREFIX,
  ContextCompactor,
  DEFAULT_COMPACTOR_CONFIG,
  stripContextSummaryMessages,
} from "../src/context/compactor.js";
import type { ChatMessage } from "../src/context/manager.js";

function makeMessages(count: number, contentLength = 100): ChatMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: "x".repeat(contentLength),
  }));
}

describe("ContextCompactor", () => {
  describe("check", () => {
    it("returns shouldCompact=false when under threshold", () => {
      const compactor = new ContextCompactor();
      const messages = makeMessages(5, 100);
      const check = compactor.check(messages, 200_000);
      expect(check.shouldCompact).toBe(false);
      expect(check.currentTokens).toBeGreaterThan(0);
      expect(check.thresholdTokens).toBe(
        Math.floor(
          200_000 * DEFAULT_COMPACTOR_CONFIG.thresholdRatio -
            DEFAULT_COMPACTOR_CONFIG.bufferTokens,
        ),
      );
    });

    it("returns shouldCompact=true when over threshold", () => {
      const compactor = new ContextCompactor();
      const messages = makeMessages(50, 5_000);
      const check = compactor.check(messages, 50_000);
      expect(check.shouldCompact).toBe(true);
    });

    it("returns shouldCompact=false when disabled", () => {
      const compactor = new ContextCompactor();
      // @ts-expect-error — accessing private field for testing
      compactor.disabled = true; // simulate circuit breaker
      const messages = makeMessages(50, 5_000);
      const check = compactor.check(messages, 50_000);
      expect(check.shouldCompact).toBe(false);
    });
  });

  describe("determineBoundaries", () => {
    it("protects first N messages as head", () => {
      const compactor = new ContextCompactor({ protectFirstN: 2 });
      const messages = makeMessages(10, 1000);
      const boundaries = compactor.determineBoundaries(messages);
      expect(boundaries.headEnd).toBe(1);
    });

    it("protects tail messages within budget", () => {
      const compactor = new ContextCompactor({
        protectFirstN: 2,
        tailTokenBudget: 0.2,
      });
      const messages = makeMessages(10, 1000);
      const boundaries = compactor.determineBoundaries(messages);
      expect(boundaries.tailStart).toBeLessThan(10);
      expect(boundaries.tailStart).toBeGreaterThan(boundaries.headEnd);
    });

    it("allows empty tail when budget is too small", () => {
      const compactor = new ContextCompactor({
        protectFirstN: 2,
        tailTokenBudget: 0.01,
      });
      const messages = makeMessages(10, 1000);
      const boundaries = compactor.determineBoundaries(messages);
      // Each message is ~250 tokens; tail budget is ~25 tokens, so no tail fits
      expect(boundaries.tailStart).toBe(messages.length);
    });
  });

  describe("buildSummaryPrompt", () => {
    it("includes conversation text", () => {
      const compactor = new ContextCompactor();
      const messages: ChatMessage[] = [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there" },
      ];
      const prompt = compactor.buildSummaryPrompt(messages, null);
      expect(prompt).toContain("[User]");
      expect(prompt).toContain("Hello");
      expect(prompt).toContain("[Assistant]");
      expect(prompt).toContain("Hi there");
    });

    it("includes previous summary when provided", () => {
      const compactor = new ContextCompactor();
      const messages: ChatMessage[] = [{ role: "user", content: "Hello" }];
      const prompt = compactor.buildSummaryPrompt(messages, "Previous context");
      expect(prompt).toContain("Previous Summary");
      expect(prompt).toContain("Previous context");
    });

    it("includes all required sections", () => {
      const compactor = new ContextCompactor();
      const prompt = compactor.buildSummaryPrompt([], null);
      expect(prompt).toContain("Active Task");
      expect(prompt).toContain("Goal");
      expect(prompt).toContain("Progress");
      expect(prompt).toContain("Key Decisions");
      expect(prompt).toContain("Relevant Files");
      expect(prompt).toContain("Errors & Fixes");
      expect(prompt).toContain("Next Steps");
      expect(prompt).toContain("Pending Questions");
    });
  });

  describe("recordResult", () => {
    it("tracks consecutive failures", () => {
      const compactor = new ContextCompactor();
      compactor.recordResult(100, 100, false);
      compactor.recordResult(100, 100, false);
      compactor.recordResult(100, 100, false);
      expect(compactor.isDisabled).toBe(true);
    });

    it("resets failures on success", () => {
      const compactor = new ContextCompactor();
      compactor.recordResult(100, 100, false);
      compactor.recordResult(100, 100, false);
      compactor.recordResult(100, 50, true);
      expect(compactor.isDisabled).toBe(false);
    });

    it("tracks savings ratio", () => {
      const compactor = new ContextCompactor();
      compactor.recordResult(100, 50, true);
      expect(compactor.shouldSkipDueToThrashing()).toBe(false);
    });

    it("does not skip after a single low-savings run", () => {
      const compactor = new ContextCompactor();
      compactor.recordResult(100, 90, true);
      expect(compactor.shouldSkipDueToThrashing()).toBe(false);
    });

    it("skips after two consecutive low-savings runs", () => {
      const compactor = new ContextCompactor();
      compactor.recordResult(100, 90, true);
      compactor.recordResult(100, 90, true);
      expect(compactor.shouldSkipDueToThrashing()).toBe(true);
    });

    it("resets low-savings streak after useful compaction", () => {
      const compactor = new ContextCompactor();
      compactor.recordResult(100, 90, true);
      compactor.recordResult(100, 50, true);
      compactor.recordResult(100, 90, true);
      expect(compactor.shouldSkipDueToThrashing()).toBe(false);
    });
  });

  describe("reset", () => {
    it("re-enables compactor after disable", () => {
      const compactor = new ContextCompactor();
      compactor.recordResult(100, 100, false);
      compactor.recordResult(100, 100, false);
      compactor.recordResult(100, 100, false);
      expect(compactor.isDisabled).toBe(true);
      compactor.reset();
      expect(compactor.isDisabled).toBe(false);
      expect(compactor.shouldSkipDueToThrashing()).toBe(false);
    });
  });

  describe("context summary helpers", () => {
    it("strips prior context summary messages", () => {
      const messages: ChatMessage[] = [
        { role: "user", content: "goal" },
        {
          role: "user",
          content: `${CONTEXT_SUMMARY_PREFIX}\nold summary`,
        },
        { role: "assistant", content: "reply" },
      ];
      const stripped = stripContextSummaryMessages(messages);
      expect(stripped).toHaveLength(2);
      expect(stripped[0]?.content).toBe("goal");
    });
  });
});
