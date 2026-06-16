/**
 * Post-run memory extraction: sub-agent analyzes conversation → AutoMemoryStore.
 */

import {
  type AutoMemoryStore,
  EmbeddingCache,
  type RunEvent,
  resolveEmbeddingConfig,
  shouldRunReflection,
  runReflection,
} from "@paw/core";
import type { ContextManager } from "@paw/core";
import type { LanguageModel } from "@paw/models";
import {
  defaultSettingsPath,
  loadPawSettingsLocal,
} from "@paw/settings";

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
  readonly auxiliaryModel?: LanguageModel;
  readonly emit: (event: RunEvent) => void;
  readonly workspaceRoot: string;
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

  // Compute embeddings for new/updated memories (best-effort, non-blocking)
  try {
    const settings = loadPawSettingsLocal(
      defaultSettingsPath(opts.workspaceRoot),
    );
    const embConfig = resolveEmbeddingConfig(settings as Record<string, unknown> as {
      memory_embedding_model?: string;
      ollama_host?: string;
    });
    if (embConfig) {
      const cache = new EmbeddingCache(embConfig);
      for (const entry of result.entries) {
        try {
          const emb = await cache.computeMemoryEmbedding({
            title: entry.name,
            summary: entry.description,
            content: entry.content,
          });
          if (emb) {
            opts.autoMemoryStore.save({
              ...entry,
              createdAt: entry.createdAt ?? now,
              updatedAt: now,
              embedding: EmbeddingCache.encodeEmbedding(emb),
            });
          }
        } catch {
          // embedding computation is best-effort; skip individual failures
        }
      }
      opts.autoMemoryStore.buildIndex();
    }
  } catch {
    // Settings unavailable or embedding model not configured — skip
  }

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

  // B.2: Periodic memory reflection (deduplication + archival)
  // Runs every 20 extraction cycles
  if (shouldRunReflection(opts.autoMemoryStore.memoryDir)) {
    const reflectionModel = opts.auxiliaryModel ?? opts.model;
    try {
      const reflectionResult = await runReflection({
        store: opts.autoMemoryStore,
        complete: async (system: string, user: string) => {
          // Use the auxiliary model for cheap reflection
          const text = await import("../auxiliary-complete.js").then((m) =>
            m.completeAuxiliaryTask({
              model: reflectionModel,
              system,
              user,
              signal: undefined,
            }),
          );
          return text;
        },
      });
      if (reflectionResult.modified > 0) {
        opts.emit({
          type: "memory.reflected",
          modified: reflectionResult.modified,
          merges: reflectionResult.plan.merges.length,
          archived: reflectionResult.plan.archive.length,
          conflicts: reflectionResult.plan.conflicts.length,
          runId: opts.runId,
        });
      }
    } catch {
      // Reflection is best-effort; skip on failure
    }
  }

  return created + updated;
}
