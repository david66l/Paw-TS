import type { ToolRunResult } from "@paw/harness";

/** Trusted, caller-supplied policy evaluated before any tool side effect. */

export interface ToolExecutionPolicyInput {
  readonly tool: string;
  readonly args: unknown;
  readonly workspaceRoot: string;
}

export type ToolExecutionPolicyDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      /** Stable machine-readable reason, safe to persist in traces. */
      readonly reason: string;
      /** Actionable model-facing explanation. */
      readonly message: string;
    };

export type ToolExecutionPolicy = (
  input: ToolExecutionPolicyInput,
) => ToolExecutionPolicyDecision | Promise<ToolExecutionPolicyDecision>;

export interface ToolEffectPolicyInput extends ToolExecutionPolicyInput {
  readonly result: ToolRunResult;
}

export type ToolEffectPolicyDecision =
  | {
      readonly allowed: true;
      /** Optional trusted enrichment/rewrite before state and context consume it. */
      readonly result?: ToolRunResult;
    }
  | {
      readonly allowed: false;
      /** Stable machine-readable reason, safe to persist in traces. */
      readonly reason: string;
      /** Actionable model-facing explanation. */
      readonly message: string;
      /** Whether the policy restored every prohibited workspace effect. */
      readonly recovered: boolean;
    };

/**
 * Trusted lifecycle policy for effects that cannot be known from tool args.
 *
 * `prepare` runs immediately before the tool. `settle` runs after the raw tool
 * result but before TaskState, memory, idle-fuse, events, or model context see
 * it. Callers may use the opaque preparation value for a before/after audit.
 */
export interface ToolEffectPolicy {
  /** Defaults to every tool. Use this to avoid snapshots for known-safe tools. */
  appliesTo?(input: ToolExecutionPolicyInput): boolean;
  prepare(input: ToolExecutionPolicyInput): unknown | Promise<unknown>;
  settle(
    input: ToolEffectPolicyInput,
    prepared: unknown,
  ): ToolEffectPolicyDecision | Promise<ToolEffectPolicyDecision>;
}
