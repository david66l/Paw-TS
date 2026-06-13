/**
 * Token-cost tracking per model and per run.
 * Supports cache-hit / cache-miss input pricing (DeepSeek) and USD models.
 */

export type CostCurrency = "CNY" | "USD";

export interface ModelPricing {
  readonly currency?: CostCurrency;
  /** Input tokens served from prefix cache (per 1M). */
  readonly promptCacheHitPer1M?: number;
  /** Input tokens not served from cache (per 1M). */
  readonly promptCacheMissPer1M?: number;
  /** Legacy flat input rate — treated as cache-miss when split rates omitted. */
  readonly promptPer1M?: number;
  readonly completionPer1M: number;
}

export interface CostSnapshot {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly estimatedCost: number;
  readonly costCurrency: CostCurrency;
  /** @deprecated Same value as estimatedCost; name kept for older callers. */
  readonly estimatedCostUsd: number;
}

export interface UsageRecord {
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly cachedPromptTokens?: number;
}

/** DeepSeek official CNY / 1M tokens — V4-Flash vs V4-Pro price tiers. */
const DEEPSEEK_V4_FLASH: ModelPricing = {
  currency: "CNY",
  promptCacheHitPer1M: 0.02,
  promptCacheMissPer1M: 1,
  completionPer1M: 2,
};

const DEEPSEEK_V4_PRO: ModelPricing = {
  currency: "CNY",
  promptCacheHitPer1M: 0.025,
  promptCacheMissPer1M: 3,
  completionPer1M: 6,
};

const DEEPSEEK_STANDARD: ModelPricing = {
  currency: "CNY",
  promptCacheHitPer1M: 0.02,
  promptCacheMissPer1M: 1,
  completionPer1M: 2,
};

const DEEPSEEK_PRICING: Record<string, ModelPricing> = {
  "deepseek-v4-flash": DEEPSEEK_V4_FLASH,
  "deepseek-v4-pro": DEEPSEEK_V4_PRO,
  "deepseek-chat": DEEPSEEK_STANDARD,
  "deepseek-v3": DEEPSEEK_STANDARD,
  "deepseek-reasoner": DEEPSEEK_STANDARD,
};

const DEFAULT_PRICING: Record<string, ModelPricing> = {
  "claude-sonnet-4-6": {
    currency: "USD",
    promptPer1M: 3.0,
    completionPer1M: 15.0,
  },
  "claude-opus-4-7": {
    currency: "USD",
    promptPer1M: 15.0,
    completionPer1M: 75.0,
  },
  "claude-haiku-4-5": {
    currency: "USD",
    promptPer1M: 0.8,
    completionPer1M: 4.0,
  },
  "gpt-4o": { currency: "USD", promptPer1M: 2.5, completionPer1M: 10.0 },
  "gpt-4o-mini": {
    currency: "USD",
    promptPer1M: 0.15,
    completionPer1M: 0.6,
  },
  "gpt-4.5": { currency: "USD", promptPer1M: 75.0, completionPer1M: 150.0 },
  "o3-mini": { currency: "USD", promptPer1M: 1.1, completionPer1M: 4.4 },
};

function normalizeModelKey(modelLabel: string): string {
  const trimmed = modelLabel.trim().toLowerCase();
  const colon = trimmed.lastIndexOf(":");
  return colon >= 0 ? trimmed.slice(colon + 1) : trimmed;
}

function resolveRates(pricing: ModelPricing): {
  currency: CostCurrency;
  hit: number;
  miss: number;
  completion: number;
} {
  const currency = pricing.currency ?? "USD";
  const miss = pricing.promptCacheMissPer1M ?? pricing.promptPer1M ?? 0;
  const hit = pricing.promptCacheHitPer1M ?? miss;
  return {
    currency,
    hit,
    miss,
    completion: pricing.completionPer1M,
  };
}

export function resolveModelPricing(
  modelLabel: string,
  custom: Record<string, ModelPricing> = DEFAULT_PRICING,
): ModelPricing {
  const key = normalizeModelKey(modelLabel);
  if (DEEPSEEK_PRICING[key]) return DEEPSEEK_PRICING[key]!;
  if (key.includes("deepseek")) {
    if (key.includes("pro")) return DEEPSEEK_V4_PRO;
    if (key.includes("flash")) return DEEPSEEK_V4_FLASH;
    return DEEPSEEK_STANDARD;
  }
  if (custom[key]) return custom[key]!;
  for (const [name, pricing] of Object.entries(custom)) {
    if (key.includes(name) || name.includes(key)) return pricing;
  }
  return {
    currency: "USD",
    promptPer1M:
      Object.values(custom).reduce(
        (sum, p) => sum + (p.promptCacheMissPer1M ?? p.promptPer1M ?? 0),
        0,
      ) / Math.max(Object.values(custom).length, 1),
    completionPer1M:
      Object.values(custom).reduce((sum, p) => sum + p.completionPer1M, 0) /
      Math.max(Object.values(custom).length, 1),
  };
}

export function estimateUsageCost(
  modelLabel: string,
  usage: UsageRecord,
  custom?: Record<string, ModelPricing>,
): { cost: number; currency: CostCurrency } {
  const pricing = resolveModelPricing(modelLabel, custom ?? DEFAULT_PRICING);
  const { currency, hit, miss, completion } = resolveRates(pricing);
  const prompt = usage.promptTokens ?? 0;
  const cached = Math.min(Math.max(usage.cachedPromptTokens ?? 0, 0), prompt);
  const uncached = prompt - cached;
  const completionTokens = usage.completionTokens ?? 0;
  const cost =
    (cached / 1_000_000) * hit +
    (uncached / 1_000_000) * miss +
    (completionTokens / 1_000_000) * completion;
  return {
    cost: Math.round(cost * 1_000_000) / 1_000_000,
    currency,
  };
}

/**
 * Accumulates token usage and estimates cost.
 * Thread-safe for single-process use (no async state).
 */
export class CostTracker {
  private readonly pricing: Record<string, ModelPricing>;
  private promptTokens = 0;
  private completionTokens = 0;
  private totalCost = 0;
  private costCurrency: CostCurrency = "USD";

  constructor(opts?: { readonly pricing?: Record<string, ModelPricing> }) {
    this.pricing = opts?.pricing ?? { ...DEFAULT_PRICING };
  }

  /** Record usage from a single model turn. */
  record(modelLabel: string, usage: UsageRecord): void {
    const { cost, currency } = estimateUsageCost(
      modelLabel,
      usage,
      this.pricing,
    );
    this.totalCost += cost;
    this.costCurrency = currency;
    if (usage.promptTokens) {
      this.promptTokens += usage.promptTokens;
    }
    if (usage.completionTokens) {
      this.completionTokens += usage.completionTokens;
    }
  }

  /** Current snapshot. */
  snapshot(): CostSnapshot {
    const totalTokens = this.promptTokens + this.completionTokens;
    const estimatedCost =
      Math.round(this.totalCost * 1_000_000) / 1_000_000;
    return {
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      totalTokens,
      estimatedCost,
      costCurrency: this.costCurrency,
      estimatedCostUsd: estimatedCost,
    };
  }

  /** Reset counters. */
  reset(): void {
    this.promptTokens = 0;
    this.completionTokens = 0;
    this.totalCost = 0;
    this.costCurrency = "USD";
  }

  /** Human-readable summary. */
  summary(): string {
    const s = this.snapshot();
    const sym = s.costCurrency === "CNY" ? "¥" : "$";
    return `${s.totalTokens.toLocaleString()} tokens (~${sym}${s.estimatedCost.toFixed(4)})`;
  }
}
