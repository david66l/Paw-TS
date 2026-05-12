/**
 * Token-cost tracking per model and per run.
 * Prices are in USD per 1M tokens.
 */

export interface ModelPricing {
  readonly promptPer1M: number;
  readonly completionPer1M: number;
}

export interface CostSnapshot {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly estimatedCostUsd: number;
}

const DEFAULT_PRICING: Record<string, ModelPricing> = {
  "claude-sonnet-4-6": { promptPer1M: 3.0, completionPer1M: 15.0 },
  "claude-opus-4-7": { promptPer1M: 15.0, completionPer1M: 75.0 },
  "claude-haiku-4-5": { promptPer1M: 0.8, completionPer1M: 4.0 },
  "gpt-4o": { promptPer1M: 2.5, completionPer1M: 10.0 },
  "gpt-4o-mini": { promptPer1M: 0.15, completionPer1M: 0.6 },
  "gpt-4.5": { promptPer1M: 75.0, completionPer1M: 150.0 },
  "o3-mini": { promptPer1M: 1.1, completionPer1M: 4.4 },
};

/**
 * Accumulates token usage and estimates cost.
 * Thread-safe for single-process use (no async state).
 */
export class CostTracker {
  private readonly pricing: Record<string, ModelPricing>;
  private promptTokens = 0;
  private completionTokens = 0;

  constructor(opts?: { readonly pricing?: Record<string, ModelPricing> }) {
    this.pricing = opts?.pricing ?? { ...DEFAULT_PRICING };
  }

  /** Record usage from a single model turn. */
  record(
    _modelLabel: string,
    usage: { readonly promptTokens?: number; readonly completionTokens?: number },
  ): void {
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
    return {
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      totalTokens,
      estimatedCostUsd: this.estimatedCost(),
    };
  }

  /** Reset counters. */
  reset(): void {
    this.promptTokens = 0;
    this.completionTokens = 0;
  }

  private estimatedCost(): number {
    // Use average pricing if no specific model is known
    const prices = Object.values(this.pricing);
    if (prices.length === 0) return 0;
    const avgPrompt =
      prices.reduce((sum, p) => sum + p.promptPer1M, 0) / prices.length;
    const avgCompletion =
      prices.reduce((sum, p) => sum + p.completionPer1M, 0) / prices.length;
    const promptCost = (this.promptTokens / 1_000_000) * avgPrompt;
    const completionCost = (this.completionTokens / 1_000_000) * avgCompletion;
    return Math.round((promptCost + completionCost) * 1_000_000) / 1_000_000;
  }

  /** Human-readable summary. */
  summary(): string {
    const s = this.snapshot();
    return `${s.totalTokens.toLocaleString()} tokens (~$${s.estimatedCostUsd.toFixed(4)})`;
  }
}
