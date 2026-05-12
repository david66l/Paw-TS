/**
 * Structured model ↔ orchestrator contract (architecture v2 §8.5).
 * Aligns with Python `paw.agent.actions` (`ToolCallAction`, `FinalAnswerAction`, …).
 *
 * Tool invocation JSON uses field `tool` (harness id) or `name` (Python dataclass name).
 */

export type AgentAction =
  | AgentToolCallAction
  | AgentFinalAnswerAction
  | AgentAskUserAction
  | AgentPlanUpdateAction
  | AgentAbortAction;

export interface AgentToolCallAction {
  readonly type: "tool_call";
  /** Harness tool id (e.g. `workspace.list_dir`). */
  readonly tool: string;
  readonly args: Record<string, unknown>;
}

export interface AgentFinalAnswerAction {
  readonly type: "final_answer";
  readonly summary: string;
}

export interface AgentAskUserAction {
  readonly type: "ask_user";
  readonly question: string;
  readonly context: Record<string, unknown>;
  readonly timeoutSec: number | null;
}

export interface AgentPlanUpdateAction {
  readonly type: "plan_update";
  readonly newItems: readonly unknown[];
  readonly deprecatedItems: readonly string[];
  readonly reason: string;
}

export interface AgentAbortAction {
  readonly type: "abort";
  readonly reason: string;
  readonly canResume: boolean;
}
