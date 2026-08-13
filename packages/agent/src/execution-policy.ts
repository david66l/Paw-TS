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
