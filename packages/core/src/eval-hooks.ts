/**
 * EvalHooks — optional callbacks for collecting evaluation traces.
 *
 * These are the ONLY hooks the eval system needs from the orchestrator.
 * They capture model input/output and tool execution data without
 * modifying the orchestrator's control flow.
 *
 * Implementations (e.g. EvalDataCollector) receive these callbacks and
 * accumulate trace data for later scoring.
 */

import type { ChatMessage, ContextManager } from "./context-manager.js";

export interface EvalHooks {
  /**
   * Called immediately before invokeModel().
   * Captures the full messages array and context manager state snapshot.
   */
  readonly beforeModelCall?: (input: {
    readonly messages: readonly ChatMessage[];
    readonly contextManager: ContextManager;
  }) => void;

  /**
   * Called after model response is received and parsed.
   * Captures response text, thinking, tool calls, usage, and latency.
   */
  readonly afterModelCall?: (output: {
    readonly turnIndex: number;
    readonly responseText: string;
    readonly thinking?: string;
    readonly toolCalls?: readonly { tool: string; args: unknown }[];
    readonly usage?: { promptTokens?: number; completionTokens?: number };
    readonly latencyMs: number;
  }) => void;

  /**
   * Called after each tool execution completes.
   * Captures tool name, arguments, result, success status, and duration.
   */
  readonly afterToolCall?: (call: {
    readonly tool: string;
    readonly args: unknown;
    readonly result: string;
    readonly ok: boolean;
    readonly durationMs: number;
  }) => void;
}
