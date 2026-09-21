import { describe, expect, test } from "bun:test";

import { takeSseDataPayloads } from "../src/sse.js";

/**
 * `takeSseDataPayloads` 是从 `openai-compatible.ts` 与 `anthropic-compatible.ts`
 * 的读循环里抽出来的同一段逻辑（docs/CODE-REVIEW.md §A5 / #29）。
 *
 * 它是纯函数，所以这里钉的是**行处理的边界条件**——这些正是抽取时最容易走样的
 * 地方：不完整的尾巴、CRLF、`done` 时没有换行结尾的最后一行、以及非 `data:` 行。
 */
describe("takeSseDataPayloads", () => {
  test("splits complete data lines and keeps the partial tail as carry", () => {
    const { payloads, carry } = takeSseDataPayloads('data: {"a":1}\ndata: {"b"', false);
    expect(payloads).toEqual(['{"a":1}']);
    expect(carry).toBe('data: {"b"');
  });

  test("when done, nothing is carried and a last line without a newline is still processed", () => {
    const { payloads, carry } = takeSseDataPayloads('data: {"a":1}\ndata: [DONE]', true);
    expect(payloads).toEqual(['{"a":1}', "[DONE]"]);
    expect(carry).toBe("");
  });

  test("strips a trailing carriage return before matching", () => {
    const { payloads } = takeSseDataPayloads('data: {"a":1}\r\ndata: {"b":2}\r\n', true);
    expect(payloads).toEqual(['{"a":1}', '{"b":2}']);
  });

  test("skips lines that are not data lines", () => {
    const { payloads } = takeSseDataPayloads(
      'event: message_start\ndata: {"a":1}\n\n: comment\ndata: {"b":2}\n',
      true,
    );
    expect(payloads).toEqual(['{"a":1}', '{"b":2}']);
  });

  /**
   * 只认 `"data: "`（带空格）。SSE 规范允许省略空格，但**改动前的行为就是不认**，
   * 抽取必须原样保留 —— 这条用例防止有人"顺手修正"成更宽松的匹配而改变线上行为。
   */
  test("requires the space after the colon, as the code did before extraction", () => {
    const { payloads } = takeSseDataPayloads("data:no-space\n", true);
    expect(payloads).toEqual([]);
  });

  test("an empty buffer yields nothing", () => {
    expect(takeSseDataPayloads("", false)).toEqual({ payloads: [], carry: "" });
    expect(takeSseDataPayloads("", true)).toEqual({ payloads: [], carry: "" });
  });

  test("leading and trailing whitespace around a data line is tolerated", () => {
    const { payloads } = takeSseDataPayloads('   data: {"a":1}   \n', true);
    expect(payloads).toEqual(['{"a":1}']);
  });
});
