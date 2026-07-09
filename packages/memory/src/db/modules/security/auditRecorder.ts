/**
 * Audit Recorder (8.13)
 *
 * 记录关键操作的不可变审计日志。
 * MVP: 同步写入 audit_records 表。
 */

import { getSql, parseJson } from "../../connection.js";
import { generateId } from "../platform/idGen.js";
import type { ActorRef } from "../../types.js";

export interface AuditEvent {
  eventType: string;
  actor: ActorRef;
  entityType: string;
  entityId: string;
  previousVersion?: number;
  newVersion?: number;
  changeSummary?: Record<string, unknown>;
  reason?: string;
  governanceDecisionId?: string;
  transactionId?: string;
  idempotencyKey?: string;
  policyVersion?: string;
  taskId?: string;
}

export const auditRecorder = {
  async record(event: AuditEvent): Promise<void> {
    const sql = getSql();
    await sql.unsafe(
      `INSERT INTO audit_records (
        id, event_type, actor, entity_type, entity_id,
        previous_version, new_version, change_summary, reason,
        governance_decision_id, transaction_id, idempotency_key,
        policy_version, task_id, sensitivity, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'internal',now())`,
      [generateId("audit"), event.eventType, JSON.stringify(event.actor),
        event.entityType, event.entityId, event.previousVersion ?? null,
        event.newVersion ?? null, JSON.stringify(event.changeSummary ?? {}),
        event.reason ?? null, event.governanceDecisionId ?? null,
        event.transactionId ?? null, event.idempotencyKey ?? null,
        event.policyVersion ?? null, event.taskId ?? null],
    );
  },

  /** 查询某个实体的审计历史 */
  async queryByEntity(entityType: string, entityId: string, limit = 50): Promise<AuditEvent[]> {
    const sql = getSql();
    const rows = await sql.unsafe(
      `SELECT * FROM audit_records WHERE entity_type = $1 AND entity_id = $2
       ORDER BY created_at DESC LIMIT $3`, [entityType, entityId, limit],
    ) as Record<string, unknown>[];
    return rows.map(rowToEvent);
  },

  /** 查询某个任务的所有审计记录 */
  async queryByTask(taskId: string, limit = 100): Promise<AuditEvent[]> {
    const sql = getSql();
    const rows = await sql.unsafe(
      `SELECT * FROM audit_records WHERE task_id = $1
       ORDER BY created_at DESC LIMIT $2`, [taskId, limit],
    ) as Record<string, unknown>[];
    return rows.map(rowToEvent);
  },
};

function rowToEvent(row: Record<string, unknown>): AuditEvent {
  return {
    eventType: row.event_type as string,
    actor: parseJson(row.actor) as ActorRef,
    entityType: row.entity_type as string,
    entityId: row.entity_id as string,
    previousVersion: row.previous_version as number | undefined,
    newVersion: row.new_version as number | undefined,
    changeSummary: parseJson(row.change_summary) as Record<string, unknown>,
    reason: row.reason as string | undefined,
    governanceDecisionId: row.governance_decision_id as string | undefined,
    transactionId: row.transaction_id as string | undefined,
    idempotencyKey: row.idempotency_key as string | undefined,
    policyVersion: row.policy_version as string | undefined,
    taskId: row.task_id as string | undefined,
  };
}
