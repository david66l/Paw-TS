/**
 * TokenEstimator — 更准确（但非绝对精确）的 token 估算器。
 *
 * 对 OpenAI / DeepSeek 使用 js-tiktoken (cl100k_base)，准确度较高。
 * 对 Claude 使用相同 encoding 作为近似值（业界通用做法）。
 *
 * 不称 "Tokenizer" 是因为 Claude/DeepSeek/OpenAI 混用场景下，
 * 任何单一套 tokenizer 都只能算 "更准确估算"，而非绝对精确。
 */

import { get_encoding } from "tiktoken";
import type { ChatMessage } from "./context-manager.js";

export interface TokenEstimator {
  /** 估算纯文本的 token 数量。 */
  count(text: string): number;
  /** 估算消息数组的 token 数量（含消息格式开销）。 */
  countMessages(messages: readonly ChatMessage[]): number;
}

// 全局共享 encoding，避免每个实例重复加载 WASM（~5MB 内存）
let sharedEncoding: ReturnType<typeof get_encoding> | null = null;
function getSharedEncoding(): ReturnType<typeof get_encoding> {
  if (!sharedEncoding) {
    sharedEncoding = get_encoding("cl100k_base");
  }
  return sharedEncoding;
}

/** 基于 tiktoken (Rust WASM) cl100k_base 的估算器。 */
export class TiktokenEstimator implements TokenEstimator {
  private enc = getSharedEncoding();

  count(text: string): number {
    // tiktoken WASM has super-linear slowdown on large strings (>50K).
    // Chunking keeps it well under test timeouts while keeping error < 1%.
    if (text.length <= 8192) {
      return this.enc.encode(text).length;
    }
    let total = 0;
    const chunkSize = 4096;
    for (let i = 0; i < text.length; i += chunkSize) {
      total += this.enc.encode(text.slice(i, i + chunkSize)).length;
    }
    return total;
  }

  countMessages(messages: readonly ChatMessage[]): number {
    let tokens = 0;
    for (const msg of messages) {
      tokens += 4; // 每条消息固定开销
      tokens += this.count(msg.content);
      if (msg.thinking) {
        tokens += this.count(msg.thinking);
      }
      if (msg.attachments) {
        for (const att of msg.attachments) {
          if (att.type === "image") {
            tokens += 1_000;
          } else {
            tokens += this.count(att.content);
          }
        }
      }
    }
    tokens += 2; // 回复 priming
    return tokens;
  }
}

/**
 * Claude 无公开 tokenizer，用 cl100k_base 近似（业界通用做法）。
 * 命名明确为 "Approximate"，避免过度承诺精确度。
 */
export class ApproximateEstimator extends TiktokenEstimator {}
