/**
 * Operation Log（spec v2 §10.1）
 *
 * 每次记忆操作记一行到 memory_op_log 表（V028；file 后端 op-log.jsonl 的 db 等价物）。
 * 用途：回放任意任务"当时注入了什么记忆"；定位"错误记忆何时入库、被谁裁决、注入过几次"。
 *
 * append 是 best-effort：写失败静默吞掉（spec §9.6——记忆子系统异常不得使任务失败，
 * 可观测性自身更不能成为故障源）。
 */

import { createHash, randomBytes } from "node:crypto";
import { getSql, parseJson, textArrayLiteral } from "../../db/connection.js";

/** spec §10.1 的操作类型（开放集合，新操作直接追加） */
export type MemoryOp =
  | "read.trigger"
  | "read.inject"
  /** 试用教训随行注入（不进正式账本；供任务成功后转正） */
  | "read.inject.trial"
  /** 注入采纳（spec §10.3 采纳率口径的原始记录，见 ledger.ts） */
  | "read.adopted"
  | "write.enqueued"
  | "write.rejected"
  /** 试用教训转正为正式 episodic（source=trial_graduated） */
  | "write.graduated"
  | "governed"
  | "lifecycle.purge"
  | "reindex"
  | "error";

export interface OpLogEntry {
  id: string;
  /** ISO 8601 */
  ts: string;
  op: string;
  runId?: string;
  entryIds: string[];
  detail: Record<string, unknown>;
}

export interface OpLogFilter {
  runId?: string;
  /** 涉及某条目的操作（entry_ids 数组包含） */
  entryId?: string;
  op?: string;
  /** ISO 8601，含边界 */
  since?: string;
  until?: string;
  limit?: number;
}

function newOpLogId(ts: string, op: string): string {
  const rand = randomBytes(4).toString("hex");
  const hash = createHash("sha256").update(`${ts}${op}${rand}`).digest("hex").slice(0, 8);
  return `opl_${hash}${rand}`;
}

/**
 * 追加一行操作日志。best-effort：任何失败都吞掉，返回是否写入成功。
 */
export async function appendOpLog(
  op: MemoryOp | (string & {}),
  opts: { runId?: string; entryIds?: string[]; detail?: Record<string, unknown>; ts?: string } = {},
): Promise<boolean> {
  try {
    const sql = getSql();
    const ts = opts.ts ?? new Date().toISOString();
    await sql`
      INSERT INTO memory_op_log (id, ts, op, run_id, entry_ids, detail)
      VALUES (
        ${newOpLogId(ts, op)}, ${ts}, ${op}, ${opts.runId ?? null},
        ${textArrayLiteral(opts.entryIds ?? [])}::text[], ${sql.json((opts.detail ?? {}) as any)}
      )
    `;
    return true;
  } catch {
    return false;
  }
}

/** 按 runId/条目/操作/时间窗口查询，默认按时间倒序 */
export async function queryOpLog(filter: OpLogFilter = {}): Promise<OpLogEntry[]> {
  const sql = getSql();
  const conds: string[] = ["1=1"];
  const params: unknown[] = [];

  if (filter.runId) {
    params.push(filter.runId);
    conds.push(`run_id = $${params.length}`);
  }
  if (filter.entryId) {
    params.push(filter.entryId);
    conds.push(`entry_ids @> ARRAY[$${params.length}]::text[]`);
  }
  if (filter.op) {
    params.push(filter.op);
    conds.push(`op = $${params.length}`);
  }
  if (filter.since) {
    params.push(filter.since);
    conds.push(`ts >= $${params.length}::timestamptz`);
  }
  if (filter.until) {
    params.push(filter.until);
    conds.push(`ts <= $${params.length}::timestamptz`);
  }
  params.push(filter.limit ?? 200);
  const limit = `$${params.length}`;

  const rows = await sql.unsafe(
    `SELECT * FROM memory_op_log WHERE ${conds.join(" AND ")} ORDER BY ts DESC LIMIT ${limit}`,
    params as never[],
  );
  return (rows as unknown as Record<string, unknown>[]).map((r) => ({
    id: r.id as string,
    ts: r.ts instanceof Date ? r.ts.toISOString() : String(r.ts),
    op: r.op as string,
    runId: (r.run_id as string | null) ?? undefined,
    entryIds: (r.entry_ids as string[]) ?? [],
    detail: (parseJson(r.detail) ?? {}) as Record<string, unknown>,
  }));
}
