/**
 * SSE 行缓冲：把累积的缓冲切成完整的 `data:` 载荷。
 * ==================================================
 *
 * 同一段"按 `\n` 切分 → 不完整的尾巴留回缓冲 → 逐行去掉 `\r` 与两侧空白 →
 * 取 `data: ` 之后的载荷"此前在 `openai-compatible.ts` 与
 * `anthropic-compatible.ts` 的读循环里各写了一遍（docs/CODE-REVIEW.md §A5/#29）。
 *
 * 抽出来的**只是纯字符串处理**：两个调用点各自的载荷解析
 * （`parseOpenAiChatCompletionStreamDataPayload` / `parseAnthropicStreamPayload`）
 * 与发射路径（`emitModelObservation` / `yield chunk`）都不动，所以这次抽取
 * 不触碰流式状态机。
 *
 * 注：两个文件里原本各还有一段"收尾冲刷残留缓冲"的代码，本轮之前已确认
 * **不可达**并删除（§11.39）—— 循环唯一的正常出口 `if (done) break;` 之前一行
 * 已经把缓冲置空。所以这里只需要服务读循环那一处。
 */

export interface SseDataBatch {
  /** 本批完整的 `data: ` 载荷（已去掉前缀与行尾 `\r`）。 */
  readonly payloads: readonly string[];
  /** 尚未成行的尾巴，留到下一批与新的字节一起处理。 */
  readonly carry: string;
}

/**
 * 从累积缓冲里取出本批可用的 `data:` 载荷，并返回需要保留的尾巴。
 *
 * `done` 为真表示流已结束：此时不留尾巴，最后一行（哪怕没有换行结尾）也要处理。
 * 非 `data: ` 开头的行（空行、`event:`、`id:`、注释）一律跳过 —— 与改动前一致。
 */
export function takeSseDataPayloads(buffer: string, done: boolean): SseDataBatch {
  const lines = buffer.split("\n");
  const carry = done ? "" : (lines.pop() ?? "");
  const payloads: string[] = [];
  for (const line of lines) {
    const trimmed = line.replace(/\r$/, "").trim();
    if (!trimmed.startsWith("data: ")) continue;
    payloads.push(trimmed.slice(6));
  }
  return { payloads, carry };
}
