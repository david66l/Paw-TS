/**
 * Single-shot model completion for auxiliary tasks (compression, memory extraction).
 * No tools, no orchestrator loop — minimal token overhead.
 */

import type { ChatMessage } from "@paw/models";
import type { LanguageModel } from "@paw/models";

export async function completeAuxiliaryTask(opts: {
  readonly model: LanguageModel;
  readonly system: string;
  readonly user: string;
  readonly signal?: AbortSignal;
}): Promise<string> {
  const messages: ChatMessage[] = [
    { role: "system", content: opts.system },
    { role: "user", content: opts.user },
  ];
  const result = await opts.model.complete(messages, {
    signal: opts.signal,
  });
  return result.text.trim();
}
