/**
 * EvalSettings — configuration for the eval system.
 * Stored under the "eval" key in .paw/settings.local.json.
 *
 * Uses the passthrough pattern so other keys coexist without conflict.
 */

export interface EvalSettings {
  /** Model label used for LLM judging (defaults to "deepseek-chat"). */
  readonly judge_model?: string;
  /** Number of repetitions per test case (default: 3). */
  readonly default_repetitions?: number;
  /** Max parallel runs (default: 4). */
  readonly parallel_runs?: number;
  /** Weight for rule-based scoring, 0–1 (default: 0.6). */
  readonly rule_weight?: number;
  /** Weight for LLM-based scoring, 0–1 (default: 0.4). */
  readonly llm_weight?: number;
  /** Pass threshold, 0–100 (default: 70). */
  readonly pass_threshold?: number;
}

export const DEFAULT_EVAL_SETTINGS: Required<EvalSettings> = {
  judge_model: "deepseek-chat",
  default_repetitions: 3,
  parallel_runs: 4,
  rule_weight: 0.6,
  llm_weight: 0.4,
  pass_threshold: 70,
};

export function resolveEvalSettings(
  overrides?: Partial<EvalSettings>,
): Required<EvalSettings> {
  return { ...DEFAULT_EVAL_SETTINGS, ...overrides };
}
