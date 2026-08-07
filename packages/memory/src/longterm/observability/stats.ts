/**
 * memory stats（spec v2 §10.3 / §10.4-3）
 *
 * collectMemoryStats 负责取数（db），renderMemoryStats 是纯函数负责展示与告警，
 * 二者分离便于单测告警阈值。
 */

import { getSql } from "../../db/connection.js";
import { scanDeletionCandidates, DEFAULT_LIFECYCLE_CONFIG } from "../lifecycle/janitor.js";

/** spec §9.4 默认值（展示文案用；判定逻辑在 lifecycle/janitor.scanDeletionCandidates） */
export const DELETE_MIN_FREQ = DEFAULT_LIFECYCLE_CONFIG.deleteMinFreq;
export const DELETE_MAX_UTILITY_RATIO = DEFAULT_LIFECYCLE_CONFIG.deleteMaxUtilityRatio;
/** spec §10.4-3：unverified 占比告警阈值 */
export const UNVERIFIED_WARN_RATIO = 0.1;

export interface MemoryStats {
  /** 活跃条目总数 */
  active: number;
  /** 已软失效条目总数 */
  invalidated: number;
  /** 活跃条目按 kind 分布 */
  byKind: Record<string, number>;
  /** 活跃条目中 verification_status='unverified' 的数量与占比 */
  unverified: number;
  unverifiedRatio: number;
  /** 删除候选数：freq≥DELETE_MIN_FREQ 且 utility/freq < DELETE_MAX_UTILITY_RATIO */
  deleteCandidates: number;
  /** 本月写入口径操作数（write.enqueued/governed；蒸馏 LLM 成本待 M4 接线后补充） */
  writeOpsThisMonth: number;
  /** 近 30 天注入采纳率（op-log read.adopted 条目次 / read.inject 条目次）；无注入数据为 null */
  adoptionRate30d: number | null;
  /** 近 30 天注入/采纳条目次（采纳率的分母分子，供展示） */
  injected30d: number;
  adopted30d: number;
  /** 今日蒸馏 LLM 调用次数（op-log write.distill，修复批次 C #22 成本闭环） */
  todayDistillCalls: number;
  /** 今日写入路径预估 token 消耗（write.enqueued/write.distill 的 estimatedTokens 聚合） */
  todayEstimatedTokens: number;
}

/** 每日蒸馏预算默认值（§9.4 memory.write.dailyBudget；配置接线后应对齐） */
export const DAILY_DISTILL_BUDGET = 50;

export async function collectMemoryStats(): Promise<MemoryStats> {
  const sql = getSql();

  const [totals] = await sql`
    SELECT
      count(*) FILTER (WHERE t_invalid IS NULL)::int AS active,
      count(*) FILTER (WHERE t_invalid IS NOT NULL)::int AS invalidated,
      count(*) FILTER (WHERE t_invalid IS NULL AND verification_status = 'unverified')::int AS unverified
    FROM memory_items
  `;
  const t = totals as { active: number; invalidated: number; unverified: number };

  // 删除候选：与生命周期批处理同一判定函数（freq≥8 且采纳率<0.2 且 utility 比低，§7.2）
  const deleteCandidates = (await scanDeletionCandidates()).length;

  const kindRows = await sql`
    SELECT type, count(*)::int AS n FROM memory_items
    WHERE t_invalid IS NULL GROUP BY type ORDER BY n DESC
  `;
  const byKind: Record<string, number> = {};
  for (const r of kindRows as unknown as { type: string; n: number }[]) byKind[r.type] = r.n;

  const [writeOps] = await sql`
    SELECT count(*)::int AS n FROM memory_op_log
    WHERE op IN ('write.enqueued', 'governed')
      AND ts >= date_trunc('month', now())
  `;

  const [adoption] = await sql`
    SELECT
      COALESCE(sum(array_length(entry_ids, 1)) FILTER (WHERE op = 'read.inject'), 0)::int AS injected,
      COALESCE(sum(array_length(entry_ids, 1)) FILTER (WHERE op = 'read.adopted'), 0)::int AS adopted
    FROM memory_op_log
    WHERE op IN ('read.inject', 'read.adopted')
      AND ts >= now() - interval '30 days'
  `;
  const a = adoption as { injected: number; adopted: number };

  // 今日写入成本（#22）：蒸馏调用次数 + 入队/蒸馏的预估 token 聚合
  const [today] = await sql`
    SELECT
      count(*) FILTER (WHERE op = 'write.distill')::int AS distill_calls,
      COALESCE(sum((detail->>'estimatedTokens')::int), 0)::int AS estimated_tokens
    FROM memory_op_log
    WHERE op IN ('write.enqueued', 'write.distill')
      AND ts >= date_trunc('day', now())
  `;
  const td = today as { distill_calls: number; estimated_tokens: number };

  return {
    active: t.active,
    invalidated: t.invalidated,
    byKind,
    unverified: t.unverified,
    unverifiedRatio: t.active > 0 ? t.unverified / t.active : 0,
    deleteCandidates,
    writeOpsThisMonth: (writeOps as { n: number }).n,
    adoptionRate30d: a.injected > 0 ? a.adopted / a.injected : null,
    injected30d: a.injected,
    adopted30d: a.adopted,
    todayDistillCalls: td.distill_calls,
    todayEstimatedTokens: td.estimated_tokens,
  };
}

/** 纯函数：渲染 stats 文本；unverified 占比超阈值输出告警（spec §10.4-3） */
export function renderMemoryStats(s: MemoryStats): string {
  const lines: string[] = [
    "记忆库统计",
    `  活跃条目: ${s.active}    已软失效: ${s.invalidated}`,
    `  按 kind: ${Object.keys(s.byKind).length > 0
      ? Object.entries(s.byKind).map(([k, n]) => `${k}=${n}`).join("  ")
      : "(空库)"}`,
    `  unverified: ${s.unverified} (${(s.unverifiedRatio * 100).toFixed(1)}%)`,
    `  删除候选: ${s.deleteCandidates}（freq≥${DELETE_MIN_FREQ} 且 utility/freq<${DELETE_MAX_UTILITY_RATIO}）`,
    `  本月写入操作: ${s.writeOpsThisMonth}`,
    `  今日蒸馏: ${s.todayDistillCalls}/${DAILY_DISTILL_BUDGET} 次（预估 ~${s.todayEstimatedTokens} tokens，预计剩余 ${Math.max(0, DAILY_DISTILL_BUDGET - s.todayDistillCalls)} 次）`,
    s.adoptionRate30d !== null
      ? `  近 30 天注入采纳率: ${(s.adoptionRate30d * 100).toFixed(1)}%（${s.adopted30d}/${s.injected30d} 条目次）`
      : "  近 30 天注入采纳率: 暂无注入数据",
  ];
  if (s.todayDistillCalls >= Math.floor(DAILY_DISTILL_BUDGET * 0.8)) {
    lines.push(
      `⚠ 告警: 今日蒸馏调用 ${s.todayDistillCalls} 次已达预算 ${DAILY_DISTILL_BUDGET} 的 80%——超限将降级为原文摘要（§5.2）`,
    );
  }
  if (s.unverifiedRatio > UNVERIFIED_WARN_RATIO) {
    lines.push(
      `⚠ 告警: unverified 条目占比 ${(s.unverifiedRatio * 100).toFixed(1)}% 超过 ` +
      `${UNVERIFIED_WARN_RATIO * 100}%——弱模型可能在腐蚀记忆库（spec §10.4-3）`,
    );
  }
  return lines.join("\n");
}
