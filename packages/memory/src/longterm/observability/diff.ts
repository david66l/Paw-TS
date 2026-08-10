/**
 * memory diff（spec v2 §10.2）
 *
 * 两时点间记忆库的变化：op-log 聚合 + 条目 tValid/tInvalid 扫描。
 * collectMemoryDiff 取数（db），renderMemoryDiff 纯函数展示。
 */

import { getSql } from "../../db/connection.js";

export interface MemoryDiff {
  since: string;
  until: string;
  /** op-log 按操作类型聚合 */
  opCounts: Record<string, number>;
  /** 新增条目（t_valid ∈ 窗口） */
  added: { id: string; kind: string; title: string; tValid: string }[];
  /** 更新条目（修复批次 B #13：Governor UPDATE 裁决，或 history 非空且 t_valid 未变但窗口内有更新） */
  updated: { id: string; kind: string; title: string }[];
  /** 失效条目（t_invalid ∈ 窗口） */
  invalidated: { id: string; kind: string; title: string; tInvalid: string }[];
  /** 物理删除的条目 id（op-log lifecycle.gc，#13 修正口径：purge=软失效，gc=物理删除） */
  purgedIds: string[];
}

function iso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

export async function collectMemoryDiff(since: string, until?: string): Promise<MemoryDiff> {
  const sql = getSql();
  const untilTs = until ?? new Date().toISOString();

  const opRows = await sql`
    SELECT op, count(*)::int AS n FROM memory_op_log
    WHERE ts >= ${since}::timestamptz AND ts <= ${untilTs}::timestamptz
    GROUP BY op ORDER BY n DESC
  `;
  const opCounts: Record<string, number> = {};
  for (const r of opRows as unknown as { op: string; n: number }[]) opCounts[r.op] = r.n;

  const addedRows = await sql`
    SELECT id, type, title, t_valid FROM memory_items
    WHERE t_valid >= ${since}::timestamptz AND t_valid <= ${untilTs}::timestamptz
    ORDER BY t_valid DESC LIMIT 100
  `;

  const invalidatedRows = await sql`
    SELECT id, type, title, t_invalid FROM memory_items
    WHERE t_invalid >= ${since}::timestamptz AND t_invalid <= ${untilTs}::timestamptz
    ORDER BY t_invalid DESC LIMIT 100
  `;

  const purgeRows = await sql`
    SELECT entry_ids FROM memory_op_log
    WHERE op = 'lifecycle.gc'
      AND ts >= ${since}::timestamptz AND ts <= ${untilTs}::timestamptz
  `;
  const purgedIds = (purgeRows as unknown as { entry_ids: string[] }[]).flatMap((r) => r.entry_ids ?? []);

  // updated 口径：窗口内的 UPDATE 裁决目标 + history 非空且窗口内更新但非新增的条目
  const updateDecisions = await sql`
    SELECT DISTINCT target_memory_id AS id FROM governance_decisions
    WHERE decision = 'UPDATE' AND target_memory_id IS NOT NULL
      AND decided_at >= ${since}::timestamptz AND decided_at <= ${untilTs}::timestamptz
  `;
  const historyUpdated = await sql`
    SELECT id, type, title FROM memory_items
    WHERE updated_at >= ${since}::timestamptz AND updated_at <= ${untilTs}::timestamptz
      AND t_valid < ${since}::timestamptz
      AND jsonb_array_length(history) > 0
    ORDER BY updated_at DESC LIMIT 100
  `;
  const seenUpdate = new Set<string>();
  const updated: MemoryDiff["updated"] = [];
  for (const r of updateDecisions as unknown as { id: string }[]) {
    if (seenUpdate.has(r.id)) continue;
    seenUpdate.add(r.id);
    updated.push({ id: r.id, kind: "", title: "" });
  }
  for (const r of historyUpdated as unknown as Record<string, unknown>[]) {
    const id = r.id as string;
    if (seenUpdate.has(id)) continue;
    seenUpdate.add(id);
    updated.push({ id, kind: r.type as string, title: r.title as string });
  }

  return {
    since,
    until: untilTs,
    opCounts,
    added: (addedRows as unknown as Record<string, unknown>[]).map((r) => ({
      id: r.id as string,
      kind: r.type as string,
      title: r.title as string,
      tValid: iso(r.t_valid),
    })),
    updated,
    invalidated: (invalidatedRows as unknown as Record<string, unknown>[]).map((r) => ({
      id: r.id as string,
      kind: r.type as string,
      title: r.title as string,
      tInvalid: iso(r.t_invalid),
    })),
    purgedIds,
  };
}

/** 纯函数：渲染 diff 文本 */
export function renderMemoryDiff(d: MemoryDiff): string {
  const lines: string[] = [
    `记忆库变更（${d.since} → ${d.until}）`,
    `  新增: ${d.added.length}    更新: ${d.updated.length}    失效: ${d.invalidated.length}    物理删除: ${d.purgedIds.length}`,
  ];

  const ops = Object.entries(d.opCounts);
  lines.push(`  操作: ${ops.length > 0 ? ops.map(([op, n]) => `${op}×${n}`).join("  ") : "(无)"}`);

  for (const e of d.added.slice(0, 20)) {
    lines.push(`  + [${e.kind}] ${e.id}  ${truncate(e.title, 60)}`);
  }
  if (d.added.length > 20) lines.push(`  … 另有 ${d.added.length - 20} 条新增`);

  for (const e of d.updated.slice(0, 20)) {
    lines.push(`  ~ [${e.kind || "?"}] ${e.id}  ${truncate(e.title, 60)}`);
  }
  if (d.updated.length > 20) lines.push(`  … 另有 ${d.updated.length - 20} 条更新`);

  for (const e of d.invalidated.slice(0, 20)) {
    lines.push(`  − [${e.kind}] ${e.id}  ${truncate(e.title, 60)}（失效于 ${e.tInvalid}）`);
  }
  if (d.invalidated.length > 20) lines.push(`  … 另有 ${d.invalidated.length - 20} 条失效`);

  return lines.join("\n");
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
