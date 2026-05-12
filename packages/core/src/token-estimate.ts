/**
 * Token estimation heuristic.
 *
 * paw-ts does not ship a tokenizer, so we approximate:
 *   - text: length / 4 (industry-standard heuristic)
 *   - images: fixed 1000 tokens each
 *   - tool schemas / system prompts: counted as text
 *
 * This is intentionally fast and dependency-free.  A future phase
 * may swap in tiktoken for exact counts.
 */

import type { ChatMessage } from "./context-manager.js";

const CHARS_PER_TOKEN = 4;
const IMAGE_TOKEN_ESTIMATE = 1_000;

/**
 * Rough token count for a plain string.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Token count for a single {@link ChatMessage}.
 *
 * Accounts for message content, thinking blocks, and image attachments.
 */
export function estimateMessageTokens(message: ChatMessage): number {
  let n = estimateTokens(message.content);
  if (message.thinking) {
    n += estimateTokens(message.thinking);
  }
  if (message.attachments) {
    for (const att of message.attachments) {
      if (att.type === "image") {
        n += IMAGE_TOKEN_ESTIMATE;
      } else {
        n += estimateTokens(att.content);
      }
    }
  }
  return n;
}

/**
 * Token count for an array of messages (e.g. the full conversation).
 */
export function estimateMessagesTokens(messages: readonly ChatMessage[]): number {
  let total = 0;
  for (const m of messages) {
    total += estimateMessageTokens(m);
  }
  return total;
}
