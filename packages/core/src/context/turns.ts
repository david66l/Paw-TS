import type { ChatMessage } from "./manager.js";

/**
 * One derived assistant-boundary unit in legacy ChatMessage history.
 *
 * This is intentionally not a semantic user/conversation turn: legacy state
 * has no provenance or turn id. Leading messages before the first assistant
 * are standalone units; every assistant starts a unit that absorbs following
 * non-assistant messages until the next assistant. This conservatively keeps
 * an assistant action with all observations that may belong to it.
 */
export interface ContextTurnV1 {
  readonly start: number;
  readonly endExclusive: number;
  readonly messages: readonly ChatMessage[];
}

/** Derive atomic truncation/compaction units without changing persisted data. */
export function groupContextTurnsV1(
  messages: readonly ChatMessage[],
): readonly ContextTurnV1[] {
  if (messages.length === 0) return [];
  const starts: number[] = [];
  const firstAssistant = messages.findIndex(
    (message) => message.role === "assistant",
  );
  const leadingEnd = firstAssistant < 0 ? messages.length : firstAssistant;
  for (let index = 0; index < leadingEnd; index += 1) starts.push(index);
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index]?.role === "assistant") starts.push(index);
  }
  return starts.map((start, index) => {
    const endExclusive = starts[index + 1] ?? messages.length;
    return {
      start,
      endExclusive,
      messages: messages.slice(start, endExclusive),
    };
  });
}

export function flattenContextTurnsV1(
  turns: readonly ContextTurnV1[],
): ChatMessage[] {
  return turns.flatMap((turn) => [...turn.messages]);
}
