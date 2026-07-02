/**
 * 上下文预算 — system / tools / history / reserve 四池分配。
 * =========================================================
 *
 * LLM 的上下文窗口是固定的（如 128k），但需要容纳三种内容：
 * 1. System prompt（指令 + 工具定义 + 记忆 + 项目上下文）
 * 2. Tools（JSON Schema 定义，部分 provider 单独计费）
 * 3. History（对话历史）
 *
 * 预算分配按比例划分：
 * - systemRatio：12%（≤500k）或 8%（大型窗口 >500k）
 * - toolsRatio：8% 或 7%
 * - historyRatio：75% 或 85%
 * - reserveRatio：5%（安全缓冲）
 *
 * L1/L2 压缩触发只监控 history 池；system 和 tools 是独立测量的。
 *
 * 面试要点：
 * - 为什么需要 reserveRatio 5%？防止 token 估算误差 + streaming buffer
 * - 为什么大窗口 historyRatio 更高？system prompt 大小相对固定，
 *   更大的窗口意味着更多的空间给对话历史
 */

export interface ContextBudgetRatios {
  readonly systemRatio: number;
  readonly toolsRatio: number;
  readonly historyRatio: number;
  readonly reserveRatio: number;
}

/** ≤500K 上下文窗口的默认比例 */
export const DEFAULT_BUDGET_RATIOS: ContextBudgetRatios = {
  systemRatio: 0.12,
  toolsRatio: 0.08,
  historyRatio: 0.75,
  reserveRatio: 0.05,
};

/** 超大型上下文模型（如 1M）的扩展 history 比例 */
export const LARGE_WINDOW_BUDGET_RATIOS: ContextBudgetRatios = {
  systemRatio: 0.08,
  toolsRatio: 0.07,
  historyRatio: 0.85,
  reserveRatio: 0.05,
};

export interface ContextBudgetAllocation {
  readonly totalTokens: number;
  readonly systemBudget: number;
  readonly toolsBudget: number;
  readonly historyBudget: number;
  readonly reserveBudget: number;
}

/** 上下文预算快照：包含分配 + 实际用量 + 超预算标志 + 压缩阈值 */
export interface ContextBudgetSnapshot {
  readonly allocation: ContextBudgetAllocation;
  readonly systemUsed: number;
  readonly toolsUsed: number;
  readonly historyUsed: number;
  readonly totalUsed: number;
  readonly historyOverBudget: boolean;
  readonly systemOverBudget: boolean;
  /** L2 压缩触发阈值：当 historyUsed 超过此值时触发 */
  readonly compactThreshold: number;
}

/** 根据上下文窗口大小选择预算比例 */
export function resolveBudgetRatios(
  contextWindow: number,
): ContextBudgetRatios {
  if (contextWindow >= 500_000) return LARGE_WINDOW_BUDGET_RATIOS;
  return DEFAULT_BUDGET_RATIOS;
}

/** 按比例分配上下文窗口为四个池 */
export function allocateContextBudget(
  contextWindow: number,
  ratios?: ContextBudgetRatios,
): ContextBudgetAllocation {
  const r = ratios ?? resolveBudgetRatios(contextWindow);
  return {
    totalTokens: contextWindow,
    systemBudget: Math.floor(contextWindow * r.systemRatio),
    toolsBudget: Math.floor(contextWindow * r.toolsRatio),
    historyBudget: Math.floor(contextWindow * r.historyRatio),
    reserveBudget: Math.floor(contextWindow * r.reserveRatio),
  };
}

/**
 * 测量当前上下文使用情况，生成快照。
 *
 * compactThreshold 的计算：
 * historyBudget * 0.7 - 10_000 token buffer
 * 即：当 history 用了预算的 70% 以上时触发压缩。
 */
export function measureContextBudget(opts: {
  readonly contextWindow: number;
  readonly systemTokens: number;
  readonly toolsTokens: number;
  readonly historyTokens: number;
  readonly compactThresholdRatio?: number;
  readonly compactBufferTokens?: number;
  readonly ratios?: ContextBudgetRatios;
}): ContextBudgetSnapshot {
  const allocation = allocateContextBudget(opts.contextWindow, opts.ratios);
  const thresholdRatio = opts.compactThresholdRatio ?? 0.7;
  const bufferTokens = opts.compactBufferTokens ?? 10_000;
  const compactThreshold = Math.max(
    0,
    Math.floor(allocation.historyBudget * thresholdRatio - bufferTokens),
  );

  return {
    allocation,
    systemUsed: opts.systemTokens,
    toolsUsed: opts.toolsTokens,
    historyUsed: opts.historyTokens,
    totalUsed: opts.systemTokens + opts.toolsTokens + opts.historyTokens,
    historyOverBudget: opts.historyTokens > allocation.historyBudget,
    systemOverBudget: opts.systemTokens > allocation.systemBudget,
    compactThreshold,
  };
}

/** 判断是否应该压缩 history */
export function shouldCompactHistory(snapshot: ContextBudgetSnapshot): boolean {
  return snapshot.historyUsed > snapshot.compactThreshold;
}

/** System prompt 中 top-1 记忆 Detail 块保留的 token 数 */
export const MEMORY_INJECTION_DETAIL_TOKENS = 300;

/** 使用 chars/4 启发式算法将文本截断到约 maxTokens。 */
export function truncateTextToTokenBudget(
  text: string,
  maxTokens: number,
): string {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 20)}\n...(truncated)`;
}
