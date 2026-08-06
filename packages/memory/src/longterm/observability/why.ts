/**
 * memory why（spec v2 §9.2）：条目来源溯源
 *
 * 回答：创建时间、来源 run、证据指针、裁决历史（governance_decisions）、
 * 注入/采纳次数（op-log）。数据来自 memory_items + governance_decisions + memory_op_log。
 */

import { getSql, parseJson } from "../../db/connection.js";
import type { MemoryStoreEngine, MemoryEntry } from "../store/engine.js";
import { queryOpLog } from "./op-log.js";

export interface MemoryProvenance {
  entry: MemoryEntry | null;
  /** 裁决历史（按时间正序） */
  decisions: {
    id: string;
    decision: string;
    status: string;
    decidedBy: string;
    decidedAt: string;
    reasons: string[];
  }[];
  /** op-log 中该条目的操作计数（op → 次数） */
  opCounts: Record<string, number>;
  /** 最近涉及该条目的操作（倒序，≤10 条） */
  recentOps: { ts: string; op: string; runId?: string }[];
}

export async function collectWhy(engine: MemoryStoreEngine, id: string): Promise<MemoryProvenance> {
  const entry = await engine.get(id);
  const sql = getSql();

  const decisionRows = await sql`
    SELECT id, decision, status, decided_by, decided_at, reasons
    FROM governance_decisions
    WHERE resulting_memory_id = ${id} OR target_memory_id = ${id}
    ORDER BY decided_at ASC
  `;
  const decisions = (decisionRows as unknown as Record<string, unknown>[]).map((r) => {
    const reasons = (parseJson(r.reasons) ?? []) as { description?: string }[];
    const decidedBy = (parseJson(r.decided_by) ?? {}) as { actorId?: string };
    return {
      id: r.id as string,
      decision: r.decision as string,
      status: r.status as string,
      decidedBy: decidedBy.actorId ?? "unknown",
      decidedAt: r.decided_at instanceof Date ? r.decided_at.toISOString() : String(r.decided_at),
      reasons: reasons.map((x) => x.description ?? "").filter(Boolean),
    };
  });

  const ops = await queryOpLog({ entryId: id, limit: 200 });
  const opCounts: Record<string, number> = {};
  for (const o of ops) opCounts[o.op] = (opCounts[o.op] ?? 0) + 1;

  return {
    entry,
    decisions,
    opCounts,
    recentOps: ops.slice(0, 10).map((o) => ({ ts: o.ts, op: o.op, runId: o.runId })),
  };
}

/** 纯函数：渲染 why 文本 */
export function renderWhy(p: MemoryProvenance): string {
  if (!p.entry) return "条目不存在。";
  const e = p.entry;
  const lines: string[] = [
    `条目 ${e.id}`,
    `  kind: ${e.kind}    repo: ${e.repo}`,
    `  创建: ${e.created}    tValid: ${e.tValid}    tInvalid: ${e.tInvalid ?? "(活跃)"}`,
    `  source: ${e.source}    confidence: ${e.confidence}`,
    `  效用账本: freq=${e.freq} utility=${e.utility}`,
    `  证据: ${e.evidence.length > 0 ? e.evidence.join(", ") : "(无)"}`,
  ];

  if (p.decisions.length > 0) {
    lines.push("  裁决历史:");
    for (const d of p.decisions) {
      const why = d.reasons.length > 0 ? ` — ${d.reasons.join("; ")}` : "";
      lines.push(`    ${d.decidedAt}  ${d.decision} [${d.status}] by ${d.decidedBy}${why}`);
    }
  } else {
    lines.push("  裁决历史: (无 governance 记录——可能由引擎直接写入)");
  }

  const ops = Object.entries(p.opCounts);
  lines.push(`  操作记录: ${ops.length > 0 ? ops.map(([op, n]) => `${op}×${n}`).join("  ") : "(无)"}`);
  return lines.join("\n");
}
