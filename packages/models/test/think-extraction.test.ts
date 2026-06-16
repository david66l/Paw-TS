import { describe, expect, test } from "bun:test";

import { extractThinkBlocks } from "../src/think-extraction.js";

describe("extractThinkBlocks", () => {
  test("returns plain text unchanged", () => {
    const result = extractThinkBlocks("hello world");
    expect(result.text).toBe("hello world");
    expect(result.thinking).toBeUndefined();
  });

  test("extracts a single <think> block", () => {
    const result = extractThinkBlocks(
      "<think>step one</think>\nfinal answer",
    );
    expect(result.text).toBe("final answer");
    expect(result.thinking).toBe("step one");
  });

  test("extracts only reasoning when the whole response is a think block", () => {
    const result = extractThinkBlocks("<think>only reasoning</think>");
    expect(result.text).toBe("");
    expect(result.thinking).toBe("only reasoning");
  });

  test("handles multiple <think> blocks", () => {
    const result = extractThinkBlocks(
      "<think>first</think> text <think>second</think>",
    );
    expect(result.text).toBe("text");
    expect(result.thinking).toBe("first\n\nsecond");
  });

  test("is case-insensitive", () => {
    const result = extractThinkBlocks("<THINK>caps</THINK>answer");
    expect(result.text).toBe("answer");
    expect(result.thinking).toBe("caps");
  });

  test("ignores empty think blocks", () => {
    const result = extractThinkBlocks("<think>   </think>answer");
    expect(result.text).toBe("answer");
    expect(result.thinking).toBeUndefined();
  });
});
