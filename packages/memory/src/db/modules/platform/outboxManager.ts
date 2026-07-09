/**
 * Outbox Manager — 事务性事件写入
 *
 * 与 MemoryStore 在同一事务中写入 outbox 事件，
 * 保证正式状态变更和索引更新事件原子提交。
 */

import { getSql, parseJson } from "../../connection.js";
import { generateId } from "./idGen.js";

export interface OutboxEvent {
  id: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  memoryId?: string;
  memoryVersion?: number;
  payload: Record<string, unknown>;
  sequence: number;
  transactionId: string;
}

export const outboxManager = {
  /**
   * 写入 Outbox 事件（在已存在的 sql 事务中调用）。
   * 调用方负责管理事务和 sequence 递增。
   */
  async writeInTx(
    sql: ReturnType<typeof getSql>,
    event: Omit<OutboxEvent, "id" | "sequence" | "transactionId">,
    sequence: number,
    transactionId: string,
  ): Promise<void> {
    await sql.unsafe(
      `INSERT INTO outbox_events (
        id, event_type, aggregate_type, aggregate_id,
        memory_id, memory_version, payload,
        sequence, transaction_id, status, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',now())`,
      [generateId("outbox"), event.eventType, event.aggregateType, event.aggregateId,
        event.memoryId ?? null, event.memoryVersion ?? null,
        JSON.stringify(event.payload), sequence, transactionId],
    );
  },

  /** 查询待处理的 outbox 事件 */
  async pollPending(limit = 50): Promise<OutboxEvent[]> {
    const sql = getSql();
    const rows = await sql.unsafe(
      `SELECT * FROM outbox_events WHERE status = 'pending'
       ORDER BY sequence ASC LIMIT $1`, [limit],
    );
    return rows.map(rowToEvent);
  },

  /** 标记事件为已发布 */
  async markPublished(id: string): Promise<void> {
    const sql = getSql();
    await sql.unsafe(
      `UPDATE outbox_events SET status = 'published', published_at = now()
       WHERE id = $1`, [id],
    );
  },

  /** 标记事件失败 */
  async markFailed(id: string, error: string): Promise<void> {
    const sql = getSql();
    await sql.unsafe(
      `UPDATE outbox_events SET
        status = CASE WHEN retry_count >= max_retries THEN 'dead_letter' ELSE 'pending' END,
        retry_count = retry_count + 1,
        last_error = $2,
        next_retry_at = CASE WHEN retry_count >= max_retries THEN NULL
          ELSE now() + make_interval(secs => power(2, retry_count) * 5)
        END
       WHERE id = $1`, [id, error],
    );
  },
};

function rowToEvent(row: Record<string, unknown>): OutboxEvent {
  return {
    id: row.id as string,
    eventType: row.event_type as string,
    aggregateType: row.aggregate_type as string,
    aggregateId: row.aggregate_id as string,
    memoryId: row.memory_id as string | undefined,
    memoryVersion: row.memory_version as number | undefined,
    payload: parseJson(row.payload) as Record<string, unknown>,
    sequence: row.sequence as number,
    transactionId: row.transaction_id as string,
  };
}
