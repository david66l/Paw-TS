/**
 * Index Manager (8.23)
 *
 * 消费 Outbox 事件，维护派生索引（pgvector、全文索引）。
 * MVP: 同步处理，无独立 Worker。幂等消费，event_sequence 保证顺序。
 */

import { getSql } from "../../connection.js";
import { outboxManager, type OutboxEvent } from "./outboxManager.js";

export const indexManager = {
  /**
   * 处理一批 outbox 事件，更新索引。
   * 幂等：通过 event_sequence 防止旧事件覆盖新索引。
   */
  async processPending(limit = 20): Promise<{ processed: number; failed: number }> {
    const events = await outboxManager.pollPending(limit);
    let processed = 0;
    let failed = 0;

    for (const event of events) {
      try {
        await handleEvent(event);
        await outboxManager.markPublished(event.id);
        processed++;
      } catch (err) {
        await outboxManager.markFailed(event.id, String(err));
        failed++;
      }
    }

    return { processed, failed };
  },

  /**
   * 索引状态查询（MemoryRetriever 用）
   */
  async getIndexStatus(memoryId: string): Promise<{
    vector: string;
    fullText: string;
    metadata: string;
  }> {
    const sql = getSql();
    const rows = await sql.unsafe(
      `SELECT index_type, index_state FROM memory_index_states WHERE memory_id = $1`, [memoryId],
    ) as { index_type: string; index_state: string }[];

    const states = { vector: "NOT_CONFIGURED", fullText: "NOT_CONFIGURED", metadata: "NOT_CONFIGURED" };
    for (const r of rows) {
      if (r.index_type === "VECTOR") states.vector = r.index_state;
      else if (r.index_type === "FULL_TEXT") states.fullText = r.index_state;
      else if (r.index_type === "METADATA") states.metadata = r.index_state;
    }
    return states;
  },
};

async function handleEvent(event: OutboxEvent): Promise<void> {
  const sql = getSql();

  switch (event.eventType) {
    case "MemoryCreated":
    case "MemoryVersionCreated":
    case "MemoryActivated": {
      if (!event.memoryId) break;

      // 检查 event_sequence 是否过时
      const current = await getCurrentIndexRevision(sql, event.memoryId, "VECTOR");
      if (event.sequence <= current) break; // 旧事件跳过

      // 更新元数据索引（memory_items 表自身的索引由 DDL 保证，这里写状态）
      await upsertIndexState(sql, event.memoryId, event.memoryVersion ?? 1, "METADATA", "INDEXED", event.sequence);
      await upsertIndexState(sql, event.memoryId, event.memoryVersion ?? 1, "FULL_TEXT", "INDEXED", event.sequence);

      // Vector 索引：标记为 INDEX_PENDING（实际的 embedding 生成由外部模型服务完成）
      await upsertIndexState(sql, event.memoryId, event.memoryVersion ?? 1, "VECTOR", "INDEX_PENDING", event.sequence);
      break;
    }

    case "MemorySoftDeleted":
    case "MemoryHardDeleted": {
      if (!event.memoryId) break;
      await sql.unsafe("DELETE FROM memory_embeddings WHERE memory_id = $1", [event.memoryId]);
      await sql.unsafe(
        `UPDATE memory_index_states SET index_state = 'DELETE_PENDING', updated_at = now()
         WHERE memory_id = $1`, [event.memoryId],
      );
      break;
    }

    case "SuppressionRuleCreated":
    case "SuppressionRuleDisabled":
      // 暂不处理
      break;
  }
}

async function getCurrentIndexRevision(sql: ReturnType<typeof getSql>, memoryId: string, indexType: string): Promise<number> {
  const rows = await sql.unsafe(
    `SELECT index_revision FROM memory_index_states WHERE memory_id = $1 AND index_type = $2`,
    [memoryId, indexType],
  );
  return rows.length > 0 ? (rows[0] as unknown as { index_revision: number }).index_revision : 0;
}

async function upsertIndexState(
  sql: ReturnType<typeof getSql>,
  memoryId: string, memoryVersionId: number, indexType: string,
  indexState: string, eventSequence: number,
): Promise<void> {
  const id = `${memoryId}_${indexType}`;
  await sql.unsafe(
    `INSERT INTO memory_index_states (id, memory_id, memory_version_id, index_type, index_state, index_revision, event_sequence, updated_at, created_at)
     VALUES ($1,$2,$3,$4,$5,1,$6,now(),now())
     ON CONFLICT (memory_id, index_type) DO UPDATE SET
       memory_version_id = $3, index_state = $5, index_revision = memory_index_states.index_revision + 1,
       event_sequence = $6, updated_at = now()
     WHERE memory_index_states.event_sequence < $6`,
    [id, memoryId, memoryVersionId, indexType, indexState, eventSequence],
  );
}
