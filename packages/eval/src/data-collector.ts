/**
 * EvalDataCollector — implements EvalHooks to capture full-turn traces.
 *
 * Usage:
 *   const collector = new EvalDataCollector(testCaseId, repIndex, runId, goal, modelLabel)
 *   const orchestrator = new AgentOrchestrator({ evalHooks: collector })
 *   // ... run completes ...
 *   const record = collector.finalize(status, finalAnswer)
 */

import type { EvalHooks, ChatMessage, ContextManager } from "@paw/core";
import type {
  EvalRunRecord,
  EvalTurnRecord,
  EvalToolExecution,
} from "./eval-record.js";

/** Mutable builder for assembling an EvalTurnRecord incrementally. */
interface TurnBuilder {
  turnIndex: number;
  modelInput?: EvalTurnRecord["modelInput"];
  modelOutput?: EvalTurnRecord["modelOutput"];
  contextSnapshot?: EvalTurnRecord["contextSnapshot"];
  toolExecutions: EvalTurnRecord["toolExecutions"];
}

export class EvalDataCollector implements EvalHooks {
  private readonly turns: EvalTurnRecord[] = [];
  private currentTurn: TurnBuilder = { turnIndex: 0, toolExecutions: [] };
  private readonly runStartTime: number;

  constructor(
    private readonly testCaseId: string,
    private readonly repetitionIndex: number,
    private readonly runId: string,
    private readonly goal: string,
    private readonly modelLabel: string,
  ) {
    this.runStartTime = Date.now();
  }

  // ── EvalHooks implementation ──

  beforeModelCall(input: {
    readonly messages: readonly ChatMessage[];
    readonly contextManager: ContextManager;
  }): void {
    // Flush previous turn if it has meaningful data
    this.flushTurn();

    const systemMsg = input.messages.find((m) => m.role === "system");
    const cm = input.contextManager;

    this.currentTurn = {
      turnIndex: this.turns.length,
      modelInput: {
        messageCount: input.messages.length,
        systemPrompt: systemMsg?.content,
        estimatedTokens: cm.estimatedTokens,
      },
      contextSnapshot: {
        historyTokens: cm.historyEstimatedTokens,
        systemTokens: cm.systemEstimatedTokens,
        totalTokens: cm.estimatedTokens,
        messageCount: cm.length,
      },
      toolExecutions: [],
    };
  }

  afterModelCall(output: {
    readonly turnIndex: number;
    readonly responseText: string;
    readonly thinking?: string;
    readonly toolCalls?: readonly { tool: string; args: unknown }[];
    readonly usage?: { promptTokens?: number; completionTokens?: number };
    readonly latencyMs: number;
  }): void {
    const turn = this.currentTurn;
    if (!turn) return;

    turn.modelOutput = {
      rawText: output.responseText,
      thinking: output.thinking,
      toolCalls: output.toolCalls,
      usage: output.usage,
      latencyMs: output.latencyMs,
    };
  }

  afterToolCall(call: {
    readonly tool: string;
    readonly args: unknown;
    readonly result: string;
    readonly ok: boolean;
    readonly durationMs: number;
  }): void {
    const exec: EvalToolExecution = {
      tool: call.tool,
      args: call.args,
      result: call.result,
      ok: call.ok,
      durationMs: call.durationMs,
    };

    const turn = this.currentTurn;
    if (turn && turn.toolExecutions) {
      turn.toolExecutions.push(exec);
    }
  }

  // ── Finalize ──

  /**
   * Flush the current turn (if any) and freeze the run record.
   * Call after the orchestrator run completes.
   */
  finalize(
    status: EvalRunRecord["status"],
    finalAnswer?: string,
    error?: string,
  ): EvalRunRecord {
    // Flush any pending turn
    this.flushTurn();

    return {
      testCaseId: this.testCaseId,
      repetitionIndex: this.repetitionIndex,
      runId: this.runId,
      goal: this.goal,
      modelLabel: this.modelLabel,
      status,
      finalAnswer,
      error,
      turns: [...this.turns],
      durationMs: Date.now() - this.runStartTime,
      expected: undefined, // set by runner after collection
    };
  }

  /** Called internally to finalize the current turn and start a new one. */
  private flushTurn(): void {
    const turn = this.currentTurn;
    if (
      !turn ||
      turn.modelInput === undefined ||
      turn.modelOutput === undefined
    ) {
      return; // nothing meaningful to save
    }

    this.turns.push({
      turnIndex: turn.turnIndex ?? this.turns.length,
      modelInput: turn.modelInput,
      modelOutput: turn.modelOutput,
      toolExecutions: turn.toolExecutions ?? [],
      contextSnapshot: turn.contextSnapshot ?? {
        historyTokens: 0,
        systemTokens: 0,
        totalTokens: 0,
        messageCount: 0,
      },
    });

    this.currentTurn = { turnIndex: this.turns.length, toolExecutions: [] };
  }
}
