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
 * - historyRatio：68% 或 73%
 * - reserveRatio：12%（v3 P1.4：5% → 12%，低估保护）
 *
 * L1/L2 压缩触发只监控 history 池；system 和 tools 是独立测量的。
 *
 * v3 P5.2 压缩阈值（单一口径，本模块为唯一事实来源）：
 *   compactThreshold = 0.8 × historyBudget（纯百分比，无绝对封顶）
 *   - 0.8 软启动线（VISTA ρ=0.8）
 *   - 不设绝对封顶：大窗口模型（1M）本就该更晚触发——窗口大 = 能装更多，
 *     频繁压缩是白花辅助模型钱 + 丢信息；"大窗口不容易触发阈值压缩"是特性
 *     不是 bug，由侧信道 monitor（任务边界触发）与硬守卫兜底
 *
 * 面试要点：
 * - 为什么需要 reserveRatio？防止 token 估算误差 + streaming buffer；
 *   从 5% 提到 12% 是因为低估（低估 → 超窗灾难）比高估（多压缩一次）代价大
 * - 为什么大窗口 historyRatio 更高？system prompt 大小相对固定，
 *   更大的窗口意味着更多的空间给对话历史
 */

export interface ContextBudgetRatios {
  readonly systemRatio: number;
  readonly toolsRatio: number;
  readonly historyRatio: number;
  readonly reserveRatio: number;
}

/** ≤500K 上下文窗口的默认比例（v3：reserve 5% → 12%） */
export const DEFAULT_BUDGET_RATIOS: ContextBudgetRatios = {
  systemRatio: 0.12,
  toolsRatio: 0.08,
  historyRatio: 0.68,
  reserveRatio: 0.12,
};

/** 超大型上下文模型（如 1M）的扩展 history 比例 */
export const LARGE_WINDOW_BUDGET_RATIOS: ContextBudgetRatios = {
  systemRatio: 0.08,
  toolsRatio: 0.07,
  historyRatio: 0.73,
  reserveRatio: 0.12,
};

/** 压缩触发软启动比例（VISTA ρ=0.8） */
export const COMPACT_THRESHOLD_RATIO = 0.8;

/**
 * TokenPilot 定价（相对单位，用于成本记账软指导）：
 * output token 成本 ≈ 60× cache-hit 输入（生成最贵）；
 * cache-miss 输入 ≈ 10× cache-hit。
 */
export const COST_PRICING = {
  readonlyInputCacheHit: 1,
  readonlyInputCacheMiss: 10,
  readonlyOutput: 60,
} as const;

export interface ContextCostEstimate {
  /** 输入成本（相对单位：cache-hit×1 + cache-miss×10） */
  readonly inputCost: number;
  /** 输出成本（相对单位：×60） */
  readonly outputCost: number;
  readonly totalCost: number;
}

/** 按 TokenPilot 定价估算一次模型调用的相对成本 */
export function estimateContextCost(opts: {
  readonly promptTokens: number;
  readonly cachedPromptTokens: number;
  readonly completionTokens?: number;
}): ContextCostEstimate {
  const hit = Math.max(
    0,
    Math.min(opts.cachedPromptTokens, opts.promptTokens),
  );
  const miss = Math.max(0, opts.promptTokens - hit);
  const inputCost =
    hit * COST_PRICING.readonlyInputCacheHit +
    miss * COST_PRICING.readonlyInputCacheMiss;
  const outputCost =
    (opts.completionTokens ?? 0) * COST_PRICING.readonlyOutput;
  return { inputCost, outputCost, totalCost: inputCost + outputCost };
}

/**
 * 成本感知的压缩阈值微调（软指导）：
 * 缓存命中率高 → 前缀宝贵（破坏缓存 = 重新计费 miss×10）→ 放宽阈值、
 * 更晚压缩，少破坏缓存；命中率低 → 正常阈值。
 * 系数 [1.0, 1.25]（命中率 0-100% 线性）。
 */
export function costAdjustedCompactThreshold(
  thresholdTokens: number,
  cacheHitRate: number,
): number {
  if (!Number.isFinite(cacheHitRate) || cacheHitRate <= 0) {
    return thresholdTokens;
  }
  const factor = 1 + Math.min(0.25, cacheHitRate * 0.25);
  return Math.floor(thresholdTokens * factor);
}

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
 * v3 P5.2：压缩触发阈值（单一口径，预算模块为唯一事实来源）。
 *   compactThreshold = 0.8 × historyBudget（纯百分比，无绝对封顶）
 * 0.8 软启动线（VISTA ρ=0.8）；大窗口模型更晚触发是特性——
 * 由侧信道 monitor（任务边界）与硬守卫兜底。
 */
export function computeCompactThreshold(
  historyBudget: number,
  opts?: {
    readonly thresholdRatio?: number;
  },
): number {
  const ratio = opts?.thresholdRatio ?? COMPACT_THRESHOLD_RATIO;
  return Math.max(0, Math.floor(historyBudget * ratio));
}

/**
 * 测量当前上下文使用情况，生成快照。
 *
 * compactThreshold 的计算（v3 单一口径）：
 *   0.8 × historyBudget（纯百分比）
 * 即：当 history 用了预算的 80% 以上时触发压缩（软启动）。
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
  const bufferTokens = opts.compactBufferTokens ?? 10_000;
  const compactThreshold = Math.max(
    0,
    computeCompactThreshold(allocation.historyBudget, {
      thresholdRatio: opts.compactThresholdRatio,
    }) - bufferTokens,
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
