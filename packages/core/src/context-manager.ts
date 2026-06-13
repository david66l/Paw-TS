/**
 * Context manager: sliding-window message history with truncation.
 *
 * Keeps the system message + the most recent N messages when the
 * conversation grows beyond configured limits.
 */

import {
  type PruneConfig,
  type PruneResult,
  pruneToolResults,
} from "./context-pruner.js";
import { sanitizeUserInput } from "./input-sanitizer.js";
import {
  ApproximateEstimator,
  type TokenEstimator,
} from "./token-estimator.js";

export interface Attachment {
  readonly type: "image" | "file";
  readonly name: string;
  readonly content: string;
  readonly mimeType?: string;
}

export interface ContextManagerOptions {
  /** Max messages to retain (excluding system). Oldest non-system dropped first. */
  readonly maxMessages?: number;
  /** Approx max characters across all messages before truncation. */
  readonly maxChars?: number;
  /** Approx max tokens before truncation. When set, takes priority over maxChars. */
  readonly maxTokens?: number;
  /** Token estimator (default: ApproximateEstimator using js-tiktoken). */
  readonly estimator?: TokenEstimator;
  /** Number of recent turns to protect from truncation (default: 3). */
  readonly tailTurnCount?: number;
}

export class ContextManager {
  private systemMessage: ChatMessage | null = null;
  private history: ChatMessage[] = [];
  private readonly maxMessages: number;
  private readonly maxChars: number;
  private readonly maxTokens: number | null;
  private readonly _estimator: TokenEstimator;
  private readonly _tailTurnCount: number;
  private _historyMaxTokens: number | null = null;

  constructor(opts?: ContextManagerOptions) {
    this.maxMessages = opts?.maxMessages ?? 40;
    this.maxChars = opts?.maxChars ?? 80_000;
    this.maxTokens = opts?.maxTokens ?? null;
    this._estimator = opts?.estimator ?? new ApproximateEstimator();
    this._tailTurnCount = opts?.tailTurnCount ?? 3;
  }

  /** Set or replace the system message. */
  setSystem(content: string): void {
    this.systemMessage = { role: "system", content };
  }

  /** Append a user message (optionally with attachments). Sanitizes tool-like patterns from user input. */
  addUser(content: string, attachments?: readonly Attachment[]): void {
    // Sanitize user input to neutralize fake tool results and tool-call patterns.
    // System-injected messages (tool results, nudges, warnings) are NOT sanitized.
    const isSystemInjected =
      content.startsWith("[") ||
      content.startsWith("Note:") ||
      content.startsWith("CRITICAL") ||
      content.startsWith("<") ||
      content.startsWith("#");
    const sanitized = isSystemInjected ? content : sanitizeUserInput(content).text;

    const msg: ChatMessage =
      attachments && attachments.length > 0
        ? { role: "user", content: sanitized, attachments }
        : { role: "user", content: sanitized };
    this.history.push(msg);
    this.maybeTruncate();
  }

  /** Append an assistant message (optionally with thinking content). */
  addAssistant(content: string, thinking?: string): void {
    const msg: ChatMessage = thinking
      ? { role: "assistant", content, thinking }
      : { role: "assistant", content };
    this.history.push(msg);
    this.maybeTruncate();
  }

  /** Append a tool-result observation as a user message. */
  addToolResult(
    tool: string,
    ok: boolean,
    summary: string,
    payload?: unknown,
  ): void {
    const detail =
      payload !== undefined
        ? `\n${JSON.stringify(payload).slice(0, 10_000)}`
        : "";
    this.history.push({
      role: "user",
      content: `[Tool ${tool} ${ok ? "completed" : "failed"}]\n${summary}${detail}`,
    });
    this.maybeTruncate();
  }

  /** Append multiple tool-result observations as a single user message. */
  addToolResults(
    results: ReadonlyArray<{
      tool: string;
      ok: boolean;
      summary: string;
      payload?: unknown;
    }>,
  ): void {
    const lines = results.map((r) => {
      const detail =
        r.payload !== undefined
          ? `\n${JSON.stringify(r.payload).slice(0, 10_000)}`
          : "";
      return `[Tool ${r.tool} ${r.ok ? "completed" : "failed"}]\n${r.summary}${detail}`;
    });
    this.history.push({
      role: "user",
      content: lines.join("\n\n"),
    });
    this.maybeTruncate();
  }

  /** Replace the entire history (e.g. for replay / restore). */
  replaceHistory(messages: readonly ChatMessage[]): void {
    const sys = messages.find((m) => m.role === "system");
    if (sys) {
      this.systemMessage = sys;
    }
    this.history = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ ...m }));
    this.maybeTruncate();
  }

  /** Return the full conversation for the model (system + history). */
  buildMessages(): ChatMessage[] {
    const out: ChatMessage[] = [];
    if (this.systemMessage) {
      out.push(this.systemMessage);
    }
    out.push(...this.history);
    return out;
  }

  /** Current message count excluding system. */
  get length(): number {
    return this.history.length;
  }

  /** Total approximate character count. */
  get charCount(): number {
    let n = 0;
    if (this.systemMessage) {
      n += this.systemMessage.content.length;
    }
    for (const m of this.history) {
      n += m.content.length;
      if (m.thinking) {
        n += m.thinking.length;
      }
    }
    return n;
  }

  /** The token estimator used by this context manager. */
  get estimator(): TokenEstimator {
    return this._estimator;
  }

  /** Number of recent turns protected from truncation. */
  get tailTurnCount(): number {
    return this._tailTurnCount;
  }

  /** Estimated token count for the full conversation (system + history). */
  get estimatedTokens(): number {
    const messages = this.buildMessages();
    return this._estimator.countMessages(messages);
  }

  /** Token count for the system message only. */
  get systemEstimatedTokens(): number {
    if (!this.systemMessage) return 0;
    return this._estimator.countMessages([this.systemMessage]);
  }

  /** Token count for conversation history (excluding system). */
  get historyEstimatedTokens(): number {
    return this._estimator.countMessages(this.history);
  }

  /** Cap enforced by {@link setHistoryTokenBudget} during truncation. */
  get historyTokenBudget(): number | null {
    return this._historyMaxTokens;
  }

  /** Set max tokens for history; truncation evicts only from history. */
  setHistoryTokenBudget(tokens: number | null): void {
    this._historyMaxTokens = tokens;
  }

  /**
   * Prune old tool results: persist oversized / evicted outputs to disk,
   * keep preview in context. Zero LLM calls.
   */
  prune(config?: PruneConfig): PruneResult {
    const result = pruneToolResults(this.history, config);
    if (result.pruned) {
      this.history = result.messages;
    }
    return result;
  }

  private maybeTruncate(): void {
    // Phase 1: Truncate by message count.
    if (this.history.length > this.maxMessages) {
      this.truncateByMessageCount();
    }

    // Phase 2: Truncate by token/character budget with priority-aware eviction.
    const useHistoryBudget = this._historyMaxTokens !== null;
    const useTokens = useHistoryBudget || this.maxTokens !== null;
    const tokenBudget = useHistoryBudget
      ? this._historyMaxTokens
      : this.maxTokens;
    const budget = useHistoryBudget
      ? (tokenBudget ?? this.maxChars)
      : useTokens
        ? (tokenBudget ?? this.maxChars)
        : this.maxChars;

    let current = useHistoryBudget
      ? this.historyEstimatedTokens
      : useTokens
        ? this.estimatedTokens
        : this.charCount;
    if (current <= budget) return;

    const msgCost = (m: ChatMessage): number =>
      useTokens
        ? this._estimator.countMessages([m])
        : m.content.length + (m.thinking?.length ?? 0);

    // Find protection level that fits: degrade tail turns 3 → 2 → 1 → 0
    let protectedIndices: number[] = [];
    for (let turns = this._tailTurnCount; turns >= 0; turns--) {
      protectedIndices = this.getProtectedIndices(turns);
      const protectedCost = protectedIndices.reduce((sum, i) => {
        const msg = this.history[i];
        return msg ? sum + msgCost(msg) : sum;
      }, 0);
      const lastMsg = this.history[this.history.length - 1];
      const lastMsgCost = lastMsg ? msgCost(lastMsg) : 0;
      if (protectedCost + lastMsgCost <= budget) {
        break;
      }
    }

    const protectedSet = new Set(protectedIndices);
    protectedSet.add(this.history.length - 1); // last message always protected

    // Score evictable messages (exclude protected and last).
    const scored: Array<{ idx: number; cost: number; score: number }> = [];
    for (let i = 0; i < this.history.length - 1; i++) {
      if (protectedSet.has(i)) continue;
      const msg = this.history[i];
      if (!msg) continue;
      scored.push({
        idx: i,
        cost: msgCost(msg),
        score: messagePriorityScore(msg, i, this.history.length),
      });
    }

    // Evict lowest-priority first; tie-break by highest cost.
    scored.sort((a, b) => a.score - b.score || b.cost - a.cost);

    const evictSet = new Set<number>();
    for (const s of scored) {
      if (current <= budget) break;
      evictSet.add(s.idx);
      current -= s.cost;
    }

    // If still over budget, degrade protection further (remove initial goal).
    if (current > budget) {
      const degradable = protectedIndices
        .filter((i) => i < this.history.length - 1 && !evictSet.has(i))
        .flatMap((i) => {
          const msg = this.history[i];
          if (!msg) return [];
          return [
            {
              idx: i,
              cost: msgCost(msg),
              score: messagePriorityScore(msg, i, this.history.length),
            },
          ];
        })
        .sort((a, b) => a.score - b.score || b.cost - a.cost);

      for (const d of degradable) {
        if (current <= budget) break;
        evictSet.add(d.idx);
        current -= d.cost;
      }
    }

    if (evictSet.size > 0) {
      this.history = this.history.filter((_, i) => !evictSet.has(i));
    }
  }

  private truncateByMessageCount(): void {
    const protectedIndices = this.getProtectedConstraintIndices();
    if (protectedIndices.length === 0) {
      this.history = this.history.slice(-this.maxMessages);
      return;
    }

    const keep = new Set<number>(protectedIndices);
    for (
      let i = this.history.length - 1;
      i >= 0 && keep.size < this.maxMessages;
      i--
    ) {
      keep.add(i);
    }
    this.history = this.history.filter((_, i) => keep.has(i));
  }

  /**
   * Get indices of protected messages at a given tail-turn count.
   * - Head: first non-tool user message (initial goal)
   * - Tail: messages from the Nth-most-recent assistant to the end
   */
  private getProtectedIndices(tailTurnCount: number): number[] {
    const result: number[] = [];

    // Head: initial user goal (first non-tool user message)
    for (let i = 0; i < this.history.length; i++) {
      const msg = this.history[i];
      if (!msg) continue;
      if (msg.role === "user" && !msg.content.startsWith("[Tool ")) {
        result.push(i);
        break;
      }
    }

    for (const i of this.getProtectedConstraintIndices()) {
      result.push(i);
    }

    // Tail: recent N turns (a turn boundary is an assistant message)
    if (tailTurnCount > 0) {
      let turnsFound = 0;
      let tailStart = this.history.length;

      for (let i = this.history.length - 1; i >= 0; i--) {
        if (this.history[i]?.role === "assistant") {
          turnsFound++;
          tailStart = i;
          if (turnsFound >= tailTurnCount) {
            break;
          }
        }
      }

      for (let i = tailStart; i < this.history.length; i++) {
        result.push(i);
      }
    }

    return [...new Set(result)].sort((a, b) => a - b);
  }

  private getProtectedConstraintIndices(): number[] {
    const result: number[] = [];
    for (let i = 0; i < this.history.length; i++) {
      const msg = this.history[i];
      if (msg && isProtectedUserConstraint(msg)) {
        result.push(i);
      }
    }
    return result;
  }
}

const MSG_PRIORITY = {
  USER_CONSTRAINT: 120,
  TOOL_RESULT: 95,
  USER: 80,
  ASSISTANT_WITH_THINKING: 60,
  ASSISTANT: 40,
  SYSTEM: 90,
} as const;

/** Higher score = higher priority (less likely to be evicted). */
function messagePriorityScore(
  msg: ChatMessage,
  index?: number,
  total?: number,
): number {
  if (isProtectedUserConstraint(msg)) {
    return MSG_PRIORITY.USER_CONSTRAINT;
  }
  if (msg.role === "user" && msg.content.startsWith("[Tool ")) {
    const age =
      index !== undefined && total !== undefined ? total - 1 - index : 0;
    return Math.max(45, MSG_PRIORITY.TOOL_RESULT - age * 2);
  }
  if (msg.role === "user") {
    return MSG_PRIORITY.USER;
  }
  if (msg.role === "assistant" && msg.thinking) {
    return MSG_PRIORITY.ASSISTANT_WITH_THINKING;
  }
  if (msg.role === "assistant") {
    return MSG_PRIORITY.ASSISTANT;
  }
  return MSG_PRIORITY.SYSTEM;
}

const USER_CONSTRAINT_PATTERNS = [
  /不要/,
  /不能/,
  /禁止/,
  /只能/,
  /必须/,
  /不要动/,
  /不要修改/,
  /不要删除/,
  /不要联网/,
  /不要访问/,
  /不要执行/,
  /只修改/,
  /当前目录/,
  /工作区外/,
  /\bdo not\b/i,
  /\bmust not\b/i,
  /\bonly\b/i,
  /\bnever\b/i,
  /\bforbid(?:den)?\b/i,
];

function isProtectedUserConstraint(msg: ChatMessage): boolean {
  if (msg.role !== "user" || msg.content.startsWith("[Tool ")) {
    return false;
  }
  return USER_CONSTRAINT_PATTERNS.some((p) => p.test(msg.content));
}

/** Rich message type supporting thinking blocks and attachments. */
export interface ChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
  /** Thinking/reasoning content from models that support it (e.g. Claude extended thinking). */
  readonly thinking?: string;
  /** Attachments for user messages (images, files, etc.). */
  readonly attachments?: readonly Attachment[];
}
