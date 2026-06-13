/**
 * Test suite types for the eval system.
 *
 * Test cases define the goal (what the agent is asked to do),
 * expected behaviors (rules and/or LLM judgement criteria),
 * and metadata for categorization.
 */

// ── Dimensions ──

export type EvalDimension =
  | "correctness"
  | "safety"
  | "conciseness"
  | "helpfulness"
  | "compliance"
  | "accuracy"
  | "completeness"
  | "expertise"
  | "fluency";

// ── Categories ──

export type TestCategory = "core" | "edge" | "adversarial" | "high_freq";

export type AgentCapability =
  | "tool_calling"
  | "context_management"
  | "memory_retrieval"
  | "shell_safety"
  | "code_generation"
  | "multi_step";

// ── Rule types ──

export type RuleType =
  | "tool_called"
  | "tool_not_called"
  | "tool_args_match"
  | "shell_command_matches"
  | "file_created"
  | "file_contains"
  | "output_contains"
  | "output_not_contains"
  | "output_matches_regex"
  | "no_error";

/** Parameter shape varies by rule type. */
export type RuleParams =
  | { tool: string }
  | { tool: string; path?: string }
  | { pattern: string }
  | { path: string }
  | { text: string }
  | { regex: string }
  | Record<string, unknown>;

export interface RuleSpec {
  readonly type: RuleType;
  readonly params: RuleParams;
  readonly description?: string;
}

// ── LLM judgement config ──

export interface LlmJudgment {
  readonly dimensions?: EvalDimension[];
  readonly referenceAnswer?: string;
  readonly keyPoints?: string[];
  readonly antiPatterns?: string[];
}

// ── Test case ──

export interface TestCase {
  readonly id: string;
  readonly category: TestCategory;
  readonly capability: AgentCapability;
  readonly name: string;
  /** Natural-language goal given to the agent. */
  readonly goal: string;
  /** Optional setup: files to create, env vars to set. */
  readonly context?: {
    readonly files?: Record<string, string>;
    readonly env?: Record<string, string>;
  };
  readonly expected: {
    readonly rules?: RuleSpec[];
    readonly llmJudgment?: LlmJudgment;
  };
  readonly difficulty?: number; // 1-10
  readonly tags?: string[];
}

// ── Test suite ──

export interface TestSuite {
  readonly name: string;
  readonly description: string;
  readonly cases: TestCase[];
}
