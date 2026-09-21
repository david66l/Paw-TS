import { describe, expect, test } from "bun:test";
import { get_encoding } from "tiktoken";
import type { ChatMessage } from "../src/context/manager.js";
import { createBoundedTokenCounter } from "../src/token-count-cache.js";
import { TiktokenEstimator } from "../src/token-estimator.js";
import { CalibratedEstimator } from "../src/tokenizer-registry.js";

describe("bounded token counts", () => {
  test("identical text encodes once, including zero; independent encodings do not share counts", () => {
    let calls = 0;
    const count = createBoundedTokenCounter((text) => {
      calls++;
      return text.length;
    });
    expect(count("same text")).toBe(9);
    expect(count(["same", "text"].join(" "))).toBe(9);
    expect(count("")).toBe(0);
    expect(count("")).toBe(0);
    expect(calls).toBe(2);
    expect(createBoundedTokenCounter(() => 17)("same text")).toBe(17);
    expect(count("same text")).toBe(9);
  });

  test("entry cap uses LRU; character cap and oversized bypass bound retained text", () => {
    const encoded: string[] = [];
    const count = createBoundedTokenCounter(
      (text) => {
        encoded.push(text);
        return text.length;
      },
      { maxEntries: 2, maxCharacters: 6 },
    );
    count("aa");
    count("bb");
    count("aa");
    count("cc");
    count("aa");
    expect(encoded).toEqual(["aa", "bb", "cc"]);
    count("bb"); // least recently used was evicted by cc
    count("dddd"); // character cap evicts aa, retains bb
    count("bb");
    expect(encoded).toEqual(["aa", "bb", "cc", "bb", "dddd"]);
    count("oversized");
    count("oversized");
    count("bb");
    expect(encoded.slice(-3)).toEqual(["dddd", "oversized", "oversized"]);
    count("aa");
    expect(encoded.at(-1)).toBe("aa");
  });

  test("failed counts are retried instead of caching a failure", () => {
    let calls = 0;
    const count = createBoundedTokenCounter(() => {
      if (++calls === 1) throw new Error("encode failed");
      return 3;
    });
    expect(() => count("text")).toThrow("encode failed");
    expect(count("text")).toBe(3);
    expect(count("text")).toBe(3);
    expect(calls).toBe(2);
  });

  test("repeated counts preserve the existing encoding and large-text chunking", () => {
    for (const name of ["cl100k_base", "o200k_base"] as const) {
      const encoder = get_encoding(name);
      try {
        const estimator = new TiktokenEstimator(name);
        for (const text of [
          "",
          "中文与代码 const a = 1; 🐾",
          "abc 中文 🐾\n".repeat(1100),
        ]) {
          const expected =
            text.length <= 8192
              ? encoder.encode(text).length
              : Array.from(
                  { length: Math.ceil(text.length / 4096) },
                  (_, index) =>
                    encoder.encode(text.slice(index * 4096, (index + 1) * 4096))
                      .length,
                ).reduce((sum, n) => sum + n, 0);
          expect(estimator.count(text)).toBe(expected);
          expect(estimator.count(text)).toBe(expected);
        }
      } finally {
        encoder.free();
      }
    }
  });

  test("message mutations and usage calibration remain visible after a cache hit", () => {
    const estimator = new TiktokenEstimator();
    const messages: ChatMessage[] = [{ role: "user", content: "short" }];
    const before = estimator.countMessages(messages);
    messages[0] = { role: "user", content: "longer text ".repeat(80) };
    expect(estimator.countMessages(messages)).toBeGreaterThan(before);
    const calibrated = new CalibratedEstimator(estimator);
    const initial = calibrated.countMessages(messages);
    calibrated.recordActual(150, 100);
    expect(calibrated.countMessages(messages)).toBeGreaterThan(initial);
  });
});
