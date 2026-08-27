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

import { sanitizeUserInput } from "../input-sanitizer.js";
import {
  ApproximateEstimator,
  type TokenEstimator,
} from "../token-estimator.js";
import {
  type ObservationProvenanceV1,
  formatToolResult,
  formatToolResults,
} from "../tool-result/format.js";
import { truncateHistory } from "./policy.js";
import {
  type PruneConfig,
  type PruneResult,
  pruneToolResults,
} from "./pruner.js";

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

/** One provider-native tool call retained as request state, not display text. */
export interface NativeToolTurnCallV1 {
  readonly callId: string;
  readonly providerName: string;
  readonly rawArguments: string;
}

/** One result paired to a provider-native call id. */
export interface NativeToolTurnResultV1 {
  readonly callId: string;
  readonly content: string;
}

/**
 * Provider-neutral result paired to one native tool call.
 *
 * `status` preserves the runtime settlement truth. `isError` is the smaller
 * provider-facing signal used by APIs such as Anthropic tool_result blocks.
 */
export interface NativeToolTurnResultV2 {
  readonly callId: string;
  readonly status:
    | "completed"
    | "failed"
    | "rejected"
    | "cancelled"
    | "unknown";
  readonly isError: boolean;
  readonly content: string;
}

/**
 * Atomic OpenAI-compatible assistant tool-call turn plus its ordered results.
 * Keeping the pair in one history entry prevents message-level truncation from
 * orphaning an assistant tool call or its tool result before P0.3 lands.
 */
export interface NativeToolTurnV1 {
  readonly schemaVersion: 1;
  readonly protocol: "openai-compatible";
  readonly assistantContent: string;
  readonly reasoningPassback?: string;
  readonly calls: readonly NativeToolTurnCallV1[];
  readonly results: readonly NativeToolTurnResultV1[];
}

/**
 * One provider-neutral, atomic assistant/tool-result turn.
 *
 * Provider clients expand this carrier into their own wire format. Keeping the
 * assistant calls and every ordered result together prevents context eviction
 * from retaining a result while dropping the call that produced it.
 */
export interface NativeToolTurnV2 {
  readonly schemaVersion: 2;
  readonly protocol: "provider-neutral";
  readonly assistantContent: string;
  /** Exact provider reasoning payload when it is valid request passback data. */
  readonly reasoningPassback?: string;
  readonly calls: readonly NativeToolTurnCallV1[];
  readonly results: readonly NativeToolTurnResultV2[];
}

export type NativeToolTurn = NativeToolTurnV1 | NativeToolTurnV2;

/** Remove provider audit reasoning before a message enters request history. */
function stripAuditThinking(message: ChatMessage): ChatMessage {
  const { thinking: _thinking, ...requestMessage } = message;
  const nativeTurn = requestMessage.nativeToolTurn;
  if (
    nativeTurn !== undefined &&
    (requestMessage.role !== "assistant" || !isNativeToolTurn(nativeTurn))
  ) {
    const { nativeToolTurn: _invalid, ...fallbackMessage } = requestMessage;
    return fallbackMessage;
  }
  return requestMessage;
}

/** Runtime validator shared by resume ingress and provider serializers. */
export function isNativeToolTurnV1(value: unknown): value is NativeToolTurnV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const turn = value as Record<string, unknown>;
  const calls = turn.calls;
  const results = turn.results;
  if (
    turn.schemaVersion !== 1 ||
    turn.protocol !== "openai-compatible" ||
    typeof turn.assistantContent !== "string" ||
    (turn.reasoningPassback !== undefined &&
      typeof turn.reasoningPassback !== "string") ||
    !Array.isArray(calls) ||
    !Array.isArray(results) ||
    calls.length === 0 ||
    calls.length !== results.length
  ) {
    return false;
  }
  const ids = new Set<string>();
  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index];
    const result = results[index];
    if (
      call === null ||
      typeof call !== "object" ||
      Array.isArray(call) ||
      result === null ||
      typeof result !== "object" ||
      Array.isArray(result)
    ) {
      return false;
    }
    const callRecord = call as Record<string, unknown>;
    const resultRecord = result as Record<string, unknown>;
    const callId = callRecord.callId;
    if (
      typeof callId !== "string" ||
      callId.trim().length === 0 ||
      typeof callRecord.providerName !== "string" ||
      callRecord.providerName.trim().length === 0 ||
      typeof callRecord.rawArguments !== "string" ||
      typeof resultRecord.callId !== "string" ||
      resultRecord.callId !== callId ||
      typeof resultRecord.content !== "string" ||
      ids.has(callId)
    ) {
      return false;
    }
    ids.add(callId);
  }
  return true;
}

/** Runtime validator for the provider-neutral native turn carrier. */
export function isNativeToolTurnV2(value: unknown): value is NativeToolTurnV2 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const turn = value as Record<string, unknown>;
  const calls = turn.calls;
  const results = turn.results;
  if (
    turn.schemaVersion !== 2 ||
    turn.protocol !== "provider-neutral" ||
    typeof turn.assistantContent !== "string" ||
    (turn.reasoningPassback !== undefined &&
      typeof turn.reasoningPassback !== "string") ||
    !Array.isArray(calls) ||
    !Array.isArray(results) ||
    calls.length === 0 ||
    calls.length !== results.length
  ) {
    return false;
  }
  const ids = new Set<string>();
  const statuses = new Set([
    "completed",
    "failed",
    "rejected",
    "cancelled",
    "unknown",
  ]);
  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index];
    const result = results[index];
    if (
      call === null ||
      typeof call !== "object" ||
      Array.isArray(call) ||
      result === null ||
      typeof result !== "object" ||
      Array.isArray(result)
    ) {
      return false;
    }
    const callRecord = call as Record<string, unknown>;
    const resultRecord = result as Record<string, unknown>;
    const callId = callRecord.callId;
    if (
      typeof callId !== "string" ||
      callId.trim().length === 0 ||
      typeof callRecord.providerName !== "string" ||
      callRecord.providerName.trim().length === 0 ||
      typeof callRecord.rawArguments !== "string" ||
      resultRecord.callId !== callId ||
      typeof resultRecord.content !== "string" ||
      typeof resultRecord.isError !== "boolean" ||
      typeof resultRecord.status !== "string" ||
      !statuses.has(resultRecord.status) ||
      (resultRecord.status !== "completed" && resultRecord.isError !== true) ||
      ids.has(callId)
    ) {
      return false;
    }
    ids.add(callId);
  }
  return true;
}

/** Validate either the legacy OpenAI-only carrier or the canonical v2 carrier. */
export function isNativeToolTurn(value: unknown): value is NativeToolTurn {
  return isNativeToolTurnV1(value) || isNativeToolTurnV2(value);
}

/**
 * 系统注入消息的前缀。
 * 这些消息由 orchestrator 生成（工具结果、nudge、警告等），
 * 不是用户输入，因此免于用户输入清洗。
 */
const SYSTEM_INJECTED_PREFIXES = ["[", "Note:", "CRITICAL", "<", "#"] as const;

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

  upsertUserByPrefix(prefix: string, content: string): void {
    const sanitized = isSystemInjectedMessage(content)
      ? content
      : sanitizeUserInput(content).text;
    const idx = this.history.findIndex(
      (m) => m.role === "user" && m.content.startsWith(prefix),
    );
    if (idx >= 0) {
      this.history[idx] = { role: "user", content: sanitized };
    } else {
      this.history.push({ role: "user", content: sanitized });
    }
    this.maybeTruncate();
  }

  /**
   * Replace a dynamic host-control message and keep it at the history tail.
   * This preserves the cacheable prefix before rapidly changing telemetry.
   */
  upsertUserByPrefixBeforeLatest(prefix: string, content: string): void {
    const sanitized = isSystemInjectedMessage(content)
      ? content
      : sanitizeUserInput(content).text;
    this.history = this.history.filter(
      (message) =>
        message.role !== "user" || !message.content.startsWith(prefix),
    );
    const insertAt = Math.max(0, this.history.length - 1);
    this.history.splice(insertAt, 0, { role: "user", content: sanitized });
    this.maybeTruncate();
  }

  /** 追加 assistant 正文；thinking 只由 durable model.done 审计保存。 */
  addAssistant(content: string, _thinking?: string): void {
    this.history.push({ role: "assistant", content });
    this.maybeTruncate();
  }

  /** 追加单个工具结果作为 user 消息（注入到历史中供模型阅读）。 */
  addToolResult(
    tool: string,
    ok: boolean,
    summary: string,
    payload?: unknown,
    provenance?: ObservationProvenanceV1,
  ): void {
    this.history.push({
      role: "user",
      content: formatToolResult({
        tool,
        ok,
        summary,
        ...(payload !== undefined ? { payload } : {}),
        ...(provenance ? { provenance } : {}),
      }),
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
      provenance?: ObservationProvenanceV1;
    }>,
  ): void {
    this.history.push({
      role: "user",
      content: formatToolResults(results),
    });
    this.maybeTruncate();
  }

  /** Append one atomic native assistant/tool-result turn for provider replay. */
  addNativeToolTurn(
    assistantContent: string,
    reasoningPassback: string | undefined,
    calls: readonly NativeToolTurnCallV1[],
    results: ReadonlyArray<{
      callId: string;
      tool: string;
      ok: boolean;
      summary: string;
      payload?: unknown;
      provenance?: ObservationProvenanceV1;
    }>,
  ): void {
    if (calls.length === 0 || calls.length !== results.length) {
      throw new Error("Native tool turn requires one result per call");
    }
    if (new Set(calls.map((call) => call.callId)).size !== calls.length) {
      throw new Error("Native tool call ids must be unique");
    }
    for (let index = 0; index < calls.length; index += 1) {
      if (calls[index]?.callId !== results[index]?.callId) {
        throw new Error(
          `Native tool result ${index} does not match its call id`,
        );
      }
    }
    const nativeResults = results.map((result) => ({
      callId: result.callId,
      content: formatToolResult({
        tool: result.tool,
        ok: result.ok,
        summary: result.summary,
        ...(result.payload !== undefined ? { payload: result.payload } : {}),
        ...(result.provenance ? { provenance: result.provenance } : {}),
      }),
    }));
    const nativeToolTurn: NativeToolTurnV1 = {
      schemaVersion: 1,
      protocol: "openai-compatible",
      assistantContent,
      ...(reasoningPassback?.trim() ? { reasoningPassback } : {}),
      calls: calls.map((call) => ({ ...call })),
      results: nativeResults,
    };
    if (!isNativeToolTurnV1(nativeToolTurn)) {
      throw new Error("Native tool turn is not protocol-valid");
    }
    const fallbackContent = [
      assistantContent,
      ...calls.map((call) =>
        JSON.stringify({
          tool: call.providerName,
          arguments: call.rawArguments,
        }),
      ),
      ...nativeResults.map((result) => result.content),
    ]
      .filter(Boolean)
      .join("\n");
    this.history.push({
      role: "assistant",
      content: fallbackContent,
      nativeToolTurn,
    });
    this.maybeTruncate();
  }

  /** 替换整个历史（用于恢复/回放）。会立即截断到上限。 */
  replaceHistory(messages: readonly ChatMessage[]): void {
    const sys = messages.find((m) => m.role === "system");
    if (sys) {
      this.systemMessage = stripAuditThinking(sys);
    }
    this.history = messages
      .filter((m) => m.role !== "system")
      .map(stripAuditThinking);
    this.maybeTruncate();
  }

  /**
   * 设置历史但不即时截断——留给调用方先做智能压缩（L1 prune + L2 compact），
   * 再手动调 maybeTruncate 或 setHistoryTokenBudget 作为最后的安全网。
   *
   * ponytail: 只在恢复路径用，避免硬截断在压缩前就丢掉工具输出。
   */
  setHistoryRaw(messages: readonly ChatMessage[]): void {
    this.history = messages
      .filter((m) => m.role !== "system")
      .map(stripAuditThinking);
  }

  /** 公开 maybeTruncate，供外部在手动压缩后调用。 */
  truncateNow(): void {
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
      if (m.nativeToolTurn?.reasoningPassback) {
        n += m.nativeToolTurn.reasoningPassback.length;
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
    const result = pruneToolResults(this.history, {
      ...config,
      // P1.4 估算统一：L1 释放量用主路径同一估算器
      estimator: this._estimator,
    });
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
  /** Exact provider request state; valid only on a plain assistant message. */
  readonly reasoningPassback?: string;
  /** 用户消息的附件（图片、文件等）。 */
  readonly attachments?: readonly Attachment[];
  /** Atomic provider-native tool turn used only by protocol serializers. */
  readonly nativeToolTurn?: NativeToolTurn;
}
