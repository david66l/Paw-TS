/**
 * EvalDataCollector — 评测数据收集器，实现 EvalHooks 接口以捕获完整轮次追踪
 * ==============================================================================
 *
 * 【是什么】
 * 这是一个实现了 `EvalHooks` 接口的数据收集器，在 Agent 执行测试用例的过程中，
 * 通过钩子函数记录每一轮的模型输入/输出、工具调用和上下文快照，最终生成
 * 一份完整的 `EvalRunRecord`。
 *
 * 【为什么】
 * 评测系统的核心依赖是可追溯的运行记录。只有完整捕获每次运行的细节
 * （模型收到了什么、输出了什么、调用了哪些工具、结果如何），才能进行
 * 确定性的规则评分和 LLM 评分。此外，这些记录也是训练数据导出的原材料。
 *
 * 【关键设计决策】
 * 1. **增量构造（TurnBuilder）**：使用可变的 `TurnBuilder` 对象逐轮组装数据，
 *    钩子以无序/部分调用的方式触发（beforeModelCall → afterModelCall → afterToolCall），
 *    `flushTurn()` 在下一轮开始前将当前轮固化到 immutable 的 `turns` 数组，
 *    确保每轮数据完整性。
 * 2. **有意义的轮次才保存**：`flushTurn()` 只保存同时有 `modelInput` 和
 *    `modelOutput` 的轮次，避免空轮或半轮污染记录。
 * 3. **上下文快照**：在每个模型调用前，记录 ContextManager 的 token 使用情况
 *    （历史 token 数、系统 prompt token 数、总 token 数、消息数），
 *    用于分析上下文增长和 token 消耗问题。
 *
 * 使用方式：
 *   const collector = new EvalDataCollector(testCaseId, repIndex, runId, goal, modelLabel)
 *   const orchestrator = new AgentOrchestrator({ evalHooks: collector })
 *   // ... run completes ...
 *   const record = collector.finalize(status, finalAnswer)
 */

import type { EvalHooks, ChatMessage, ContextManager } from "@paw/core";
import type {
  EvalRunRecord,
  EvalTurnRecord,
  EvalToolExecution,
} from "./eval-record.js";

/** 可变的轮次构造器，用于增量组装 EvalTurnRecord */
interface TurnBuilder {
  turnIndex: number;
  modelInput?: EvalTurnRecord["modelInput"];
  modelOutput?: EvalTurnRecord["modelOutput"];
  contextSnapshot?: EvalTurnRecord["contextSnapshot"];
  toolExecutions: EvalTurnRecord["toolExecutions"];
}

/**
 * 评测数据收集器，实现了 EvalHooks 接口。
 *
 * 生命周期：
 * 1. 构造函数绑定测试用例标识（testCaseId, repetitionIndex, runId, goal, modelLabel）
 * 2. Orchestrator 在每个模型调用前后、每次工具调用后触发对应的钩子
 * 3. 钩子内增量填充 TurnBuilder
 * 4. 调用 finalize() 固化所有轮次并生成 EvalRunRecord
 */
export class EvalDataCollector implements EvalHooks {
  /** 已固化的轮次记录 */
  private readonly turns: EvalTurnRecord[] = [];
  /** 当前正在组装的轮次 */
  private currentTurn: TurnBuilder = { turnIndex: 0, toolExecutions: [] };
  /** 运行开始时间（毫秒时间戳），用于计算总耗时 */
  private readonly runStartTime: number;

  constructor(
    private readonly testCaseId: string,
    private readonly repetitionIndex: number,
    private readonly runId: string,
    private readonly goal: string,
    private readonly modelLabel: string,
  ) {
    this.runStartTime = Date.now();
  }

  // ── EvalHooks 实现 ──

  /**
   * 模型调用前钩子：记录当前轮次的输入快照和上下文状态。
   *
   * 在开始新一轮前，会先 flush 上一轮的数据（如果上一轮有意义的输入/输出）。
   */
  beforeModelCall(input: {
    readonly messages: readonly ChatMessage[];
    readonly contextManager: ContextManager;
  }): void {
    // 先固化上一轮数据（如果有意义的内容）
    this.flushTurn();

    const systemMsg = input.messages.find((m) => m.role === "system");
    const cm = input.contextManager;

    // 创建新一回合的构造器，记录模型输入快照和上下文状态
    this.currentTurn = {
      turnIndex: this.turns.length,
      modelInput: {
        messageCount: input.messages.length,
        systemPrompt: systemMsg?.content,
        estimatedTokens: cm.estimatedTokens,
      },
      contextSnapshot: {
        historyTokens: cm.historyEstimatedTokens,
        systemTokens: cm.systemEstimatedTokens,
        totalTokens: cm.estimatedTokens,
        messageCount: cm.length,
      },
      toolExecutions: [],
    };
  }

  /**
   * 模型调用后钩子：记录模型响应、思考过程、工具调用请求和延迟信息。
   */
  afterModelCall(output: {
    readonly turnIndex: number;
    readonly responseText: string;
    readonly thinking?: string;
    readonly toolCalls?: readonly { tool: string; args: unknown }[];
    readonly usage?: { promptTokens?: number; completionTokens?: number };
    readonly latencyMs: number;
  }): void {
    const turn = this.currentTurn;
    if (!turn) return;

    turn.modelOutput = {
      rawText: output.responseText,
      thinking: output.thinking,
      toolCalls: output.toolCalls,
      usage: output.usage,
      latencyMs: output.latencyMs,
    };
  }

  /**
   * 工具调用后钩子：记录每次工具调用的名称、参数、返回值、成功/失败和耗时。
   */
  afterToolCall(call: {
    readonly tool: string;
    readonly args: unknown;
    readonly result: string;
    readonly ok: boolean;
    readonly durationMs: number;
  }): void {
    const exec: EvalToolExecution = {
      tool: call.tool,
      args: call.args,
      result: call.result,
      ok: call.ok,
      durationMs: call.durationMs,
    };

    const turn = this.currentTurn;
    if (turn && turn.toolExecutions) {
      turn.toolExecutions.push(exec);
    }
  }

  // ── 固化方法 ──

  /**
   * 固化所有轮次数据并生成最终的 EvalRunRecord。
   *
   * 在设计上，expected 字段在此时置为 undefined，
   * 由 Runner 在收集完成后在外部设置（runner.ts 的 scoreRecord 中通过 tc.expected 传入评分逻辑）。
   *
   * @param status 运行状态（completed/failed/timeout/error）
   * @param finalAnswer 模型的最终答案（可选）
   * @param error 错误信息（可选）
   * @returns 完整的评测运行记录
   */
  finalize(
    status: EvalRunRecord["status"],
    finalAnswer?: string,
    error?: string,
  ): EvalRunRecord {
    // 先 flush 剩余的当前轮次
    this.flushTurn();

    return {
      testCaseId: this.testCaseId,
      repetitionIndex: this.repetitionIndex,
      runId: this.runId,
      goal: this.goal,
      modelLabel: this.modelLabel,
      status,
      finalAnswer,
      error,
      turns: [...this.turns], // 复制一份，防止外部修改
      durationMs: Date.now() - this.runStartTime,
      expected: undefined, // 由 Runner 在收集后设置
    };
  }

  /**
   * 内部方法：将当前轮（如果数据完整）固化到 turns 数组，并初始化新轮构造器。
   *
   * 只有同时包含 modelInput 和 modelOutput 的轮次才会被保存，
   * 避免空轮或未完成的轮次污染记录。
   */
  private flushTurn(): void {
    const turn = this.currentTurn;
    if (
      !turn ||
      turn.modelInput === undefined ||
      turn.modelOutput === undefined
    ) {
      return; // 没有有意义的输入或输出，跳过
    }

    this.turns.push({
      turnIndex: turn.turnIndex ?? this.turns.length,
      modelInput: turn.modelInput,
      modelOutput: turn.modelOutput,
      toolExecutions: turn.toolExecutions ?? [],
      contextSnapshot: turn.contextSnapshot ?? {
        historyTokens: 0,
        systemTokens: 0,
        totalTokens: 0,
        messageCount: 0,
      },
    });

    // 创建下一轮的空构造器
    this.currentTurn = { turnIndex: this.turns.length, toolExecutions: [] };
  }
}
