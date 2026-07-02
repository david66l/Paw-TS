/**
 * 运行指标（RunMetrics）——单次 agent 运行的效率和质量度量数据结构。
 *
 * ## 模块职责（架构定位）
 * 本模块定义了 agent 运行完成后产出的指标体系，是 paw-ts 项目遥测系统的核心数据模型。
 * 它包含两个核心接口和一组辅助函数：
 *
 * 1. **RunMetrics（不可变指标快照）**：运行结束时的只读数据，序列化后用于存储、
 *    展示和分析。通过 `RunEvaluator` 从事件流中离线推导，或由编排器的累加器在线冻结生成。
 * 2. **RunMetricsAccumulator（可变累加器）**：在运行过程中持续更新的状态容器，
 *    与 `RunMetrics` 字段完全一致但允许修改，运行结束后冻结为不可变的 `RunMetrics`。
 *
 * ## 指标体系设计原则
 * 指标分为四大类：
 * - **时间效率**：durationMs（墙钟耗时）、modelLatencyMs（纯模型等待耗时）
 * - **资源消耗**：modelCalls（API 调用次数）、totalTokens（token 总消耗）、estimatedCost（费用）
 * - **工具执行**：toolCalls（调用总数）、toolSuccesses（成功数）
 * - **运行质量**：steps（迭代轮次）、truncationCount（输出截断次数，截断可能导致任务失败）
 *
 * ## 关键设计决策
 * 1. **只读接口 + 可变累加器分离**：RunMetrics 的 `readonly` 修饰符确保指标一旦
 *    生成就不会被意外修改，而 RunMetricsAccumulator 允许运行过程中的高效累加。
 * 2. **多币种支持**：通过 `costCurrency` 字段同时支持人民币（CNY）和美元（USD），
 *    由 `formatRunMetricsSummary` 根据币种自动选择 ¥ 或 $ 符号。
 * 3. **人类友好格式化**：`formatRunMetricsSummary` 提供单行摘要输出，智能选择
 *    时间单位（s/ms）和 token 单位（K/原始值），适合在 UI 和命令行中快速展示。
 *
 * Efficiency and quality metrics for a single agent run.
 * Computed at run end from the event stream.
 */

// ============================================================
// 不可变指标快照（运行结束后使用）
// ============================================================

/**
 * 单次 agent 运行的完整效率和质量指标（不可变）。
 *
 * 该接口在运行结束时通过 `RunEvaluator.evaluateRunFromEnvelopes` 生成，
 * 或由编排器将 `RunMetricsAccumulator` 冻结后得到。
 */
export interface RunMetrics {
  readonly runId: string;
  readonly goal: string;
  readonly status: "completed" | "failed";
  /** 从 run.started 到 run.completed / run.failed 的墙钟耗时（毫秒） */
  readonly durationMs: number;
  /** 所有 model.request → model.done 对的模型延迟累加和（毫秒） */
  readonly modelLatencyMs: number;
  /** 模型调用次数（即 model.request 事件数） */
  readonly modelCalls: number;
  /** 工具调用总次数（即 tool.result 事件数） */
  readonly toolCalls: number;
  /** 工具调用成功次数（tool.result 中 ok === true 的事件数） */
  readonly toolSuccesses: number;
  /** 总 token 消耗（prompt tokens + completion tokens） */
  readonly totalTokens: number;
  /** 估算费用（以运行时的货币单位计） */
  readonly estimatedCost: number;
  /** 费用货币单位：CNY（人民币）或 USD（美元） */
  readonly costCurrency: "CNY" | "USD";
  /** 最大循环轮次索引（来自 loop.tick 事件） */
  readonly steps: number;
  /** 模型输出被截断的次数（finishReason 为 length/max_tokens 时触发） */
  readonly truncationCount: number;
}

// ============================================================
// 可变指标累加器（运行过程中使用）
// ============================================================

/**
 * 运行过程中使用的可变指标累加器。
 *
 * 与 `RunMetrics` 字段完全对应，但不使用 `readonly` 修饰符，
 * 允许运行过程中持续更新。运行结束时冻结为不可变的 `RunMetrics`。
 *
 * Mutable accumulator used during a run; frozen into
 * {@link RunMetrics} at completion.
 */
export interface RunMetricsAccumulator {
  runId: string;
  goal: string;
  status: "completed" | "failed";
  durationMs: number;
  modelLatencyMs: number;
  modelCalls: number;
  toolCalls: number;
  toolSuccesses: number;
  totalTokens: number;
  estimatedCost: number;
  costCurrency: "CNY" | "USD";
  steps: number;
  truncationCount: number;
}

// ============================================================
// 格式化辅助函数
// ============================================================

/**
 * 生成运行指标的人类可读单行摘要。
 *
 * 输出格式示例：
 * ```
 * 12.5s · 3.2K tokens · $0.0152 · 8/10 tools · 1× truncated
 * ```
 *
 * 格式化规则：
 * - 时间超过 1 秒时以秒为单位显示（保留 1 位小数），否则以毫秒显示
 * - token 数超过 1000 时以 K 为单位显示（保留 1 位小数），否则显示原始值
 * - 根据 costCurrency 自动选择货币符号（¥ 或 $）
 * - 仅当有工具调用时才显示工具成功率
 * - 仅当有截断时才显示截断次数
 *
 * Human-readable single-line summary of a run's efficiency.
 *
 * @param m - 运行指标快照
 * @returns 格式化的单行摘要字符串
 */
export function formatRunMetricsSummary(m: RunMetrics): string {
  // 根据货币单位选择符号
  const sym = m.costCurrency === "CNY" ? "¥" : "$";
  // 智能格式化时间：>= 1 秒用 s，< 1 秒用 ms
  const dur = m.durationMs >= 1000
    ? `${(m.durationMs / 1000).toFixed(1)}s`
    : `${m.durationMs}ms`;
  // 智能格式化 token 数：>= 1000 用 K
  const tok = m.totalTokens >= 1000
    ? `${(m.totalTokens / 1000).toFixed(1)}K`
    : `${m.totalTokens}`;
  // 仅当有工具调用时才显示工具成功率
  const tools = m.toolCalls > 0
    ? ` · ${m.toolSuccesses}/${m.toolCalls} tools`
    : "";
  // 仅当有截断时才显示截断信息
  const trunc = m.truncationCount > 0 ? ` · ${m.truncationCount}× truncated` : "";
  return `${dur} · ${tok} tokens · ${sym}${m.estimatedCost.toFixed(4)}${tools}${trunc}`;
}
