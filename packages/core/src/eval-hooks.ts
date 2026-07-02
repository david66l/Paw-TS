/**
 * EvalHooks — 评测钩子模块
 *
 * 【模块职责】
 * 定义评测系统所需的全部回调接口。这些是评测系统与编排器（Orchestrator）之间的
 * 唯一依赖契约——评测系统通过这三个回调收集模型输入/输出和工具执行数据，但不会
 * 修改编排器的控制流。
 *
 * 【为什么独立成模块】
 * 将"收集评测数据"的关注点从编排器中完全分离。编排器只需要在关键节点调用这些
 * 钩子，而不需要知道自己正在被评测。实现方（如 EvalDataCollector）接收这些回
 * 调并累加追踪数据供后续评分使用。
 *
 * 【设计决策】
 * - 全部字段为可选的 readonly：不强制实现所有钩子，按需覆盖
 * - 接口而非类：纯数据结构，无副作用，方便序列化和跨模块传递
 * - 三个钩子覆盖完整的评测生命周期：调用前 → 调用后 → 工具执行后
 *
 * EvalHooks — optional callbacks for collecting evaluation traces.
 *
 * These are the ONLY hooks the eval system needs from the orchestrator.
 * They capture model input/output and tool execution data without
 * modifying the orchestrator's control flow.
 *
 * Implementations (e.g. EvalDataCollector) receive these callbacks and
 * accumulate trace data for later scoring.
 */

import type { ChatMessage, ContextManager } from "./context/manager.js";

/**
 * 评测钩子接口
 *
 * 编排器在关键生命周期节点调用这些回调，将调用数据传递给评测收集器。
 * 所有方法均可选实现——评测系统按需覆盖。
 */
export interface EvalHooks {
  /**
   * 模型调用前触发
   *
   * 在 invokeModel() 即将执行时调用。捕获完整的消息数组和上下文管理器
   * 状态快照，用于记录"模型收到了什么输入"。
   *
   * Called immediately before invokeModel().
   * Captures the full messages array and context manager state snapshot.
   */
  readonly beforeModelCall?: (input: {
    /** 即将发送给模型的消息列表 */
    readonly messages: readonly ChatMessage[];
    /** 当前上下文管理器的状态快照 */
    readonly contextManager: ContextManager;
  }) => void;

  /**
   * 模型响应返回后触发
   *
   * 模型响应被接收并解析后调用。捕获响应文本、思维链（thinking）、
   * 工具调用、token 用量和延迟，用于后续评分分析。
   *
   * Called after model response is received and parsed.
   * Captures response text, thinking, tool calls, usage, and latency.
   */
  readonly afterModelCall?: (output: {
    /** 当前回合索引（从 0 开始） */
    readonly turnIndex: number;
    /** 模型返回的响应文本 */
    readonly responseText: string;
    /** 思维链内容（模型开启 extended thinking 时存在） */
    readonly thinking?: string;
    /** 模型请求的工具调用列表 */
    readonly toolCalls?: readonly { tool: string; args: unknown }[];
    /** Token 用量统计（prompt + completion） */
    readonly usage?: { promptTokens?: number; completionTokens?: number };
    /** 本次调用延迟（毫秒） */
    readonly latencyMs: number;
  }) => void;

  /**
   * 工具执行完成后触发
   *
   * 每次工具调用执行完毕时调用。捕获工具名、参数、结果、成功状态和耗时，
   * 用于分析工具使用模式和可靠性。
   *
   * Called after each tool execution completes.
   * Captures tool name, arguments, result, success status, and duration.
   */
  readonly afterToolCall?: (call: {
    /** 被调用的工具名称 */
    readonly tool: string;
    /** 工具调用时的参数 */
    readonly args: unknown;
    /** 工具返回的结果文本 */
    readonly result: string;
    /** 工具是否执行成功 */
    readonly ok: boolean;
    /** 工具执行耗时（毫秒） */
    readonly durationMs: number;
  }) => void;
}
