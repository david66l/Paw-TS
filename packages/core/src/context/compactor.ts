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
 * 压缩结果三分类记账：
 * - 真失败（辅助模型异常 / 质量门控拒绝 / 节省 >80% 过度压缩）：
 *   连续 3 次 → 熔断禁用自动压缩
 * - 低收益（节省 <20%，历史已紧凑——良性，不算失败）：
 *   连续 2 次且历史未增长 20% → 退避跳过，省辅助模型调用
 *
 * 面试要点：
 * - 为什么需要三段式？完全保留 head 的初始意图 + tail 的最近上下文，
 *   只压缩中间"已经处理过的"部分
 */

import {
  ApproximateEstimator,
  type TokenEstimator,
} from "../token-estimator.js";
import {
  allocateContextBudget,
  computeCompactThreshold,
} from "./budget.js";
import { isToolResultMessage } from "../tool-result/format.js";
import type { ChatMessage } from "./manager.js";
import { isProtectedUserConstraint } from "./policy.js";

/**
 * v3 P2.2 内容驱动保护：消息是否命中「pinned」信号。
 *
 * 三类信号（按原文保留，绝不进 middle 摘要）：
 * 1. 用户约束消息（复用 policy.ts 检测，已排除工具结果与系统注入）
 * 2. 需求变更/澄清信号（改为/其实/重点是/补充…）
 * 3. 模型关键决策（决定/采用/方案/decided/chose…）
 */
const REQUIREMENT_CHANGE_PATTERN =
  /改为|改成|其实|重点是|补充|换一种|重新来|不要|必须|不能|只修改/;
const KEY_DECISION_PATTERN =
  /决定|采用|方案|选择|decided|chose|opted|selected|approach/i;

export function isPinnedMessage(msg: ChatMessage): boolean {
  if (isToolResultMessage(msg.content)) return false;
  if (msg.role === "user") {
    if (isProtectedUserConstraint(msg)) return true;
    return REQUIREMENT_CHANGE_PATTERN.test(msg.content);
  }
  if (msg.role === "assistant") {
    return KEY_DECISION_PATTERN.test(msg.content);
  }
  return false;
}

export interface CompactorConfig {
  /** 上下文窗口下方的 token 缓冲（默认 10_000，仅供 check() 使用） */
  readonly bufferTokens: number;
  /** 保护为 tail 的上下文窗口比例（默认 0.20，随上下文长度收缩，见 determineBoundaries） */
  readonly tailTokenBudget: number;
  /** 保护为 head 的前 N 条消息数（默认 3，v3：3-5 条） */
  readonly protectFirstN: number;
  /** head 的 token 上限（默认 4_000，doc 05：2-4K tokens；超出按 token 收缩） */
  readonly headMaxTokens: number;
  /** tail 绝对保底：最近至少保留的消息数（默认 20，v3） */
  readonly tailMinMessages: number;
  /** tail 绝对保底：最近至少保留的 token 数（默认 8_000，v3；随上下文缩放） */
  readonly tailMinTokens: number;
}

/**
 * tail 绝对保底占上下文总 token 的上限比例。
 * 固定 8K 保底在 32k 小窗口下吃掉 middle（e2e 实测：压缩 savings 不足被拒），
 * 有效保底 = min(配置值, max(总历史 × 此比例, 条数保底的实际 token 和))——
 * 大窗口仍 8K，小窗口自动收缩。
 */
const TAIL_FLOOR_RATIO = 0.4;

export const DEFAULT_COMPACTOR_CONFIG: CompactorConfig = {
  bufferTokens: 10_000,
  tailTokenBudget: 0.2,
  protectFirstN: 3,
  headMaxTokens: 4_000,
  tailMinMessages: 20,
  tailMinTokens: 8_000,
};

/**
 * 系统锚点消息：不计入 head token 预算、总是保留在 head。
 * [Context Package]（每轮重建的任务/约束/代码段）与 [Context Summary]（旧摘要）
 * 是系统注入的稳定锚点（C AT 论文 Q 区），不是对话历史——压缩时不得
 * 把它们挤进 middle/tail（e2e 实测：30K 字符的 Context Package 撑爆 head
 * 预算 → head 收缩到只剩 system → middle 判定错乱）。
 */
export function isContextAnchorMessage(msg: ChatMessage): boolean {
  return (
    msg.content.startsWith("[Context Package]") ||
    msg.content.startsWith("[Previous session context]")
  );
}

export interface CompactBoundaries {
  /** 最后一条 head 消息的索引（含） */
  readonly headEnd: number;
  /** 第一条 tail 消息的索引（含） */
  readonly tailStart: number;
  /**
   * v3 P2.2：middle 中需要按原文保留的消息索引（内容驱动保护）。
   * 命中约束/需求变更/关键决策信号的消息不进摘要（pinned 区）。
   */
  readonly pinned: readonly number[];
}

export interface CompactCheck {
  readonly shouldCompact: boolean;
  readonly currentTokens: number;
  readonly thresholdTokens: number;
}

/** 连续真失败熔断阈值 */
const CIRCUIT_BREAKER_THRESHOLD = 3;
/** 连续低收益退避阈值 */
const LOW_SAVINGS_BACKOFF_COUNT = 2;
/** 退避解除所需的历史增长倍率（较上次低收益拒绝时） */
const LOW_SAVINGS_REGROWTH_RATIO = 1.2;

/** 压缩失败原因分类：辅助模型异常 / 质量门控拒绝 / 节省 >80% 过度压缩 */
export type CompactionFailureReason = "error" | "quality" | "over_compression";

export class ContextCompactor {
  private readonly config: CompactorConfig;
  private readonly estimator: TokenEstimator;
  /** 连续压缩失败次数（熔断计数：只有真故障才累计） */
  private consecutiveFailures = 0;
  /** 连续低收益拒绝次数（退避计数：良性，不累计熔断） */
  private consecutiveLowSavings = 0;
  /** 最近一次低收益拒绝时的历史 token 数（退避的增长基准） */
  private lastLowSavingsTokens = 0;
  /** 最近一次失败的原因（观测/测试用） */
  private lastFailureReason: CompactionFailureReason | null = null;
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

  /** 重置熔断器与退避状态（如手动执行 /compact 命令后） */
  reset(): void {
    this.disabled = false;
    this.consecutiveFailures = 0;
    this.consecutiveLowSavings = 0;
    this.lastLowSavingsTokens = 0;
    this.lastFailureReason = null;
  }

  /**
   * 检查是否应该执行压缩（测试/便捷 API）。
   *
   * 生产路径不走这里：orchestrator 经 measureContextBudget + shouldCompactHistory
   * 判定，阈值唯一事实来源是 budget.ts。这里保持同一公式（AC-P1-11）：
   *   threshold = 0.8 × historyBudget − buffer（纯百分比，无绝对封顶）
   * historyBudget 按 contextWindow 经默认预算池计算（与 orchestrator 的
   * measureContextBudget 同源，避免 compactor/budget 双口径）。
   */
  check(messages: readonly ChatMessage[], contextWindow: number): CompactCheck {
    const currentTokens = this.estimator.countMessages(messages);
    const allocation = allocateContextBudget(contextWindow);
    const thresholdTokens = Math.max(
      0,
      computeCompactThreshold(allocation.historyBudget) - this.config.bufferTokens,
    );
    return {
      shouldCompact: !this.disabled && currentTokens > thresholdTokens,
      currentTokens,
      thresholdTokens,
    };
  }

  /**
   * 确定压缩的 head/tail 边界（v3 P2.1 + P2.2，e2e 实测修正）。
   *
   * - Head：前 protectFirstN 条消息（始终逐字保留），但 ≤ headMaxTokens
   *   （doc 05：3-5 条或 2-4K tokens；e2e 实测：每条 2.5K 的消息 3 条
   *   就占掉小历史过半 → middle 空 → 压缩永不 savings 达标）
   * - Tail：从末尾开始累积 token 不超过 tailBudget 的消息，
   *   tail 比例随上下文长度收缩（Lost in the Middle 量化结论）：
   *     totalTokens ≤ 16K → 20%
   *     16K < totalTokens ≤ 64K → 15%
   *     > 64K → 10%
   *   并带随上下文缩放的绝对保底（0.4 × total 封顶，条数保底的实际
   *   token 和参与取大）
   * - Middle：head 和 tail 之间的所有消息（被总结）
   * - Pinned（P2.2 内容驱动保护）：middle 中命中约束/需求变更/关键决策
   *   信号的消息按原文保留（不进摘要）
   */
  determineBoundaries(messages: readonly ChatMessage[]): CompactBoundaries {
    const totalTokens = this.estimator.countMessages(messages);

    // Head：前 N 条且 ≤ headMaxTokens（至少保 1 条）。
    // system 与系统锚点消息（[Context Package] 等）不计 token 预算、总是保留
    const headAnchor = (m: ChatMessage): boolean =>
      m.role === "system" || isContextAnchorMessage(m);
    let headEnd = 0;
    let headTokens = 0;
    for (
      let i = 0;
      i < Math.min(this.config.protectFirstN, messages.length);
      i++
    ) {
      const m = messages[i];
      if (!m) break;
      if (headAnchor(m)) {
        headEnd = i;
        continue;
      }
      headTokens += this.estimator.countMessages([m]);
      if (headTokens > this.config.headMaxTokens && i > 0) break;
      headEnd = i;
    }

    // v3：tail 比例随上下文长度收缩
    const shrinkRatio =
      totalTokens <= 16_000
        ? this.config.tailTokenBudget
        : totalTokens <= 64_000
          ? 0.15
          : 0.1;
    // tail 绝对保底随上下文缩放（e2e 实测修复：固定 8K/20 条保底在 32k
    // 小窗口下吃掉几乎全部 middle → 压缩永远 savings 不足被拒）。
    // 有效保底 = min(配置值, max(0.4×总历史, 条数保底的实际 token 和))
    const tailMinMessagesEffective = Math.min(
      this.config.tailMinMessages,
      Math.max(1, Math.floor(messages.length * 0.5)),
    );
    let countFloorTokens = 0;
    for (
      let i = messages.length - 1;
      i >= 0 && messages.length - 1 - i < tailMinMessagesEffective;
      i--
    ) {
      const m = messages[i];
      if (m) countFloorTokens += this.estimator.countMessages([m]);
    }
    const tailMinTokensEffective = Math.min(
      this.config.tailMinTokens,
      Math.max(Math.floor(totalTokens * TAIL_FLOOR_RATIO), countFloorTokens),
    );
    const tailBudget = Math.max(
      Math.floor(totalTokens * shrinkRatio),
      tailMinTokensEffective,
    );

    let tailTokens = 0;
    let tailStart = messages.length;
    let tailCount = 0;

    // tail 起点下界：保证 middle 至少 1 条（保底不能吃光 middle）
    const tailFloor = Math.min(headEnd + 2, messages.length);

    for (let i = messages.length - 1; i >= tailFloor; i--) {
      const msg = messages[i];
      if (!msg) {
        continue;
      }
      const msgTokens = this.estimator.countMessages([msg]);
      // 保底已并入 tailBudget（条数保底的实际 token 和 或 缩放 token 保底 取大者）
      if (tailTokens + msgTokens <= tailBudget) {
        tailTokens += msgTokens;
        tailStart = i;
        tailCount++;
        continue;
      }
      break;
    }

    // 确保 tail 至少有一条消息（在 head 之外）
    if (tailStart <= headEnd && headEnd < messages.length - 1) {
      tailStart = headEnd + 1;
    }

    // P2.2：middle 中内容驱动保护的消息（pinned 区）
    const pinned: number[] = [];
    for (let i = headEnd + 1; i < tailStart; i++) {
      const msg = messages[i];
      if (!msg) continue;
      if (isPinnedMessage(msg)) {
        pinned.push(i);
      }
    }

    return { headEnd, tailStart, pinned };
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
      ? `## Previous Summary\n${existingSummary}\n\nUpdate the summary with the new conversation below.
REVISION RULE (v3 P2.4 chapter-level revision): Only rewrite the sections that are affected by the new conversation. Keep all unaffected sections verbatim from the Previous Summary. Do NOT rewrite the whole summary. If a section is unchanged, copy its exact text.`
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

FORMAT RULES (v3 P2.3 telegraphic style for fact sections):
- For **Key Decisions**, **Relevant Files**, **Errors & Fixes**: one fact per line, pipe-separated entity-operator clauses. Keep entity names (file paths, function names, error codes, commands) VERBATIM — never paraphrase identifiers.
  Example: Errors & Fixes: E108 @raised_by _check_list_display_item | root: hasattr guard @blocks _meta.get_field
- For **Progress**, **Next Steps**: short prose, but must name specific files, tests, and commands (no vague "continue verification").
- The whole summary must stay within the token budget of roughly 1/5 of the compressed history.

REASONING MODELS (v3 P5.3): If the conversation contains <think>/<thinking> blocks, they often restate the plan and constraints. Preserve any plan statements found in recent thinking blocks inside the relevant sections (Progress / Next Steps), but do NOT copy raw thinking verbatim into the summary.

Format your response as markdown with the sections above. Be concise but preserve all actionable information.

## Conversation to Summarize

${historyText}
`;
  }

  /**
   * 记录一次真失败：连续 3 次 → 熔断禁用自动压缩。
   * 只对故障计数（辅助模型异常 / 质量门控拒绝 / 节省 >80% 过度压缩）；
   * 低收益拒绝走 recordLowSavings，不算失败。
   */
  recordFailure(reason: CompactionFailureReason): void {
    this.lastFailureReason = reason;
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
      this.disabled = true;
    }
  }

  /** 最近一次失败的原因（无失败时为 null） */
  get failureReason(): CompactionFailureReason | null {
    return this.lastFailureReason;
  }

  /**
   * 记录一次低收益拒绝（节省 <20%，历史已紧凑——良性）。
   * 不累计熔断；连续 2 次后进入退避（见 shouldBackoffForLowSavings）。
   */
  recordLowSavings(historyTokens: number): void {
    this.consecutiveLowSavings++;
    this.lastLowSavingsTokens = historyTokens;
  }

  /** 压缩成功：失败/低收益计数与退避基准全部复位 */
  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.consecutiveLowSavings = 0;
    this.lastLowSavingsTokens = 0;
    this.lastFailureReason = null;
  }

  /**
   * 低收益退避检查：连续 2 次低收益、且历史较上次拒绝时未增长 20% → 跳过。
   * 语义：历史已经很紧凑时反复尝试只会白烧辅助模型调用；
   * 历史实质增长（+20%）后退避自动解除。
   */
  shouldBackoffForLowSavings(currentTokens: number): boolean {
    return (
      this.consecutiveLowSavings >= LOW_SAVINGS_BACKOFF_COUNT &&
      currentTokens <= this.lastLowSavingsTokens * LOW_SAVINGS_REGROWTH_RATIO
    );
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
