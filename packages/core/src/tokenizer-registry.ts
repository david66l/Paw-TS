/**
 * P1.4 估算器注册表 + usage 回填校准层。
 * ========================================
 *
 * 日志 02 的四套口径问题的收敛方案：
 * 1. **注册表**：按模型 label 选择 tokenizer——qwen/glm → o200k_base；
 *    deepseek/openai → cl100k_base；anthropic → cl100k_base×1.1 近似；
 *    其他 → chars/4 快速估算。
 * 2. **CalibratedEstimator**：消费模型调用返回的真实 usage（costTracker
 *    已拿到），维护「估算 vs 真实」比率，几轮后误差收敛 <10%
 *    （基线：cl100k 对 DeepSeek 低估 37%）。
 * 3. **保守方向**：默认 ×1.1（宁可高估——低估→超窗灾难；高估→多压缩一次可恢复）。
 */

import type { ChatMessage } from "./context/manager.js";
import {
  ApproximateEstimator,
  FastEstimator,
  TiktokenEstimator,
  type TokenEstimator,
} from "./token-estimator.js";

/** 模型 label → tokenizer 注册表（P1.4） */
export function resolveEstimatorForModel(modelLabel: string): TokenEstimator {
  const label = modelLabel.toLowerCase();
  // Qwen / GLM / MiniMax / Yi 等中文系模型：o200k 更接近真实 tokenizer
  // （(?![a-z])：qwen2.5 / qwen3 等带版本后缀的 label 同样命中）
  if (
    /\b(qwen|glm|minimax|yi|kimi|moonshot|ernie|baichuan)(?![a-z])/.test(
      label,
    )
  ) {
    return new TiktokenEstimator("o200k_base");
  }
  // DeepSeek / OpenAI / GPT / o1/o3 / groq：cl100k 事实标准
  if (
    label.includes("deepseek") ||
    label.includes("openai") ||
    label.includes("gpt") ||
    /\bo[13]\b/.test(label) ||
    label.includes("groq")
  ) {
    return new TiktokenEstimator("cl100k_base");
  }
  // Claude / Anthropic：无公开 tokenizer，cl100k 近似（业界通用）
  if (label.includes("anthropic") || label.includes("claude")) {
    return new ApproximateEstimator();
  }
  // 其他（本地/未知模型）：零依赖快速估算
  return new FastEstimator();
}

/** 校准系数钳制范围（防单次异常样本把系数带飞） */
const CALIBRATION_MIN = 0.7;
const CALIBRATION_MAX = 1.5;
/** 保守系数：宁可高估（低估→超窗；高估→多压缩一次） */
export const CONSERVATIVE_BIAS = 1.1;

/**
 * usage 回填校准层：包装任意估算器，用真实 usage 动态修正。
 *
 * 机制：
 * - recordActual(actualTokens, messages)：模型调用后回填
 *   （actual = 真实 prompt_tokens；estimated = 基估算器对同一消息数组的估算）
 * - 校准系数 = 累计真实/累计估算（加权），钳制 [0.7, 1.5]
 * - count/countMessages 一律 × 校准系数 × 保守系数 1.1
 */
export class CalibratedEstimator implements TokenEstimator {
  private readonly base: TokenEstimator;
  private sumActual = 0;
  private sumEstimated = 0;
  private samples = 0;
  /** 当前校准系数（估算 vs 真实比率，1 = 无偏差） */
  private ratio = 1;

  constructor(base: TokenEstimator = new TiktokenEstimator()) {
    this.base = base;
  }

  /** 基估算器的裸估算（不含校准/保守系数）——用于回填比对 */
  estimateRaw(text: string): number {
    return this.base.count(text);
  }

  estimateRawMessages(messages: readonly ChatMessage[]): number {
    return this.base.countMessages(messages);
  }

  count(text: string): number {
    return Math.ceil(this.base.count(text) * this.ratio * CONSERVATIVE_BIAS);
  }

  countMessages(messages: readonly ChatMessage[]): number {
    return Math.ceil(
      this.base.countMessages(messages) * this.ratio * CONSERVATIVE_BIAS,
    );
  }

  /**
   * 回填一次真实 usage：actual = 模型返回的 prompt_tokens，
   * estimated = 同一消息数组的裸估算。
   */
  recordActual(
    actualTokens: number,
    estimatedTokens: number,
  ): void {
    if (!Number.isFinite(actualTokens) || actualTokens <= 0) return;
    if (!Number.isFinite(estimatedTokens) || estimatedTokens <= 0) return;
    this.sumActual += actualTokens;
    this.sumEstimated += estimatedTokens;
    this.samples += 1;
    const r = this.sumActual / this.sumEstimated;
    this.ratio = Math.min(
      CALIBRATION_MAX,
      Math.max(CALIBRATION_MIN, r),
    );
  }

  /** 当前校准系数 */
  get calibrationRatio(): number {
    return this.ratio;
  }

  /** 回填样本数 */
  get sampleCount(): number {
    return this.samples;
  }
}
