/**
 * Token 估算器模块
 * ============================================
 *
 * 【模块目的】
 * 提供多精度等级（精确/近似/快速）的 token 估算能力，用于上下文窗口管理、
 * token 预算控制和 token 消费统计。不称 "Tokenizer" 是因为在多模型场景下
 * 不可能用单一 tokenizer 实现绝对精确的计数。
 *
 * 【架构定位】
 * Token 估算是 Paw.ts 上下文管理的基石。在每次模型调用前，需要知道：
 * - 当前上下文窗口已用多少 token？（预算检查）
 * - 某条消息大约多少 token？（L1 裁剪决策）
 * - 系统提示词是否超预算？（裁剪触发条件）
 *
 * 不同场景对精度和性能的要求不同：
 * - 预算检查：需要较快但不要求精确 → FastEstimator
 * - 最终 token 报告：希望接近真实值 → TiktokenEstimator / ApproximateEstimator
 * - 大文本裁剪：希望精确但可承受 WASM 开销 → TiktokenEstimator
 *
 * 【关键设计决策】
 * 1. 三层估算器（Fast / Tiktoken / Approximate）对应三种精度-性能 tradeoff。
 *    不强制全局统一，让调用方根据场景选择。
 * 2. sharedEncoding 全局单例模式：tiktoken 的 WASM 编码器体积大（~5MB），
 *    多实例会浪费内存，所以用单例共享。
 * 3. TiktokenEstimator.count 对大文本（>8192 字符）做了分块处理，
 *    因为 tiktoken WASM 在大字符串上存在超线性性能退化。
 * 4. ApproximateEstimator 继承 TiktokenEstimator 但不覆盖任何方法——
 *    它的存在纯粹是为了语义区分：告诉调用方"这是近似值，不是精确值"。
 *    用于 Claude 模型（无公开 tokenizer，业界都用 cl100k_base 近似）。
 *
 * 【各模型的 tokenizer 选择】
 * - OpenAI：cl100k_base → 精确（官方 encoding）
 * - DeepSeek：cl100k_base → 高精度（DeepSeek 使用类似 BPE）
 * - Claude：cl100k_base → 近似（Claude 无公开 tokenizer，业界通用做法）
 *   ApproximateEstimator 的命名就是提醒这不是精确值。
 */

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
import type { ChatMessage } from "./context/manager.js";

/**
 * Token 估算器接口
 *
 * 定义了所有估算器的统一合约：能算纯文本的 token，也能算消息数组的 token。
 * 消息数组的估算会额外计入每条消息的格式开销和附件 token 数。
 */
export interface TokenEstimator {
  /** 估算纯文本的 token 数量。 */
  count(text: string): number;
  /** 估算消息数组的 token 数量（含消息格式开销）。 */
  countMessages(messages: readonly ChatMessage[]): number;
}

/**
 * 全局共享 encoding 的单例缓存
 *
 * tiktoken 的 get_encoding("cl100k_base") 会加载 WASM 模块（~5MB），
 * 多次调用会造成严重的内存浪费。用单例模式保证整个进程只有一个实例。
 */
// 全局共享 encoding，避免每个实例重复加载 WASM（~5MB 内存）
let sharedEncoding: ReturnType<typeof get_encoding> | null = null;
function getSharedEncoding(): ReturnType<typeof get_encoding> {
  if (!sharedEncoding) {
    sharedEncoding = get_encoding("cl100k_base");
  }
  return sharedEncoding;
}

/**
 * 基于 tiktoken (Rust WASM) cl100k_base 的精确估算器
 *
 * 对 OpenAI 模型提供最接近真实值的 token 计数。
 * 对大文本做了分块处理以避免 WASM 的超线性性能退化。
 */
/** 基于 tiktoken (Rust WASM) cl100k_base 的估算器。 */
export class TiktokenEstimator implements TokenEstimator {
  // 使用全局共享的 encoding 实例，避免重复加载 WASM
  private enc = getSharedEncoding();

  count(text: string): number {
    /**
     * 大文本分块策略：
     * tiktoken WASM 在大字符串（>50KB）上存在超线性性能退化，
     * 可能导致测试超时。按 4096 字符分块编码，误差 < 1%。
     * 8192 字节以下直接编码，避免不必要的切片开销。
     */
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

  /**
   * 估算消息数组的 token 总数
   *
   * 每条消息计入：
   * - 4 token 的固定格式开销（消息角色标记、换行等）
   * - 消息主体文本的 token
   * - thinking 文本的 token（如果存在）
   * - 附件的 token：图片固定 1000 token/张，其他附件按文本估算
   * 最后加 2 token 作为回复 priming 开销
   */
  countMessages(messages: readonly ChatMessage[]): number {
    let tokens = 0;
    for (const msg of messages) {
      tokens += 4; // 每条消息的固定格式开销（角色标记、分隔符等）
      tokens += this.count(msg.content);
      if (msg.thinking) {
        tokens += this.count(msg.thinking);
      }
      if (msg.attachments) {
        for (const att of msg.attachments) {
          if (att.type === "image") {
            // 图片统一按 1000 token 估算（大部分模型的图片 token 定价接近此值）
            tokens += 1_000;
          } else {
            tokens += this.count(att.content);
          }
        }
      }
    }
    tokens += 2; // 回复 priming：模型开始生成前的上下文标记
    return tokens;
  }
}

/**
 * Claude 模型的近似估算器
 *
 * Claude 没有公开的 tokenizer，业界通用做法是用 cl100k_base 近似。
 * 命名明确为 "Approximate"，避免调用方误以为这是精确计数。
 * 行为与 TiktokenEstimator 完全相同，纯粹是语义上的区分。
 */
/**
 * Claude 无公开 tokenizer，用 cl100k_base 近似（业界通用做法）。
 * 命名明确为 "Approximate"，避免过度承诺精确度。
 */
export class ApproximateEstimator extends TiktokenEstimator {}

/**
 * 快速字符/4 估算常量
 *
 * 绝大多数英文文本中，平均每个 token ≈ 4 个字符。
 * 这个方法在普通文本上误差约 15-20%，但对于只需要粗略判断
 * "是否可能超预算"的场景已经完全够用。
 */
const CHARS_PER_TOKEN = 4;
/** 单张图片的 token 估算值（1000 token = 约 $0.01 级别的图片成本） */
const IMAGE_TOKEN_ESTIMATE = 1_000;

/**
 * 零依赖的快速 token 估算器
 *
 * 不加载任何 WASM，纯 CPU 计算（length / 4），适合：
 * - 预算检查（需要快速判断是否该触发裁剪）
 * - L1 裁剪决策（在正式估算前快速筛选）
 * - 启动阶段（tiktoken WASM 可能尚未初始化）
 *
 * 保留了历史版本的 `length / 4` 启发式算法，
 * 让只需要粗略 token 数的调用方不必加载 tiktoken WASM。
 */
export class FastEstimator implements TokenEstimator {
  count(text: string): number {
    // 每个 token ≈ 4 个字符的粗略估算
    return Math.ceil(text.length / CHARS_PER_TOKEN);
  }

  countMessages(messages: readonly ChatMessage[]): number {
    let total = 0;
    for (const msg of messages) {
      total += this.count(msg.content);
      if (msg.thinking) {
        total += this.count(msg.thinking);
      }
      if (msg.attachments) {
        for (const att of msg.attachments) {
          if (att.type === "image") {
            total += IMAGE_TOKEN_ESTIMATE;
          } else {
            total += this.count(att.content);
          }
        }
      }
    }
    return total;
  }
}

/**
 * 全局共享的 FastEstimator 单例
 *
 * FastEstimator 虽然没有 WASM 开销，但保留单例模式保持一致的设计风格，
 * 并为调用方提供便捷的获取方式。
 */
let sharedFastEstimator: FastEstimator | null = null;

/** 获取全局共享的 FastEstimator 实例，用于不需要精确计数的场景。 */
/** Shared fast estimator instance for callers that do not need precise counts. */
export function getSharedFastEstimator(): FastEstimator {
  if (!sharedFastEstimator) {
    sharedFastEstimator = new FastEstimator();
  }
  return sharedFastEstimator;
}
