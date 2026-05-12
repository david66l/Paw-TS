/**
 * Context compactor — Layer 2/3 compression.
 *
 * Determines when to compact, protects head/tail boundaries,
 * and builds prompts for the compression agent.
 */

import type { ChatMessage } from "./context-manager.js";
import { estimateMessageTokens, estimateMessagesTokens } from "./token-estimate.js";

export interface CompactorConfig {
  /** Context window fraction that triggers compaction (default 0.70). */
  readonly thresholdRatio: number;
  /** Token buffer below the context window (default 10_000). */
  readonly bufferTokens: number;
  /** Fraction of context window to protect as tail (default 0.20). */
  readonly tailTokenBudget: number;
  /** Number of initial messages to protect as head (default 2). */
  readonly protectFirstN: number;
}

export const DEFAULT_COMPACTOR_CONFIG: CompactorConfig = {
  thresholdRatio: 0.70,
  bufferTokens: 10_000,
  tailTokenBudget: 0.20,
  protectFirstN: 2,
};

export interface CompactBoundaries {
  /** Index (inclusive) of the last head message. */
  readonly headEnd: number;
  /** Index (inclusive) of the first tail message. */
  readonly tailStart: number;
}

export interface CompactCheck {
  readonly shouldCompact: boolean;
  /** Current estimated tokens. */
  readonly currentTokens: number;
  /** Threshold that triggered compaction. */
  readonly thresholdTokens: number;
}

export class ContextCompactor {
  private readonly config: CompactorConfig;
  private consecutiveFailures = 0;
  private lastSavingsRatio: number | null = null;
  private disabled = false;

  constructor(config?: Partial<CompactorConfig>) {
    this.config = { ...DEFAULT_COMPACTOR_CONFIG, ...config };
  }

  /** True if auto-compact has been disabled by the circuit breaker. */
  get isDisabled(): boolean {
    return this.disabled;
  }

  /** Reset circuit breaker (e.g. after a manual /compact command). */
  reset(): void {
    this.disabled = false;
    this.consecutiveFailures = 0;
    this.lastSavingsRatio = null;
  }

  /**
   * Check whether compaction should run.
   */
  check(messages: readonly ChatMessage[], contextWindow: number): CompactCheck {
    const currentTokens = estimateMessagesTokens(messages);
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
   * Determine head/tail boundaries for compaction.
   *
   * - Head: first `protectFirstN` messages (always kept verbatim).
   * - Tail: messages from the end whose cumulative tokens ≤ `tailTokenBudget`.
   * - Middle: everything between head and tail (summarized).
   */
  determineBoundaries(messages: readonly ChatMessage[]): CompactBoundaries {
    const headEnd = Math.min(this.config.protectFirstN - 1, messages.length - 1);

    const tailBudget = Math.floor(
      (messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0)) * this.config.tailTokenBudget,
    );

    let tailTokens = 0;
    let tailStart = messages.length;

    for (let i = messages.length - 1; i > headEnd; i--) {
      const msgTokens = estimateMessageTokens(messages[i]!);
      if (tailTokens + msgTokens > tailBudget) {
        break;
      }
      tailTokens += msgTokens;
      tailStart = i;
    }

    // Ensure at least one message of tail (beyond head)
    if (tailStart <= headEnd && headEnd < messages.length - 1) {
      tailStart = headEnd + 1;
    }

    return { headEnd, tailStart };
  }

  /**
   * Build the prompt sent to the compression agent.
   */
  buildSummaryPrompt(
    headMessages: readonly ChatMessage[],
    existingSummary: string | null,
  ): string {
    const historyText = headMessages
      .map((m) => {
        const prefix = m.role === "user" ? "User" : m.role === "assistant" ? "Assistant" : "System";
        return `[${prefix}]\n${m.content}`;
      })
      .join("\n\n");

    const anchored = existingSummary
      ? `## Previous Summary\n${existingSummary}\n\nUpdate the summary with the new conversation below. Preserve information from the previous summary that is still relevant, and add new key points from the recent conversation.`
      : `Summarize the following conversation, focusing on:`;

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
   * Record the result of a compaction for anti-thrashing / circuit-breaker tracking.
   */
  recordResult(beforeTokens: number, afterTokens: number, success: boolean): void {
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
    this.lastSavingsRatio = ratio;
  }

  /**
   * Anti-thrashing check: skip compaction if the last two runs saved < 15%.
   */
  shouldSkipDueToThrashing(): boolean {
    return this.lastSavingsRatio !== null && this.lastSavingsRatio < 0.15;
  }
}
