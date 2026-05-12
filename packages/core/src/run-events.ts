/**
 * Run lifecycle events — canonical stream for TUI / logs / replay (TS path).
 * Version conservatively; add fields as new phases land.
 */

import type { AgentAction } from "./actions.js";
import type { RunStatus } from "./run.js";
import type { ModelTokenUsage } from "./token-usage.js";

export type RunEvent =
  | { readonly type: "run.started"; readonly goal: string }
  | {
      readonly type: "loop.tick";
      readonly turn: number;
      readonly maxSteps: number;
    }
  | {
      readonly type: "run.completed";
      readonly status: RunStatus;
      readonly message: string;
    }
  | { readonly type: "run.failed"; readonly message: string }
  | {
      readonly type: "phase";
      readonly name: "plan" | "model" | "tool" | "parse";
    }
  /** Parsed structured outcome (V2 §8.5) before orchestrator branches. */
  | { readonly type: "agent.action"; readonly action: AgentAction }
  | {
      readonly type: "model.request";
      readonly label: string;
      readonly messageCount: number;
    }
  /** Accumulated assistant text so far (streaming or single-shot). */
  | { readonly type: "model.chunk"; readonly text: string }
  /** Accumulated thinking/reasoning text so far (streaming). */
  | { readonly type: "model.thinking"; readonly text: string }
  | {
      readonly type: "model.done";
      readonly text: string;
      readonly usage?: ModelTokenUsage;
      readonly thinking?: string;
    }
  /** Orchestrator will await {@link AgentOrchestratorOptions.resolveAskUser}. */
  | {
      readonly type: "user.reply.required";
      readonly question: string;
      readonly timeoutSec: number | null;
    }
  | {
      readonly type: "tool.call";
      readonly tool: string;
      readonly args: unknown;
    }
  | {
      readonly type: "tool.result";
      readonly tool: string;
      readonly ok: boolean;
      readonly summary: string;
      readonly detail?: string;
    }
  | {
      readonly type: "tool.result.chunk";
      readonly tool: string;
      readonly chunk: string;
      readonly isStderr: boolean;
    }
  | {
      readonly type: "tool.approval.pending";
      readonly tool: string;
      readonly args: unknown;
    }
  | {
      readonly type: "tool.approval.resolved";
      readonly tool: string;
      readonly approved: boolean;
    }
  /** Token-cost update after a model turn. */
  | {
      readonly type: "cost.update";
      readonly promptTokens: number;
      readonly completionTokens: number;
      readonly totalTokens: number;
      readonly estimatedCostUsd: number;
    }
  /** TaskPlanner applied a {@link AgentPlanUpdateAction} (TS orchestrator). */
  | {
      readonly type: "plan.updated";
      readonly revision: number;
      readonly itemCount: number;
      readonly reason: string;
    }
  /** Layer 1: tool-result pruning completed. */
  | {
      readonly type: "compression.prune.done";
      readonly freedTokens: number;
      readonly remainingTokens: number;
    }
  /** Layer 2/3: auto-compaction started. */
  | {
      readonly type: "compression.auto_compact.started";
      readonly beforeTokens: number;
    }
  /** Layer 2/3: auto-compaction completed. */
  | {
      readonly type: "compression.auto_compact.done";
      readonly afterTokens: number;
      readonly summaryTokens: number;
    }
  /** Compression skipped (e.g. threshold not met or anti-thrashing). */
  | {
      readonly type: "compression.skipped";
      readonly reason: string;
    }
  /** Memory extraction agent saved new entries. */
  | {
      readonly type: "memory.extracted";
      readonly entries: number;
      readonly runId: string;
    };

export interface RunEventEnvelope {
  readonly runId: string;
  /** Monotonic per run, starting at 1. */
  readonly seq: number;
  readonly ts: number;
  readonly event: RunEvent;
}
