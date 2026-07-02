/**
 * 上下文管理器：滑动窗口消息历史 + 截断。
 * ========================================
 *
 * 这是 orchestrator 与 LLM 之间的消息存储层。负责：
 * - 维护 system message + history (user/assistant 交替)
 * - 消息追加（addUser / addAssistant / addToolResult）
 * - 自动截断（每次追加后检查是否需要裁剪）
 * - L1 Prune（超大工具结果持久化到磁盘）
 * - Token 估算（委托给 TokenEstimator）
 *
 * 截断策略本身在 context-policy.ts 中，这里只负责存储和 API。
 *
 * 面试要点：
 * - 为什么 system message 不受截断影响？它是 LLM 的行为指令，裁剪会破坏 Agent 能力
 * - addUser() 中的 sanitizeUserInput()：防止用户输入中嵌入伪造的工具调用
 * - 系统注入消息（[Tool ...]、Note: 等）不经过 sanitize
 */

import { truncateHistory } from "./policy.js";
import {
  type PruneConfig,
  type PruneResult,
  pruneToolResults,
} from "./pruner.js";
import { sanitizeUserInput } from "../input-sanitizer.js";
import { formatToolResult, formatToolResults } from "../tool-result/format.js";
import {
  ApproximateEstimator,
  type TokenEstimator,
} from "../token-estimator.js";

export interface Attachment {
  readonly type: "image" | "file";
  readonly name: string;
  readonly content: string;
  readonly mimeType?: string;
}

export interface ContextManagerOptions {
  /** 最多保留的消息数（不含 system）。最旧的非 system 消息优先丢弃。 */
  readonly maxMessages?: number;
  /** 截断前所有消息的近似最大字符数。 */
  readonly maxChars?: number;
  /** 截断前近似最大 token 数。设置后优先于 maxChars。 */
  readonly maxTokens?: number;
  /** Token 估算器（默认：基于 js-tiktoken 的 ApproximateEstimator）。 */
  readonly estimator?: TokenEstimator;
  /** 受保护的最近轮次数（默认 3）。 */
  readonly tailTurnCount?: number;
}

/**
 * 系统注入消息的前缀。
 * 这些消息由 orchestrator 生成（工具结果、nudge、警告等），
 * 不是用户输入，因此免于用户输入清洗。
 */
const SYSTEM_INJECTED_PREFIXES = [
  "[",
  "Note:",
  "CRITICAL",
  "<",
  "#",
] as const;

function isSystemInjectedMessage(content: string): boolean {
  return SYSTEM_INJECTED_PREFIXES.some((prefix) => content.startsWith(prefix));
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

  /** 设置或替换 system message。 */
  setSystem(content: string): void {
    this.systemMessage = { role: "system", content };
  }

  /**
   * 追加 user 消息（可选附件）。
   * 对用户输入执行清洗：中和伪造的工具结果和工具调用模式。
   * 系统注入消息（工具结果、nudge、警告）不经过清洗。
   */
  addUser(content: string, attachments?: readonly Attachment[]): void {
    const sanitized = isSystemInjectedMessage(content)
      ? content
      : sanitizeUserInput(content).text;

    const msg: ChatMessage =
      attachments && attachments.length > 0
        ? { role: "user", content: sanitized, attachments }
        : { role: "user", content: sanitized };
    this.history.push(msg);
    this.maybeTruncate();
  }

  /** 追加 assistant 消息（可选 thinking 内容）。 */
  addAssistant(content: string, thinking?: string): void {
    const msg: ChatMessage = thinking
      ? { role: "assistant", content, thinking }
      : { role: "assistant", content };
    this.history.push(msg);
    this.maybeTruncate();
  }

  /** 追加单个工具结果作为 user 消息（注入到历史中供模型阅读）。 */
  addToolResult(
    tool: string,
    ok: boolean,
    summary: string,
    payload?: unknown,
  ): void {
    this.history.push({
      role: "user",
      content: formatToolResult({ tool, ok, summary, payload }),
    });
    this.maybeTruncate();
  }

  /** 追加多个工具结果作为一条 user 消息。 */
  addToolResults(
    results: ReadonlyArray<{
      tool: string;
      ok: boolean;
      summary: string;
      payload?: unknown;
    }>,
  ): void {
    this.history.push({
      role: "user",
      content: formatToolResults(results),
    });
    this.maybeTruncate();
  }

  /** 替换整个历史（用于恢复/回放）。 */
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

  /** 返回完整对话（system + history），供模型调用使用。 */
  buildMessages(): ChatMessage[] {
    const out: ChatMessage[] = [];
    if (this.systemMessage) {
      out.push(this.systemMessage);
    }
    out.push(...this.history);
    return out;
  }

  /** 当前消息数（不含 system）。 */
  get length(): number {
    return this.history.length;
  }

  /** 近似总字符数。 */
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

  /** 此上下文管理器使用的 token 估算器。 */
  get estimator(): TokenEstimator {
    return this._estimator;
  }

  /** 截断时受保护的最近轮次数。 */
  get tailTurnCount(): number {
    return this._tailTurnCount;
  }

  /** 完整对话的估算 token 数（system + history）。 */
  get estimatedTokens(): number {
    const messages = this.buildMessages();
    return this._estimator.countMessages(messages);
  }

  /** System message 的 token 数。 */
  get systemEstimatedTokens(): number {
    if (!this.systemMessage) return 0;
    return this._estimator.countMessages([this.systemMessage]);
  }

  /** 对话历史的 token 数（不含 system）。 */
  get historyEstimatedTokens(): number {
    return this._estimator.countMessages(this.history);
  }

  /** 截断时使用的 history token 预算上限。 */
  get historyTokenBudget(): number | null {
    return this._historyMaxTokens;
  }

  /** 设置 history 的 token 预算上限；截断时只从 history 中驱逐。 */
  setHistoryTokenBudget(tokens: number | null): void {
    this._historyMaxTokens = tokens;
  }

  /**
   * L1 裁剪：旧的工具结果 → 持久化超大的/被驱逐的输出到磁盘，
   * 在上下文里保留预览。零 LLM 调用。
   */
  prune(config?: PruneConfig): PruneResult {
    const result = pruneToolResults(this.history, config);
    if (result.pruned) {
      this.history = result.messages;
    }
    return result;
  }

  /** 每次追加后自动检查并截断。 */
  private maybeTruncate(): void {
    const useHistoryBudget = this._historyMaxTokens !== null;
    const useTokens = useHistoryBudget || this.maxTokens !== null;
    const budget = useHistoryBudget
      ? this._historyMaxTokens!
      : (this.maxTokens ?? this.maxChars);

    this.history = truncateHistory(this.history, {
      maxMessages: this.maxMessages,
      budgetOptions: {
        budget,
        useTokens,
        tailTurnCount: this._tailTurnCount,
        estimator: this._estimator,
      },
    });
  }
}

/** 富文本消息类型：支持 thinking 块和附件。 */
export interface ChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
  /** 推理/思考内容（来自支持 extended thinking 的模型，如 Claude）。 */
  readonly thinking?: string;
  /** 用户消息的附件（图片、文件等）。 */
  readonly attachments?: readonly Attachment[];
}
