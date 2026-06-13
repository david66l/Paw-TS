/**
 * Post-run memory extraction: sub-agent analyzes conversation → AutoMemoryStore.
 */

import type { AutoMemoryStore, RunEvent } from "@paw/core";
import type { ContextManager } from "@paw/core";
import type { LanguageModel } from "@paw/models";

import {
  formatConversationForMemoryExtraction,
  shouldAttemptMemoryExtraction,
} from "../format-conversation-for-memory.js";
import { extractMemories } from "../memory-extraction-agent.js";

export async function runMemoryExtractionAfterRun(opts: {
  readonly runId: string;
  readonly ctxMgr: ContextManager;
  readonly autoMemoryStore: AutoMemoryStore;
  readonly model: LanguageModel;
  readonly emit: (event: RunEvent) => void;
}): Promise<number> {
  const messages = opts.ctxMgr.buildMessages();
  if (!shouldAttemptMemoryExtraction(messages)) {
    return 0;
  }

  const conversationText = formatConversationForMemoryExtraction(messages);
  const result = await extractMemories(opts.model, conversationText);
  if (result.entries.length === 0) {
    return 0;
  }

  const now = Date.now();
  let created = 0;
  let updated = 0;
  for (const entry of result.entries) {
    const action = opts.autoMemoryStore.upsert({
      ...entry,
      createdAt: entry.createdAt ?? now,
      updatedAt: now,
    });
    if (action === "created") created++;
    else updated++;
  }
  opts.autoMemoryStore.buildIndex();
  opts.emit({
    type: "memory.extracted",
    entries: result.entries.length,
    rejected: result.rejected.length,
    runId: opts.runId,
  });
  for (const r of result.rejected) {
    opts.emit({
      type: "memory.rejected",
      entry: r.entry.name,
      reason: r.reason,
      runId: opts.runId,
    });
  }
  return created + updated;
}
