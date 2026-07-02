/**
 * EvalRunRecord — 单次测试用例运行的完整追踪记录
 * ======================================================
 *
 * 【是什么】
 * 定义评测运行记录的类型体系。每个测试用例的每一次重复运行都对应一个
 * `EvalRunRecord`，其中包含多轮 `EvalTurnRecord`，每轮又包含模型输入/
 * 输出、工具调用记录和上下文快照。
 *
 * 【为什么】
 * 评测系统的所有评分逻辑都依赖这些结构化数据。将记录的 schema 独立出来：
 * - 便于 EvalDataCollector（生产者）和 RuleScorer/LlmScorer（消费者）
 *   共享同一套类型定义，避免隐式契约
 * - 便于未来扩展（如增加 token 统计、思考链追踪等字段）
 * - 训练数据导出器也依赖此类型进行 ChatML 转换
 *
 * 【关键设计决策】
 * 1. **全部 readonly**：记录一旦生成不应被修改，确保评分的一致性。
 * 2. **分层结构**：EvalRunRecord > EvalTurnRecord > EvalModelInput/Output + EvalToolExecution。
 *    这种层次化设计让评分器可以按粒度（运行级、轮次级、工具级）进行检查。
 * 3. **expected 字段**：承载测试用例的预期标准，由 Runner 在评分前注入，
 *    在收集阶段保持 undefined。
 * 4. **status 区分**：completed/failed/timeout/error 四种状态分离了"正常运行但未通过"
 *    和"系统/超时异常"两种情况，训练数据导出时只取 completed 的记录。
 */

/** 评测钩子捕获的单次工具调用记录 */
export interface EvalToolExecution {
  /** 工具名称 */
  readonly tool: string;
  /** 工具调用参数 */
  readonly args: unknown;
  /** 工具返回结果 */
  readonly result: string;
  /** 工具调用是否成功 */
  readonly ok: boolean;
  /** 工具执行耗时（毫秒） */
  readonly durationMs: number;
}

/** 模型调用前的输入快照（由 beforeModelCall 钩子捕获） */
export interface EvalModelInput {
  /** 发送给模型的消息数量 */
  readonly messageCount: number;
  /** 系统提示词内容（可选） */
  readonly systemPrompt?: string;
  /** 估算的 token 数量 */
  readonly estimatedTokens: number;
}

/** 模型调用后的输出快照（由 afterModelCall 钩子捕获） */
export interface EvalModelOutput {
  /** 模型原始输出文本 */
  readonly rawText: string;
  /** 模型的思考过程（如 CoT/推理链） */
  readonly thinking?: string;
  /** 模型请求的工具调用列表 */
  readonly toolCalls?: readonly { tool: string; args: unknown }[];
  /** Token 使用统计 */
  readonly usage?: { promptTokens?: number; completionTokens?: number };
  /** 模型调用延迟（毫秒） */
  readonly latencyMs: number;
}

/** 模型调用前的上下文状态快照，用于分析 token 增长 */
export interface EvalContextSnapshot {
  /** 历史对话 token 数 */
  readonly historyTokens: number;
  /** 系统提示词 token 数 */
  readonly systemTokens: number;
  /** 总 token 数（历史 + 系统 + 当前输入） */
  readonly totalTokens: number;
  /** 当前上下文中的消息数量 */
  readonly messageCount: number;
}

/** 一轮对话的完整数据（一次 用户/模型 交互往返） */
export interface EvalTurnRecord {
  /** 轮次索引（从 0 开始） */
  readonly turnIndex: number;
  /** 模型输入快照 */
  readonly modelInput: EvalModelInput;
  /** 模型输出快照 */
  readonly modelOutput: EvalModelOutput;
  /** 该轮中的所有工具调用记录 */
  readonly toolExecutions: EvalToolExecution[];
  /** 模型调用前的上下文状态快照 */
  readonly contextSnapshot: EvalContextSnapshot;
}

/** 单次测试用例运行的完整记录 */
export interface EvalRunRecord {
  /** 测试用例 ID */
  readonly testCaseId: string;
  /** 重复索引（第几次重复运行） */
  readonly repetitionIndex: number;
  /** 运行唯一标识 */
  readonly runId: string;
  /** 给 Agent 的自然语言目标 */
  readonly goal: string;
  /** 模型标签（用于区分不同模型的运行结果） */
  readonly modelLabel: string;
  /** 运行状态：完成/失败/超时/错误 */
  readonly status: "completed" | "failed" | "timeout" | "error";
  /** Agent 的最终答案（如果运行成功完成） */
  readonly finalAnswer?: string;
  /** 错误信息（如果运行出错） */
  readonly error?: string;
  /** 记录的所有轮次 */
  readonly turns: EvalTurnRecord[];
  /** 运行总耗时（毫秒），从 Collector 构造到 finalize 调用 */
  readonly durationMs: number;
  /** 测试用例的预期标准（用于评分），由 Runner 在收集后注入 */
  readonly expected: unknown;
}
