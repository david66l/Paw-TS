/**
 * 运行后记忆提取：子 Agent 分析对话内容 → 写入 AutoMemoryStore。
 * ============================================================
 *
 * 每次 Run 完成后（无论是成功还是达到 maxSteps），如果配置了 memoryExtraction
 * 不是 "off"，就会调用此模块。
 *
 * 流程：
 * 1. shouldAttemptMemoryExtraction()：检查对话是否值得提取
 *    （太短的对话跳过，避免产生无价值的记忆）
 * 2. formatConversationForMemoryExtraction()：格式化对话文本
 * 3. extractMemories()：用 LLM 从对话中提取记忆条目
 * 4. upsert 到 AutoMemoryStore：创建或更新记忆条目
 * 5. 计算 embedding：为每条记忆计算向量（用于语义检索，best-effort）
 * 6. 周期性记忆反思（Reflection）：每 20 次提取触发一次去重+归档
 *
 * 记忆反思（B.2 Reflection）：
 * - 定期检查记忆库中的重复和冲突
 * - 合并相似记忆、归档过期记忆
 * - 使用辅助模型执行（便宜、不影响主流程）
 */

import {
  type AutoMemoryStore,
  EmbeddingCache,
  type RunEvent,
  shouldRunReflection,
  runReflection,
} from "@paw/core";
import type { ContextManager } from "@paw/core";
import type { LanguageModel } from "@paw/models";
import { computeMemoryEmbedding } from "../settings.js";

import {
  formatConversationForMemoryExtraction,
  shouldAttemptMemoryExtraction,
} from "../format-conversation-for-memory.js";
import { extractMemories } from "../memory-extraction-agent.js";

/**
 * 运行完成后提取记忆。
 *
 * @returns 创建 + 更新的记忆条目总数
 */
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

  // 守卫：对话太短或质量不足以提取记忆
  if (!shouldAttemptMemoryExtraction(messages)) {
    return 0;
  }

  // 格式化对话为 LLM 可处理的文本
  const conversationText = formatConversationForMemoryExtraction(messages);

  // 调用 LLM 提取记忆条目
  const result = await extractMemories(opts.model, conversationText);
  if (result.entries.length === 0) {
    return 0;
  }

  // 写入 AutoMemoryStore（upsert：存在则更新，不存在则创建）
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

  // 为新/更新的记忆计算 embedding（best-effort，非阻塞）
  // embedding 用于后续的语义相似度检索
  for (const entry of result.entries) {
    try {
      const emb = await computeMemoryEmbedding(opts.workspaceRoot, {
        title: entry.name,
        summary: entry.description,
        content: entry.content,
      });
      if (emb) {
        // 重新加载已 upsert 的条目，确保不覆盖合并后的字段
        const saved = opts.autoMemoryStore.load(entry.name);
        if (saved) {
          opts.autoMemoryStore.save({
            ...saved,
            embedding: EmbeddingCache.encodeEmbedding(emb),
          });
        }
      }
    } catch {
      // embedding 计算是 best-effort，单个失败不影响整体
    }
  }

  // 发出提取结果事件
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

  // B.2：周期性记忆反思（去重 + 归档）
  // 每 20 次提取触发一次，用辅助模型执行
  if (shouldRunReflection(opts.autoMemoryStore.memoryDir)) {
    const reflectionModel = opts.auxiliaryModel ?? opts.model;
    try {
      const reflectionResult = await runReflection({
        store: opts.autoMemoryStore,
        complete: async (system: string, user: string) => {
          // 用辅助模型做反思（便宜模型即可，不需要强推理能力）
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
      // 反思是 best-effort，失败不影响主流程
    }
  }

  return created + updated;
}
