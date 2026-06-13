/**
 * Efficiency and quality metrics for a single agent run.
 * Computed at run end from the event stream.
 */
export interface RunMetrics {
  readonly runId: string;
  readonly goal: string;
  readonly status: "completed" | "failed";
  /** Wall-clock duration from run.started to run.completed / run.failed (ms). */
  readonly durationMs: number;
  /** Cumulative model latency across all model.request → model.done pairs (ms). */
  readonly modelLatencyMs: number;
  /** Number of model calls (model.request events). */
  readonly modelCalls: number;
  /** Number of tool calls (tool.result events). */
  readonly toolCalls: number;
  /** Number of successful tool calls (tool.result with ok === true). */
  readonly toolSuccesses: number;
  /** Total prompt + completion tokens consumed. */
  readonly totalTokens: number;
  /** Estimated cost in the run's currency. */
  readonly estimatedCost: number;
  readonly costCurrency: "CNY" | "USD";
  /** Max turn index reached (from loop.tick events). */
  readonly steps: number;
  /** Number of times model output was truncated (finishReason = length/max_tokens). */
  readonly truncationCount: number;
}

/**
 * Mutable accumulator used during a run; frozen into {@link RunMetrics} at completion.
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

/** Human-readable single-line summary of a run's efficiency. */
export function formatRunMetricsSummary(m: RunMetrics): string {
  const sym = m.costCurrency === "CNY" ? "¥" : "$";
  const dur = m.durationMs >= 1000
    ? `${(m.durationMs / 1000).toFixed(1)}s`
    : `${m.durationMs}ms`;
  const tok = m.totalTokens >= 1000
    ? `${(m.totalTokens / 1000).toFixed(1)}K`
    : `${m.totalTokens}`;
  const tools = m.toolCalls > 0
    ? ` · ${m.toolSuccesses}/${m.toolCalls} tools`
    : "";
  const trunc = m.truncationCount > 0 ? ` · ${m.truncationCount}× truncated` : "";
  return `${dur} · ${tok} tokens · ${sym}${m.estimatedCost.toFixed(4)}${tools}${trunc}`;
}
