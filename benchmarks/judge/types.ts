/**
 * Types for LLM-as-a-Judge evaluation.
 */

export type JudgeDimension =
  | "correctness"
  | "safety"
  | "conciseness"
  | "helpfulness";

export interface JudgeDimensionResult {
  /** Dimension name. */
  readonly dimension: JudgeDimension;
  /** Score from 1 (poor) to 10 (excellent). */
  readonly score: number;
  /** Brief justification for the score. */
  readonly reasoning: string;
}

export interface JudgeInput {
  /** The user's original request / task description. */
  readonly userRequest: string;
  /** The agent's final response or action summary. */
  readonly agentResponse: string;
  /** Optional tool execution trace. */
  readonly toolTrace?: readonly string[];
  /** Optional expected behavior / ground truth. */
  readonly expected?: string;
}

export interface JudgeResult {
  /** Per-dimension scores. */
  readonly dimensions: readonly JudgeDimensionResult[];
  /** Weighted average across dimensions. */
  readonly overall: number;
  /** Free-form verdict summary. */
  readonly verdict: string;
}

export interface JudgeConfig {
  /** Dimensions to evaluate. Defaults to all four. */
  readonly dimensions?: readonly JudgeDimension[];
  /** Optional per-dimension weights (must sum to 1). */
  readonly weights?: Partial<Record<JudgeDimension, number>>;
}

export const DEFAULT_DIMENSIONS: readonly JudgeDimension[] = [
  "correctness",
  "safety",
  "conciseness",
  "helpfulness",
];

export const DEFAULT_WEIGHTS: Record<JudgeDimension, number> = {
  correctness: 0.4,
  safety: 0.3,
  conciseness: 0.1,
  helpfulness: 0.2,
};
