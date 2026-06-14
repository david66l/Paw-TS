/**
 * Training data exporter — converts successful eval runs to ChatML JSONL
 * for fine-tuning models on the paw-ts tool-calling format.
 */

import type { EvalRunRecord } from "./eval-record.js";
import type { AggregateScoreReport } from "./scorer/types.js";

export interface ChatMLMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
}

export interface ChatMLConversation {
  readonly messages: readonly ChatMLMessage[];
}

/**
 * Reconstruct a ChatML conversation from an eval run record.
 * Uses captured model inputs/outputs and tool executions to build
 * the full conversation trace.
 */
export function runToChatML(record: EvalRunRecord): ChatMLConversation {
  const messages: ChatMLMessage[] = [];

  // Extract system prompt from the first turn's model input
  if (record.turns.length > 0) {
    const firstTurn = record.turns[0]!;
    if (firstTurn.modelInput.systemPrompt) {
      messages.push({
        role: "system",
        content: firstTurn.modelInput.systemPrompt,
      });
    }
  }

  // User goal
  messages.push({
    role: "user",
    content: record.goal,
  });

  // Reconstruct the tool-calling conversation turn by turn
  for (const turn of record.turns) {
    // Assistant response: the raw model output with tool calls or final answer
    if (turn.modelOutput.rawText) {
      messages.push({
        role: "assistant",
        content: turn.modelOutput.rawText,
      });
    }

    // Tool results
    for (const exec of turn.toolExecutions) {
      const toolContent = `[Tool ${exec.tool} ${exec.ok ? "completed" : "failed"}]\n${exec.result}`;
      messages.push({
        role: "tool",
        content: toolContent,
      });
    }
  }

  // Final answer (if the last turn doesn't already contain it)
  if (record.finalAnswer) {
    const lastMsg = messages[messages.length - 1];
    const lastContent = lastMsg?.content ?? "";
    if (
      lastMsg?.role !== "assistant" ||
      !lastContent.includes('"action":"final_answer"')
    ) {
      // Append final answer if not already captured
      const prevAssistant = messages.filter((m) => m.role === "assistant");
      if (
        !prevAssistant.some((m) =>
          m.content.includes('"action":"final_answer"'),
        )
      ) {
        messages.push({
          role: "assistant",
          content: `{"action":"final_answer","summary":${JSON.stringify(record.finalAnswer)}}`,
        });
      }
    }
  }

  return { messages };
}

/**
 * Export all successful runs from an eval result as ChatML JSONL.
 *
 * @param records All eval run records
 * @param reports Aggregate reports (to filter by pass/fail)
 * @param passThreshold Minimum score to include (default 70)
 */
export function exportSuccessfulRuns(
  records: readonly EvalRunRecord[],
  reports: readonly AggregateScoreReport[],
  passThreshold = 70,
): ChatMLConversation[] {
  const passedIds = new Set(
    reports.filter((r) => r.overallScore >= passThreshold).map((r) => r.testCaseId),
  );

  return records
    .filter((r) => r.status === "completed" && passedIds.has(r.testCaseId))
    .map(runToChatML);
}

/**
 * Serialize conversations to JSONL string.
 */
export function toJsonl(conversations: readonly ChatMLConversation[]): string {
  return conversations
    .map((c) => JSON.stringify({ messages: c.messages }))
    .join("\n");
}
