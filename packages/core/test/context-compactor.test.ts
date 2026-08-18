import { describe, expect, it } from "bun:test";
import {
  CONTEXT_SUMMARY_PREFIX,
  ContextCompactor,
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
      // v3 P5.2 单口径：0.8 × 0.68 × window − 10K（纯百分比）
      expect(check.thresholdTokens).toBe(
        Math.floor(200_000 * 0.68 * 0.8) - 10_000,
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

    it("v3: tail has absolute floor even when ratio budget is tiny", () => {
      const compactor = new ContextCompactor({
        protectFirstN: 2,
        tailTokenBudget: 0.01,
        tailMinMessages: 3,
        tailMinTokens: 100_000, // 只让条数保底生效
      });
      const messages = makeMessages(10, 1000);
      const boundaries = compactor.determineBoundaries(messages);
      // v3 P2.1: 绝对保底 —— 即使比例预算极小，最近 3 条消息仍保留
      expect(boundaries.tailStart).toBeLessThanOrEqual(7);
    });

    it("v3: tail ratio shrinks with context length", () => {
      const compactor = new ContextCompactor({
        protectFirstN: 2,
        tailMinMessages: 0,
        tailMinTokens: 100_000,
      });
      // 小上下文（≤16K）用默认 20%
      const small = makeMessages(10, 100);
      const smallBoundaries = compactor.determineBoundaries(small);
      expect(smallBoundaries.pinned).toBeDefined();
      expect(smallBoundaries.tailStart).toBeGreaterThan(
        smallBoundaries.headEnd,
      );
    });
  });

  describe("buildSummaryPrompt (v3 P2.3/P2.4)", () => {
    it("includes TE-style format rules for fact sections", () => {
      const compactor = new ContextCompactor();
      const prompt = compactor.buildSummaryPrompt([], null);
      expect(prompt).toContain("pipe-separated entity-operator clauses");
      expect(prompt).toContain("VERBATIM");
      expect(prompt).toContain("E108 @raised_by");
    });

    it("incremental mode includes chapter-level revision rule", () => {
      const compactor = new ContextCompactor();
      const prompt = compactor.buildSummaryPrompt([], "Previous summary text.");
      expect(prompt).toContain("REVISION RULE");
      expect(prompt).toContain("Only rewrite the sections that are affected");
      expect(prompt).toContain("Keep all unaffected sections verbatim");
    });

    it("incremental mode keeps anchor prompt", () => {
      const compactor = new ContextCompactor();
      const prompt = compactor.buildSummaryPrompt(
        [{ role: "user", content: "Hi" }],
        "Prev",
      );
      expect(prompt).toContain("## Previous Summary");
      expect(prompt).toContain("Prev");
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

    it("summarizes native call facts without exposing reasoning passback", () => {
      const compactor = new ContextCompactor();
      const messages: ChatMessage[] = [
        {
          role: "assistant",
          content:
            'checking\n{"tool":"read_file","arguments":"{\\"path\\":\\"a.ts\\"}"}\n[Tool: read_file] ok',
          nativeToolTurn: {
            schemaVersion: 1,
            protocol: "openai-compatible",
            assistantContent: "checking",
            reasoningPassback: "private provider state",
            calls: [
              {
                callId: "a",
                providerName: "read_file",
                rawArguments: '{"path":"a.ts"}',
              },
            ],
            results: [{ callId: "a", content: "[Tool: read_file] ok" }],
          },
        },
      ];

      const prompt = compactor.buildSummaryPrompt(messages, null);
      expect(prompt).toContain("read_file");
      expect(prompt).toContain("a.ts");
      expect(prompt).toContain("[Tool: read_file] ok");
      expect(prompt).not.toContain("private provider state");
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

  describe("compaction outcome accounting (three-way)", () => {
    it("disables after 3 consecutive real failures", () => {
      const compactor = new ContextCompactor();
      compactor.recordFailure("error");
      compactor.recordFailure("quality");
      expect(compactor.isDisabled).toBe(false);
      compactor.recordFailure("over_compression");
      expect(compactor.isDisabled).toBe(true);
      expect(compactor.failureReason).toBe("over_compression");
    });

    it("resets failure count on success", () => {
      const compactor = new ContextCompactor();
      compactor.recordFailure("error");
      compactor.recordFailure("error");
      compactor.recordSuccess();
      compactor.recordFailure("error");
      expect(compactor.isDisabled).toBe(false);
    });

    it("low-savings rejections never trip the circuit breaker", () => {
      const compactor = new ContextCompactor();
      compactor.recordLowSavings(100_000);
      compactor.recordLowSavings(100_000);
      compactor.recordLowSavings(100_000);
      expect(compactor.isDisabled).toBe(false);
    });

    it("does not back off after a single low-savings rejection", () => {
      const compactor = new ContextCompactor();
      compactor.recordLowSavings(100_000);
      expect(compactor.shouldBackoffForLowSavings(100_000)).toBe(false);
    });

    it("backs off after two low-savings rejections without meaningful growth", () => {
      const compactor = new ContextCompactor();
      compactor.recordLowSavings(100_000);
      compactor.recordLowSavings(105_000);
      expect(compactor.shouldBackoffForLowSavings(110_000)).toBe(true);
    });

    it("lifts backoff once history grows >=20% past last rejection", () => {
      const compactor = new ContextCompactor();
      compactor.recordLowSavings(100_000);
      compactor.recordLowSavings(100_000);
      expect(compactor.shouldBackoffForLowSavings(120_001)).toBe(false);
    });

    it("resets low-savings backoff after a successful compaction", () => {
      const compactor = new ContextCompactor();
      compactor.recordLowSavings(100_000);
      compactor.recordLowSavings(100_000);
      compactor.recordSuccess();
      expect(compactor.shouldBackoffForLowSavings(100_000)).toBe(false);
    });
  });

  describe("reset", () => {
    it("re-enables compactor after disable", () => {
      const compactor = new ContextCompactor();
      compactor.recordFailure("error");
      compactor.recordFailure("error");
      compactor.recordFailure("error");
      expect(compactor.isDisabled).toBe(true);
      compactor.reset();
      expect(compactor.isDisabled).toBe(false);
      expect(compactor.shouldBackoffForLowSavings(0)).toBe(false);
      expect(compactor.failureReason).toBe(null);
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
