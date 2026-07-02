/**
 * 上下文压缩器 — L2/L3 压缩。
 * ==========================
 *
 * 决定何时压缩、保护 head/tail 边界、为压缩 Agent 构建提示词。
 *
 * 三段式压缩策略：
 * - Head：前 protectFirstN 条消息（始终逐字保留）——通常是初始 goal + 第一条回复
 * - Tail：末尾的消息，累积 token 不超过 tailTokenBudget ——最近上下文对连续性至关重要
 * - Middle：head 和 tail 之间的所有消息 —— 被压缩 Agent 总结为 markdown
 *
 * 防 thrashing（反复压缩但收益低）：
 * - 连续 2 次压缩节省 < 15% → 跳过后续压缩
 * - 连续 3 次压缩失败 → 禁用自动压缩
 *
 * 面试要点：
 * - 为什么需要三段式？完全保留 head 的初始意图 + tail 的最近上下文，
 *   只压缩中间"已经处理过的"部分
 */

import type { ChatMessage } from "./manager.js";
import {
  ApproximateEstimator,
  type TokenEstimator,
} from "../token-estimator.js";

export interface CompactorConfig {
  /** 触发压缩的上下文窗口比例（默认 0.70） */
  readonly thresholdRatio: number;
  /** 上下文窗口下方的 token 缓冲（默认 10_000） */
  readonly bufferTokens: number;
  /** 保护为 tail 的上下文窗口比例（默认 0.20） */
  readonly tailTokenBudget: number;
  /** 保护为 head 的前 N 条消息数（默认 2） */
  readonly protectFirstN: number;
}

export const DEFAULT_COMPACTOR_CONFIG: CompactorConfig = {
  thresholdRatio: 0.7,
  bufferTokens: 10_000,
  tailTokenBudget: 0.2,
  protectFirstN: 2,
};

export interface CompactBoundaries {
  /** 最后一条 head 消息的索引（含） */
  readonly headEnd: number;
  /** 第一条 tail 消息的索引（含） */
  readonly tailStart: number;
}

export interface CompactCheck {
  readonly shouldCompact: boolean;
  readonly currentTokens: number;
  readonly thresholdTokens: number;
}

export class ContextCompactor {
  private readonly config: CompactorConfig;
  private readonly estimator: TokenEstimator;
  /** 连续压缩失败次数 */
  private consecutiveFailures = 0;
  /** 连续低收益压缩次数 */
  private consecutiveLowSavings = 0;
  /** 是否已被熔断禁用 */
  private disabled = false;

  constructor(config?: Partial<CompactorConfig>, estimator?: TokenEstimator) {
    this.config = { ...DEFAULT_COMPACTOR_CONFIG, ...config };
    this.estimator = estimator ?? new ApproximateEstimator();
  }

  /** 自动压缩是否已被熔断禁用 */
  get isDisabled(): boolean {
    return this.disabled;
  }

  /** 重置熔断器（如手动执行 /compact 命令后） */
  reset(): void {
    this.disabled = false;
    this.consecutiveFailures = 0;
    this.consecutiveLowSavings = 0;
  }

  /** 检查是否应该执行压缩 */
  check(messages: readonly ChatMessage[], contextWindow: number): CompactCheck {
    const currentTokens = this.estimator.countMessages(messages);
    const thresholdTokens = Math.floor(
      contextWindow * this.config.thresholdRatio - this.config.bufferTokens,
    );
    return {
      shouldCompact: !this.disabled && currentTokens > thresholdTokens,
      currentTokens,
      thresholdTokens,
    };
  }

  /**
   * 确定压缩的 head/tail 边界。
   *
   * - Head：前 protectFirstN 条消息（始终逐字保留）
   * - Tail：从末尾开始累积 token 不超过 tailTokenBudget 的消息
   * - Middle：head 和 tail 之间的所有消息（被总结）
   */
  determineBoundaries(messages: readonly ChatMessage[]): CompactBoundaries {
    const headEnd = Math.min(
      this.config.protectFirstN - 1,
      messages.length - 1,
    );

    const totalTokens = this.estimator.countMessages(messages);
    const tailBudget = Math.floor(totalTokens * this.config.tailTokenBudget);

    let tailTokens = 0;
    let tailStart = messages.length;

    for (let i = messages.length - 1; i > headEnd; i--) {
      const msg = messages[i];
      if (!msg) {
        continue;
      }
      const msgTokens = this.estimator.countMessages([msg]);
      if (tailTokens + msgTokens > tailBudget) {
        break;
      }
      tailTokens += msgTokens;
      tailStart = i;
    }

    // 确保 tail 至少有一条消息（在 head 之外）
    if (tailStart <= headEnd && headEnd < messages.length - 1) {
      tailStart = headEnd + 1;
    }

    return { headEnd, tailStart };
  }

  /**
   * 构建发送给压缩 Agent 的提示词。
   *
   * 如果已有 previous summary → 增量更新模式（追加新内容到已有摘要）
   * 否则 → 全新总结模式
   */
  buildSummaryPrompt(
    messagesToSummarize: readonly ChatMessage[],
    existingSummary: string | null,
  ): string {
    const historyText = messagesToSummarize
      .map((m) => {
        const prefix =
          m.role === "user"
            ? "User"
            : m.role === "assistant"
              ? "Assistant"
              : "System";
        return `[${prefix}]\n${m.content}`;
      })
      .join("\n\n");

    const anchored = existingSummary
      ? `## Previous Summary\n${existingSummary}\n\nUpdate the summary with the new conversation below. Preserve information from the previous summary that is still relevant, and add new key points from the recent conversation.`
      : "Summarize the following conversation, focusing on:";

    return `You are a context compression assistant. Your job is to distill a long conversation into a structured summary so the AI can continue working without re-reading the full history.

${anchored}

- **Active Task**: What is the user trying to accomplish?
- **Goal**: The objective of the current task.
- **Progress**: What has been completed, what is in progress, and what is blocked.
- **Key Decisions**: Important choices made and why.
- **Relevant Files**: Files and functions that have been read or modified.
- **Errors & Fixes**: Any errors encountered and how they were resolved.
- **Next Steps**: What should happen next.
- **Pending Questions**: Any unanswered questions or decisions.

Format your response as markdown with the sections above. Be concise but preserve all actionable information.

## Conversation to Summarize

${historyText}
`;
  }

  /**
   * 记录压缩结果，用于防 thrashing / 熔断器追踪。
   *
   * - 失败 → 累计 consecutiveFailures，≥3 次禁用压缩
   * - 成功但节省 < 15% → 累计 consecutiveLowSavings
   */
  recordResult(
    beforeTokens: number,
    afterTokens: number,
    success: boolean,
  ): void {
    if (!success) {
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= 3) {
        this.disabled = true;
      }
      return;
    }

    this.consecutiveFailures = 0;
    const savings = beforeTokens - afterTokens;
    const ratio = savings / Math.max(beforeTokens, 1);
    this.consecutiveLowSavings =
      ratio < 0.15 ? this.consecutiveLowSavings + 1 : 0;
  }

  /**
   * 防 thrashing 检查：最近两次压缩节省都 < 15% → 跳过。
   * 频繁压缩但收益极低说明历史已经很紧凑了。
   */
  shouldSkipDueToThrashing(): boolean {
    return this.consecutiveLowSavings >= 2;
  }
}

/** L2 压缩摘要消息的前缀 */
export const CONTEXT_SUMMARY_PREFIX = "[Context Summary]";

/** 判断消息是否为上下文摘要 */
export function isContextSummaryMessage(msg: ChatMessage): boolean {
  return (
    msg.role === "user" && msg.content.startsWith(`${CONTEXT_SUMMARY_PREFIX}\n`)
  );
}

/** 在插入新的 L2 摘要前移除旧的摘要消息（避免摘要套摘要） */
export function stripContextSummaryMessages(
  messages: readonly ChatMessage[],
): ChatMessage[] {
  return messages.filter((m) => !isContextSummaryMessage(m));
}
