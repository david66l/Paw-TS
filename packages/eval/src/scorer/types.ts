/**
 * Scorer types — score reports, rule results, and judgement output.
 */

import type { EvalDimension } from "../test-suite/types.js";

// ── Rule result ──

export interface RuleResult {
  readonly ruleType: string;
  readonly params: unknown;
  readonly description?: string;
  readonly passed: boolean;
  readonly detail?: string;
}

// ── Dimension score ──

export interface DimensionScore {
  readonly dimension: EvalDimension;
  readonly score: number; // 0–100
  readonly reason?: string;
}

// ── Aggregate score report ──

export interface ScoreReport {
  readonly testCaseId: string;
  readonly repetitionIndex: number;
  /** Weighted overall score 0–100. */
  readonly overallScore: number;
  /** Rule-based sub-score 0–100. */
  readonly ruleScore?: number;
  /** LLM-based sub-score 0–100. */
  readonly llmScore?: number;
  /** Individual rule results. */
  readonly ruleResults: RuleResult[];
  /** Per-dimension LLM scores (when available). */
  readonly dimensionScores?: DimensionScore[];
  /** Whether this meets the pass threshold. */
  readonly passed: boolean;
  /** Human-readable summary. */
  readonly summary: string;
}

// ── Multi-repetition aggregate ──

export interface AggregateScoreReport {
  readonly testCaseId: string;
  readonly repetitionCount: number;
  /** Mean overall score across repetitions. */
  readonly overallScore: number;
  /** Coefficient of variation (std/mu), 0 = perfectly stable. */
  readonly stabilityScore: number;
  readonly minScore: number;
  readonly maxScore: number;
  readonly perRepetition: ScoreReport[];
  readonly passed: boolean;
  readonly summary: string;
}
