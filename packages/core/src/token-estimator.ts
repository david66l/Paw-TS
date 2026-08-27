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
 * Count every field that can materially enter a provider request.
 *
 * `message.content` already carries `nativeToolTurn.assistantContent`, so the
 * latter is deliberately not counted a second time. Audit-only thinking is
 * retained for legacy callers; Paw Next strips it before request assembly.
 */
function countMessageRequestFields(
  message: ChatMessage,
  count: (text: string) => number,
): number {
  let tokens = count(message.content);
  if (message.thinking) tokens += count(message.thinking);

  const nativeTurn = message.nativeToolTurn;
  if (nativeTurn) {
    if (nativeTurn.reasoningPassback) {
      tokens += count(nativeTurn.reasoningPassback);
    }
    for (const call of nativeTurn.calls) {
      tokens += count(call.callId);
      tokens += count(call.providerName);
      tokens += count(call.rawArguments);
    }
    for (const result of nativeTurn.results) {
      tokens += count(result.callId);
      tokens += count(result.content);
      if ("status" in result) {
        tokens += count(result.status);
        tokens += count(result.isError ? "true" : "false");
      }
    }
  } else if (message.reasoningPassback) {
    tokens += count(message.reasoningPassback);
  }

  if (message.attachments) {
    for (const attachment of message.attachments) {
      tokens += count(attachment.name);
      if (attachment.mimeType) tokens += count(attachment.mimeType);
      if (attachment.type === "image") {
        tokens += IMAGE_TOKEN_ESTIMATE;
      } else {
        tokens += count(attachment.content);
      }
    }
  }
  return tokens;
}

/**
 * 全局共享 encoding 的单例缓存
 *
 * tiktoken 的 get_encoding("cl100k_base") 会加载 WASM 模块（~5MB），
 * 多次调用会造成严重的内存浪费。用单例模式保证整个进程只有一个实例。
 *
 * e2e 实测修复：o200k_base 的 merges 表大，首次 get_encoding 加载 ~20s——
 * 构造时不加载（懒加载），并提供 prewarm 供启动阶段后台预热。
 */
// 全局共享 encoding，避免每个实例重复加载 WASM（~5MB）；按 encoding 名缓存
const sharedEncodings = new Map<string, ReturnType<typeof get_encoding>>();
function getSharedEncoding(
  name: "cl100k_base" | "o200k_base" = "cl100k_base",
): ReturnType<typeof get_encoding> {
  let enc = sharedEncodings.get(name);
  if (!enc) {
    enc = get_encoding(name);
    sharedEncodings.set(name, enc);
  }
  return enc;
}

/** 后台预热指定 encoding（fire-and-forget，避免首次调用卡 ~20s） */
export function prewarmEncoding(name: "cl100k_base" | "o200k_base"): void {
  if (sharedEncodings.has(name)) return;
  // 后台触发加载；加载期间的同步调用会等待同一过程完成
  void Promise.resolve().then(() => {
    getSharedEncoding(name);
  });
}

/**
 * 基于 tiktoken (Rust WASM) 的精确估算器。
 *
 * 默认 cl100k_base（OpenAI/DeepSeek 事实标准）；
 * P1.4 注册表：Qwen/GLM 等用 o200k_base（tokenizer 更接近）。
 * 懒加载：构造不加载 WASM（首次 count 才加载），配合 prewarmEncoding。
 */
export class TiktokenEstimator implements TokenEstimator {
  // 懒加载：首次 count 时初始化（避免构造即触发 ~20s 的 o200k 加载）
  private enc: ReturnType<typeof get_encoding> | null = null;
  private readonly encodingName: "cl100k_base" | "o200k_base";

  constructor(encodingName: "cl100k_base" | "o200k_base" = "cl100k_base") {
    this.encodingName = encodingName;
  }

  private ensure(): ReturnType<typeof get_encoding> {
    this.enc ??= getSharedEncoding(this.encodingName);
    return this.enc;
  }

  count(text: string): number {
    /**
     * 大文本分块策略：
     * tiktoken WASM 在大字符串（>50KB）上存在超线性性能退化，
     * 可能导致测试超时。按 4096 字符分块编码，误差 < 1%。
     * 8192 字节以下直接编码，避免不必要的切片开销。
     */
    const enc = this.ensure();
    // tiktoken WASM has super-linear slowdown on large strings (>50K).
    // Chunking keeps it well under test timeouts while keeping error < 1%.
    if (text.length <= 8192) {
      return enc.encode(text).length;
    }
    let total = 0;
    const chunkSize = 4096;
    for (let i = 0; i < text.length; i += chunkSize) {
      total += enc.encode(text.slice(i, i + chunkSize)).length;
    }
    return total;
  }

  /**
   * 估算消息数组的 token 总数
   *
   * 每条消息计入：
   * - 4 token 的固定格式开销（消息角色标记、换行等）
   * - 消息主体文本的 token
   * - thinking 与 provider reasoning passback（如果存在）
   * - 原生工具调用的 ID、名称、原始参数和全部结果字段
   * - 附件名称、MIME 和内容；图片本体固定估算 1000 token/张
   * 最后加 2 token 作为回复 priming 开销
   */
  countMessages(messages: readonly ChatMessage[]): number {
    let tokens = 0;
    for (const msg of messages) {
      tokens += 4; // 每条消息的固定格式开销（角色标记、分隔符等）
      tokens += countMessageRequestFields(msg, (text) => this.count(text));
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
      total += countMessageRequestFields(msg, (text) => this.count(text));
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
