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
      /** Estimated total tokens in the current context window. */
      readonly estimatedTokens: number;
    }
  | {
      readonly type: "run.completed";
      readonly status: RunStatus;
      readonly message: string;
    }
  | { readonly type: "run.failed"; readonly message: string }
  | {
      readonly type: "phase";
      readonly name:
        | "plan"
        | "model"
        | "tool"
        | "parse"
        | "waiting_children"
        | "merging_results";
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
      readonly costCurrency?: "CNY" | "USD";
      /** Tokens billed for the latest model call only. */
      readonly turnPromptTokens?: number;
      readonly turnCompletionTokens?: number;
      /** Prompt tokens served from the provider's prefix cache. */
      readonly cachedPromptTokens?: number;
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
  /** Per-pool context budget snapshot (system / tools / history). */
  | {
      readonly type: "context.budget";
      readonly contextWindow: number;
      readonly systemUsed: number;
      readonly systemBudget: number;
      readonly toolsUsed: number;
      readonly toolsBudget: number;
      readonly historyUsed: number;
      readonly historyBudget: number;
      readonly historyOverBudget: boolean;
      readonly systemOverBudget: boolean;
      readonly compactThreshold: number;
    }
  /** System prompt was trimmed to fit the system token budget. */
  | {
      readonly type: "context.budget.trimmed";
      readonly sections: readonly string[];
      readonly freedTokens: number;
    }
  /** Memory extraction agent saved new entries. */
  | {
      readonly type: "memory.extracted";
      readonly entries: number;
      readonly rejected: number;
      readonly runId: string;
    }
  /** Memory entry was rejected by the sensitive-info scanner. */
  | {
      readonly type: "memory.rejected";
      readonly entry: string;
      readonly reason: string;
      readonly runId: string;
    }
  /** Memory retrieval completed before system prompt construction. */
  | {
      readonly type: "memory.retrieve.done";
      readonly query: string;
      readonly totalCandidates: number;
      readonly selectedCount: number;
      readonly scores: readonly number[];
      readonly injectedTokens: number;
      readonly retrievalMode?: "keyword" | "cascade";
      readonly embeddingCacheHits?: number;
      readonly embeddingCacheMisses?: number;
      readonly usedLlmFallback?: boolean;
      readonly selectedMemories: readonly {
        readonly id: string;
        readonly title: string;
        readonly source: string;
        readonly summary: string;
        readonly relatedFiles: readonly string[];
      }[];
    }
  /** Model output was truncated (finish_reason = length/max_tokens). */
  | {
      readonly type: "model.truncated";
      readonly finishReason: string;
    }
  /** Orchestrator is retrying a transient LLM API failure. */
  | {
      readonly type: "model.retry.waiting";
      readonly attempt: number;
      readonly delayMs: number;
      readonly error: string;
      readonly errorType?: string;
    }
  /** Circuit breaker opened after repeated model failures. */
  | {
      readonly type: "model.circuit_breaker.open";
      readonly label: string;
      readonly failures: number;
    }
  /** Circuit breaker moved to half-open (probing). */
  | {
      readonly type: "model.circuit_breaker.half_open";
      readonly label: string;
    }
  /** Circuit breaker closed after a successful probe. */
  | {
      readonly type: "model.circuit_breaker.closed";
      readonly label: string;
    }
  /** MCP server connection failed; run continues without it. */
  | {
      readonly type: "mcp.connection_failed";
      readonly server: string;
      readonly error: string;
    }
  /** Run efficiency and quality metrics emitted at completion. */
  | {
      readonly type: "run.metrics";
      readonly durationMs: number;
      readonly modelLatencyMs: number;
      readonly modelCalls: number;
      readonly toolCalls: number;
      readonly toolSuccesses: number;
      readonly totalTokens: number;
      readonly estimatedCost: number;
      readonly costCurrency: "CNY" | "USD";
      readonly steps: number;
      readonly truncationCount: number;
    };

export interface RunEventEnvelope {
  readonly runId: string;
  /** Monotonic per run, starting at 1. */
  readonly seq: number;
  readonly ts: number;
  readonly event: RunEvent;
}
