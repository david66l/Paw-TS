/**
 * Orchestrator constants: Multi-Agent limits, event filters, context budgets.
 */

import type { AgentToolCallAction } from "@paw/core";

/** Multi-Agent concurrency limits. */
export const MULTI_AGENT_LIMITS = {
  /** Max child agents launched in a single turn. */
  maxChildrenPerTurn: 3,
  /** Max nesting depth (0 = parent, 1 = child). */
  maxChildDepth: 1,
  /** Max steps per child agent. */
  maxChildSteps: 5,
} as const;

/** Child agent file-access policy. */
export const CHILD_AGENT_POLICIES = {
  /** Default: child agents are read-only in v1. */
  default: "read_only" as const,
  /** Max bytes a child agent can write in a single operation. */
  maxWriteSize: 100_000,
} as const;

/** SharedContext hard token budget. */
export const SHARED_CONTEXT_BUDGET = {
  /** Total token limit for the structured summary passed to a child agent. */
  maxSharedContextTokens: 2_000,
  /** Max bytes per artifact. */
  maxArtifactBytes: 50_000,
  /** Max number of artifacts. */
  maxArtifacts: 10,
  /** Max number of facts. */
  maxFacts: 20,
  /** Max number of constraints. */
  maxConstraints: 10,
} as const;

/**
 * Events that are forwarded from child agents to the parent event stream.
 * High-frequency events (model.chunk, loop.tick) are filtered out.
 */
export const PARENT_FORWARD_EVENTS = new Set([
  "child.started",
  "child.phase_changed",
  "child.tool_call",
  "child.tool_result",
  "child.completed",
  "child.failed",
  "child.cancelled",
]);

/** Canonical tool name for launching a sub-agent. */
export const SUB_AGENT_TOOL_NAME = "workspace.run_agent" as const;

/** Centralised predicate: is this tool call a sub-agent launch? */
export function isSubAgentCall(call: AgentToolCallAction): boolean {
  return call.tool === SUB_AGENT_TOOL_NAME;
}
