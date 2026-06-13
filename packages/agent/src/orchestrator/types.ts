/**
 * Orchestrator type definitions: state machine, flags, contexts.
 */

import type {
  AgentAction,
  AgentToolCallAction,
  ChatMessage,
  ContextManager,
  RunEvent,
  RunEventEnvelope,
} from "@paw/core";
import type { McpClientManager } from "@paw/harness";
import type { LanguageModel, ToolDefinition } from "@paw/models";
import type { TaskPlanner } from "@paw/store";

// ─────────────────────────────────────────────────────────────
// Turn state machine
// ─────────────────────────────────────────────────────────────

/** Explicit state of a single parent-agent turn. */
export type TurnState =
  | { readonly type: "model_calling" }
  | {
      readonly type: "action_dispatch";
      readonly actions: AgentAction[];
      readonly text: string;
      readonly thinking?: string;
    }
  | {
      readonly type: "tool_executing";
      readonly calls: AgentToolCallAction[];
      readonly text: string;
      readonly thinking?: string;
    }
  | {
      readonly type: "waiting_children";
      readonly childIds: readonly string[];
      readonly text: string;
      readonly thinking?: string;
    }
  | {
      readonly type: "merging_results";
      readonly results: SubAgentResult[];
      readonly text: string;
      readonly thinking?: string;
    }
  | {
      readonly type: "user_waiting";
      readonly question: string;
      readonly text: string;
      readonly thinking?: string;
    }
  | {
      readonly type: "plan_updating";
      readonly items: readonly unknown[];
      readonly text: string;
      readonly thinking?: string;
    }
  | { readonly type: "completed"; readonly message: string }
  | { readonly type: "failed"; readonly message: string }
  | { readonly type: "continue"; readonly nextFlags: TurnFlags };

// ─────────────────────────────────────────────────────────────
// Turn flags (immutable replacement for mutable wrappers)
// ─────────────────────────────────────────────────────────────

/** Cross-turn state that is passed functionally each loop. */
export interface TurnFlags {
  readonly autoContinueNudges: number;
  readonly lastTurnHadToolCall: boolean;
  readonly hasEverUsedTools: boolean;
  _maxStepsWarned?: boolean;
}

// ─────────────────────────────────────────────────────────────
// Phase context
// ─────────────────────────────────────────────────────────────

/** Context passed to every phase handler. */
export interface PhaseContext {
  readonly runId: string;
  readonly workspaceRoot: string;
  readonly turn: number;
  readonly maxSteps: number;
  readonly signal?: AbortSignal;
  readonly model: LanguageModel;
  readonly mcp?: McpClientManager;
  readonly toolDefs: readonly ToolDefinition[];
  readonly toolNameMap: Map<string, string>;
  readonly ctxMgr: ContextManager;
  readonly planner: TaskPlanner;
  readonly emit: (event: RunEvent) => void;
  readonly checkpointSeq: { n: number };
  readonly specGoal: string;
  readonly shellSandbox?: import("@paw/harness").ShellSandboxConfig;
}

// ─────────────────────────────────────────────────────────────
// Sub-agent result (concise – only summary flows back to parent context)
// ─────────────────────────────────────────────────────────────

export interface SubAgentArtifact {
  readonly type: "file" | "code" | "test_result" | "search_result";
  readonly path?: string;
  readonly content: string;
  readonly summary: string;
}

export interface SubAgentResult {
  readonly status: "completed" | "failed";
  readonly summary: string;
  readonly findings?: readonly string[];
  readonly changedFiles?: readonly string[];
  readonly testsRun?: readonly {
    readonly name: string;
    readonly passed: boolean;
  }[];
  readonly errors?: readonly string[];
  readonly artifacts?: readonly SubAgentArtifact[];
  /** Full trace for debugging / replay / TUI – NOT injected into parent context. */
  readonly trace?: {
    readonly messages: readonly ChatMessage[];
    readonly events: readonly RunEventEnvelope[];
    readonly stepsTaken: number;
  };
}

// ─────────────────────────────────────────────────────────────
// Shared context (structured summary for child agents)
// ─────────────────────────────────────────────────────────────

export interface ContextArtifact {
  readonly type: "file" | "code" | "url" | "search_result";
  readonly path?: string;
  readonly content: string;
  readonly relevance: "critical" | "relevant" | "reference";
}

export interface SharedContext {
  readonly role: string;
  readonly task: string;
  readonly facts: readonly string[];
  readonly constraints: readonly string[];
  readonly artifacts: readonly ContextArtifact[];
  readonly state: {
    readonly completed: readonly string[];
    readonly pending: readonly string[];
    readonly risks?: readonly string[];
  };
  readonly outputFormat: string;
  readonly parentConclusions?: readonly {
    readonly conclusion: string;
    readonly confidence: "high" | "medium" | "low";
  }[];
  /** v1 default: read_only to avoid concurrent file conflicts. */
  readonly childPolicy?: "read_only" | "read_write";
}

// ─────────────────────────────────────────────────────────────
// Child-agent state (for status tree)
// ─────────────────────────────────────────────────────────────

export type ChildPhase =
  | "queued"
  | "model_calling"
  | "action_dispatch"
  | "tool_executing"
  | "completed"
  | "failed"
  | "cancelled";

export interface ChildAgentState {
  readonly agentId: string;
  readonly goal: string;
  readonly phase: ChildPhase;
  readonly progress: number; // 0-100
  readonly currentTask?: string;
  readonly result?: SubAgentResult;
  readonly error?: string;
}

export interface AgentRunState {
  readonly runId: string;
  readonly phase: string;
  readonly progress: number;
  readonly children?: readonly AgentRunState[];
}

// ─────────────────────────────────────────────────────────────
// Action handler interface
// ─────────────────────────────────────────────────────────────

export interface ActionHandler {
  handle(
    action: AgentAction,
    ctx: PhaseContext,
    flags: TurnFlags,
    text: string,
    thinking: string | undefined,
  ): Promise<{ readonly state: TurnState; readonly flags: TurnFlags }>;
}
