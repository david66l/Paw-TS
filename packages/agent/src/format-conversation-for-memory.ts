/**
 * Format chat history for the memory extraction sub-agent.
 * Skips system prompt (tool catalog) to keep the extraction payload focused.
 */

import type { ChatMessage } from "@paw/models";

export function formatConversationForMemoryExtraction(
  messages: readonly ChatMessage[],
): string {
  const blocks: string[] = [];
  for (const msg of messages) {
    if (msg.role === "system") continue;
    const content = msg.content.trim();
    if (!content) continue;
    const label = msg.role === "user" ? "User" : "Assistant";
    blocks.push(`[${label}]\n${content}`);
  }
  return blocks.join("\n\n");
}

/** Skip extraction when there is nothing beyond a bare system + goal. */
export function shouldAttemptMemoryExtraction(
  messages: readonly ChatMessage[],
): boolean {
  const nonSystem = messages.filter(
    (m) => m.role !== "system" && m.content.trim().length > 0,
  );
  return nonSystem.length >= 2;
}
