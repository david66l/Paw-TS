/**
 * Context budget — pool allocation for system / tools / history / reserve.
 *
 * L1/L2 compression triggers use the history pool only; system and tool
 * definitions are measured separately at run time.
 */

export interface ContextBudgetRatios {
  readonly systemRatio: number;
  readonly toolsRatio: number;
  readonly historyRatio: number;
  readonly reserveRatio: number;
}

/** Default ratios for ≤500K context windows. */
export const DEFAULT_BUDGET_RATIOS: ContextBudgetRatios = {
  systemRatio: 0.12,
  toolsRatio: 0.08,
  historyRatio: 0.75,
  reserveRatio: 0.05,
};

/** Wider history pool for very large context models (e.g. 1M). */
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

export interface ContextBudgetSnapshot {
  readonly allocation: ContextBudgetAllocation;
  readonly systemUsed: number;
  readonly toolsUsed: number;
  readonly historyUsed: number;
  readonly totalUsed: number;
  readonly historyOverBudget: boolean;
  readonly systemOverBudget: boolean;
  /** L2 compact triggers when historyUsed exceeds this. */
  readonly compactThreshold: number;
}

export function resolveBudgetRatios(
  contextWindow: number,
): ContextBudgetRatios {
  if (contextWindow >= 500_000) return LARGE_WINDOW_BUDGET_RATIOS;
  return DEFAULT_BUDGET_RATIOS;
}

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

export function shouldCompactHistory(snapshot: ContextBudgetSnapshot): boolean {
  return snapshot.historyUsed > snapshot.compactThreshold;
}

/** Tokens reserved for top-1 memory Detail block in system prompt. */
export const MEMORY_INJECTION_DETAIL_TOKENS = 300;

/** Truncate text to roughly `maxTokens` using chars/4 heuristic. */
export function truncateTextToTokenBudget(
  text: string,
  maxTokens: number,
): string {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 20)}\n...(truncated)`;
}
