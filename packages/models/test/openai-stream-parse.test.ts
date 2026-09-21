import { describe, expect, test } from "bun:test";

import { parseOpenAiChatCompletionStreamDataPayload } from "../src/openai-stream-parse.js";

/**
 * 终结标记的形状是 `openai-compatible.ts` 里若干守卫的前提。
 *
 * 尾部 flush 路径用 `if (!part.isDoneMarker)` 逐个分支重测（循环内那条路径改用
 * `continue` 短路）。这些判断全都建立在「`[DONE]` 不携带任何增量」之上：如果解析器
 * 哪天开始给终结标记挂上 `toolCallDeltas`，那些守卫就从「恒真」变成真正的分支，
 * 行为会静默改变。这里把前提本身钉住。
 */
describe("OpenAI stream terminator shape", () => {
  test("[DONE] carries no deltas at all", () => {
    const part = parseOpenAiChatCompletionStreamDataPayload("[DONE]");
    expect(part.isDoneMarker).toBe(true);
    expect(part.textDelta).toBe("");
    expect(part.toolCallDeltas).toBeUndefined();
    expect(part.thinkingDelta).toBeUndefined();
    expect(part.reasoningPassbackDelta).toBeUndefined();
    expect(part.finishReason).toBeUndefined();
    expect(part.usage).toBeUndefined();
  });

  test("surrounding whitespace does not change the terminator", () => {
    // SSE 的 data 字段可能带尾随空格；判定与形状都必须一致。
    for (const raw of [" [DONE]", "[DONE] ", "\t[DONE]\n"]) {
      const part = parseOpenAiChatCompletionStreamDataPayload(raw);
      expect(part.isDoneMarker).toBe(true);
      expect(part.toolCallDeltas).toBeUndefined();
    }
  });

  test("a normal chunk is not mistaken for the terminator", () => {
    const part = parseOpenAiChatCompletionStreamDataPayload(
      JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{}" } }] } }],
      }),
    );
    expect(part.isDoneMarker).toBe(false);
    expect(part.toolCallDeltas).toHaveLength(1);
  });
});
