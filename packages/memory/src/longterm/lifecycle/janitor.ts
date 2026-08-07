/**
 * 生命周期批处理器（spec v2 §7.1–7.3 / §9.2，M7）
 *
 * 每日批处理（调用方调度）：删除候选扫描 → 灰度人工复核 → 容量检查。
 * 零 LLM 调用——这是性价比最高的遗忘机制。
 *
 * 删除规则（§7.2，刻意保守）：
 *   freq ≥ 8 且 采纳率 < 0.2 且（utility/freq ≤ 0.3 或无足够 outcome 信号）
 * 采纳率 = op-log read.adopted / read.inject 的条目级聚合（§10.3 口径）；
 * 无采纳数据视为"信号不足"（缺失 ≠ 负信号，§7.1），不单独定罪。
 *
 * 豁免：freq<8（试用期保护）、source=user_statement（永不自动删）、
 * profile supportCount≥3（需巩固流程复核）。
 *
 * 灰度（§7.2）：前 200 条候选进 review 队列人工确认；队列 resolved 中
 * rejected 占比 <5% 后转全自动（误删率达标）。
 *
 * 删除一律软失效（tInvalid=now，A8）；物理删除见 gc.ts。
 */

import type { RunEvent } from "@paw/core";
import { getSql, parseJson, textArrayLiteral } from "../../db/connection.js";
import { generateId } from "../../db/modules/platform/idGen.js";
import type { MemoryStoreEngine } from "../store/engine.js";
import { PostgresMemoryStoreEngine } from "../store/postgres-engine.js";
import { appendOpLog } from "../observability/op-log.js";

export interface LifecycleConfig {
  deleteMinFreq: number;
  deleteMaxAdoptionRate: number;
  deleteMaxUtilityRatio: number;
  deleteReviewFirstN: number;
  /** 灰度转全自动的误删率门槛（rejected/resolved < 5%） */
  autoApproveMaxRejectRate: number;
  episodicCap: number;
  episodicTrimTo: number;
  semanticCap: number;
  semanticTrimTo: number;
  trialCap: number;
  profileCap: number;
  /** 限定仓库；缺省全库 */
  repo?: string;
}

export const DEFAULT_LIFECYCLE_CONFIG: LifecycleConfig = {
  deleteMinFreq: 8,
  deleteMaxAdoptionRate: 0.2,
  deleteMaxUtilityRatio: 0.3,
  deleteReviewFirstN: 200,
  autoApproveMaxRejectRate: 0.05,
  episodicCap: 800,
  episodicTrimTo: 500,
  semanticCap: 2000,
  semanticTrimTo: 1500,
  trialCap: 50,
  profileCap: 15,
};

export interface DeletionCandidate {
  id: string;
  kind: string;
  freq: number;
  utility: number;
  /** null = 无采纳数据（信号不足） */
  adoptionRate: number | null;
  reason: string;
}

export interface LifecycleReport {
  /** 判定为删除候选的条目（无论进 review 还是自动执行） */
  candidates: DeletionCandidate[];
  /** 新进 review 队列的条目 */
  enqueuedForReview: string[];
  /** 灰度通过后自动软失效的条目 */
  autoInvalidated: string[];
  /** 已在队列中（pending/rejected 跳过）的条目 */
  alreadyInQueue: string[];
  capacity: {
    episodicInvalidated: string[];
    semanticInvalidated: string[];
    trialDropped: string[];
    /** profile 超限数（只报告，裁决属 v2） */
    profileOverCap: number;
  };
  reviewQueuePending: number;
  /** 是否已转全自动（灰度期结束且误删率达标） */
  autoMode: boolean;
}

interface ActiveRow {
  id: string;
  type: string;
  freq: number;
  utility: number;
  source: string;
  supportCount: number | null;
  tValid: string;
}

async function loadActiveRows(repo?: string): Promise<ActiveRow[]> {
  const sql = getSql();
  const rows = repo
    ? await sql`
        SELECT id, type, freq, utility, payload->>'source' AS source,
               (payload->>'supportCount')::int AS support_count, t_valid
        FROM memory_items
        WHERE t_invalid IS NULL AND scope->>'repositoryId' = ${repo}
          AND COALESCE(payload->>'degraded', 'false') != 'true'
      `
    : await sql`
        SELECT id, type, freq, utility, payload->>'source' AS source,
               (payload->>'supportCount')::int AS support_count, t_valid
        FROM memory_items
        WHERE t_invalid IS NULL AND COALESCE(payload->>'degraded', 'false') != 'true'
      `;
  return (rows as unknown as Record<string, unknown>[]).map((r) => ({
    id: r.id as string,
    type: r.type as string,
    freq: (r.freq as number) ?? 0,
    utility: (r.utility as number) ?? 0,
    source: (r.source as string) ?? "",
    supportCount: (r.support_count as number | null) ?? null,
    tValid: r.t_valid instanceof Date ? r.t_valid.toISOString() : String(r.t_valid),
  }));
}

/** 条目级采纳率：op-log read.adopted / read.inject 聚合（§10.3 口径） */
async function loadAdoptionRates(): Promise<Map<string, { injected: number; adopted: number }>> {
  const sql = getSql();
  const rows = await sql`
    SELECT entry_id,
           count(*) FILTER (WHERE op = 'read.inject')::int AS injected,
           count(*) FILTER (WHERE op = 'read.adopted')::int AS adopted
    FROM memory_op_log, unnest(entry_ids) AS entry_id
    WHERE op IN ('read.inject', 'read.adopted')
    GROUP BY entry_id
  `;
  const map = new Map<string, { injected: number; adopted: number }>();
  for (const r of rows as unknown as { entry_id: string; injected: number; adopted: number }[]) {
    map.set(r.entry_id, { injected: r.injected, adopted: r.adopted });
  }
  return map;
}

/**
 * 删除候选判定（§7.2）。stats 与 janitor 共用此函数（单一判定点）。
 */
export async function scanDeletionCandidates(
  config: Partial<LifecycleConfig> = {},
): Promise<DeletionCandidate[]> {
  const cfg = { ...DEFAULT_LIFECYCLE_CONFIG, ...config };
  const [rows, adoption] = await Promise.all([loadActiveRows(cfg.repo), loadAdoptionRates()]);

  const out: DeletionCandidate[] = [];
  for (const r of rows) {
    // 豁免条款（§7.2）
    if (r.freq < cfg.deleteMinFreq) continue;                       // 试用期保护
    if (r.source === "user_statement") continue;                    // 用户陈述永不自动删
    if (r.type === "profile" && (r.supportCount ?? 0) >= 3) continue; // profile 需巩固复核

    const a = adoption.get(r.id);
    const adoptionRate = a && a.injected > 0 ? a.adopted / a.injected : null;
    // 主判据：采纳率（无数据 = 信号不足，不定罪）
    if (adoptionRate === null || adoptionRate >= cfg.deleteMaxAdoptionRate) continue;
    // 辅助判据：utility/freq ≤ 阈值，或无足够 outcome 信号（utility=0 无法区分全败/无信号）
    const utilityRatio = r.freq > 0 ? r.utility / r.freq : 0;
    const noOutcomeSignal = r.utility === 0;
    if (utilityRatio > cfg.deleteMaxUtilityRatio && !noOutcomeSignal) continue;

    out.push({
      id: r.id,
      kind: r.type,
      freq: r.freq,
      utility: r.utility,
      adoptionRate,
      reason: `freq=${r.freq}≥${cfg.deleteMinFreq} 采纳率=${(adoptionRate * 100).toFixed(0)}%<${cfg.deleteMaxAdoptionRate * 100}% utility/freq=${utilityRatio.toFixed(2)}`,
    });
  }
  return out;
}

// ── review 队列 ──

async function reviewStats(): Promise<{ total: number; resolved: number; rejected: number; pending: number }> {
  const sql = getSql();
  const [r] = await sql`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE status != 'pending')::int AS resolved,
           count(*) FILTER (WHERE status = 'rejected')::int AS rejected,
           count(*) FILTER (WHERE status = 'pending')::int AS pending
    FROM memory_lifecycle_review
  `;
  return r as { total: number; resolved: number; rejected: number; pending: number };
}

/** 灰度判定：前 N 条进人工复核；之后误删率（rejected/resolved）<5% 转全自动 */
export function isAutoMode(
  stats: { total: number; resolved: number; rejected: number },
  cfg: LifecycleConfig,
): boolean {
  if (stats.total < cfg.deleteReviewFirstN) return false;
  if (stats.resolved === 0) return false;
  return stats.rejected / stats.resolved < cfg.autoApproveMaxRejectRate;
}

async function enqueueReview(c: DeletionCandidate, nowIso: string): Promise<boolean> {
  const sql = getSql();
  // rejected/pending 已存在的条目不再进队列
  const existing = await sql`
    SELECT 1 FROM memory_lifecycle_review WHERE entry_id = ${c.id} LIMIT 1
  `;
  if (existing.length > 0) return false;
  await sql`
    INSERT INTO memory_lifecycle_review (id, entry_id, reason, snapshot, status, created_at)
    VALUES (${generateId("lcr")}, ${c.id}, ${c.reason},
            ${sql.json({ freq: c.freq, utility: c.utility, adoptionRate: c.adoptionRate } as any)},
            'pending', ${nowIso})
  `;
  return true;
}

// ── 容量管理（§7.3）──

function utilityRatio(r: ActiveRow): number {
  // 从未注入（freq=0）的条目无低效用证据 → 排最后删除
  return r.freq > 0 ? r.utility / r.freq : Number.POSITIVE_INFINITY;
}

async function trimKind(
  rows: ActiveRow[],
  kind: string,
  cap: number,
  trimTo: number,
  engine: MemoryStoreEngine,
  nowIso: string,
): Promise<string[]> {
  const ofKind = rows.filter((r) => r.type === kind);
  if (ofKind.length <= cap) return [];
  const sorted = [...ofKind].sort((a, b) => utilityRatio(a) - utilityRatio(b) || a.tValid.localeCompare(b.tValid));
  const victims = sorted.slice(0, ofKind.length - trimTo);
  for (const v of victims) await engine.invalidate(v.id, nowIso);
  return victims.map((v) => v.id);
}

// ── 主函数 ──

export interface JanitorOptions {
  engine?: MemoryStoreEngine;
  config?: Partial<LifecycleConfig>;
  emit?: (event: RunEvent) => void;
  now?: () => Date;
}

export async function runLifecycleOnce(opts: JanitorOptions = {}): Promise<LifecycleReport> {
  const engine = opts.engine ?? new PostgresMemoryStoreEngine();
  const cfg = { ...DEFAULT_LIFECYCLE_CONFIG, ...opts.config };
  const nowIso = (opts.now ?? (() => new Date()))().toISOString();
  const sql = getSql();

  const report: LifecycleReport = {
    candidates: [],
    enqueuedForReview: [],
    autoInvalidated: [],
    alreadyInQueue: [],
    capacity: { episodicInvalidated: [], semanticInvalidated: [], trialDropped: [], profileOverCap: 0 },
    reviewQueuePending: 0,
    autoMode: false,
  };

  // ── 1. 删除候选（§7.2）──
  const candidates = await scanDeletionCandidates(cfg);
  report.candidates = candidates;

  const stats = await reviewStats();
  report.autoMode = isAutoMode(stats, cfg);
  report.reviewQueuePending = stats.pending;

  // 人工 reject 的条目永不自动删（复核结论优先，含全自动模式）
  const rejectedRows = report.autoMode
    ? await sql`SELECT entry_id FROM memory_lifecycle_review WHERE status = 'rejected'`
    : [];
  const rejectedIds = new Set((rejectedRows as unknown as { entry_id: string }[]).map((r) => r.entry_id));

  for (const c of candidates) {
    if (rejectedIds.has(c.id)) {
      report.alreadyInQueue.push(c.id);
      continue;
    }
    if (report.autoMode) {
      await engine.invalidate(c.id, nowIso);
      report.autoInvalidated.push(c.id);
    } else {
      const enqueued = await enqueueReview(c, nowIso);
      if (enqueued) report.enqueuedForReview.push(c.id);
      else report.alreadyInQueue.push(c.id);
    }
  }
  if (report.autoInvalidated.length > 0) {
    await appendOpLog("lifecycle.purge", {
      entryIds: report.autoInvalidated,
      detail: { reason: "utility_decay", auto: true },
    });
    opts.emit?.({ type: "memory.lifecycle.purge", entryIds: report.autoInvalidated, reason: "utility_decay" });
  }

  // ── 2. 容量管理（§7.3）──
  const rows = await loadActiveRows(cfg.repo);
  const episodicCut = await trimKind(rows, "episodic", cfg.episodicCap, cfg.episodicTrimTo, engine, nowIso);
  const semanticCut = await trimKind(rows, "semantic", cfg.semanticCap, cfg.semanticTrimTo, engine, nowIso);
  report.capacity.episodicInvalidated = episodicCut;
  report.capacity.semanticInvalidated = semanticCut;
  const capacityCut = [...episodicCut, ...semanticCut];
  if (capacityCut.length > 0) {
    await appendOpLog("lifecycle.purge", { entryIds: capacityCut, detail: { reason: "capacity" } });
    opts.emit?.({ type: "memory.lifecycle.purge", entryIds: capacityCut, reason: "capacity" });
  }

  // trial：超 cap FIFO + attemptsLeft 耗尽丢弃（物理删 trial 行）
  const trialRows = await sql`
    SELECT id FROM memory_trial_lessons
    ORDER BY created ASC
  `;
  const trialIds = (trialRows as unknown as { id: string }[]).map((r) => r.id);
  if (trialIds.length > cfg.trialCap) {
    const excess = trialIds.slice(0, trialIds.length - cfg.trialCap);
    await sql`DELETE FROM memory_trial_lessons WHERE id = ANY(${textArrayLiteral(excess)}::text[])`;
    report.capacity.trialDropped.push(...excess);
  }
  const exhausted = await sql`DELETE FROM memory_trial_lessons WHERE attempts_left <= 0 RETURNING id`;
  report.capacity.trialDropped.push(...(exhausted as unknown as { id: string }[]).map((r) => r.id));

  // profile 超限只报告（ADD/REMOVE/EDIT 裁决属 v2）
  const profileCount = rows.filter((r) => r.type === "profile").length;
  report.capacity.profileOverCap = Math.max(0, profileCount - cfg.profileCap);

  return report;
}

// ── review 队列操作（CLI 用）──

export interface ReviewRow {
  id: string;
  entryId: string;
  reason: string;
  snapshot: Record<string, unknown>;
  status: string;
  createdAt: string;
}

export async function listReviewQueue(status = "pending"): Promise<ReviewRow[]> {
  const sql = getSql();
  const rows = await sql`
    SELECT * FROM memory_lifecycle_review WHERE status = ${status} ORDER BY created_at ASC LIMIT 200
  `;
  return (rows as unknown as Record<string, unknown>[]).map((r) => ({
    id: r.id as string,
    entryId: r.entry_id as string,
    reason: r.reason as string,
    snapshot: (parseJson(r.snapshot) ?? {}) as Record<string, unknown>,
    status: r.status as string,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  }));
}

/** 批准：软失效该条目并关闭队列行 */
export async function approveReview(
  entryId: string,
  opts: { engine?: MemoryStoreEngine; emit?: (event: RunEvent) => void } = {},
): Promise<boolean> {
  const sql = getSql();
  const engine = opts.engine ?? new PostgresMemoryStoreEngine();
  const rows = await sql`
    UPDATE memory_lifecycle_review SET status = 'approved', resolved_at = now()
    WHERE entry_id = ${entryId} AND status = 'pending' RETURNING id
  `;
  if (rows.length === 0) return false;
  const nowIso = new Date().toISOString();
  await engine.invalidate(entryId, nowIso);
  await appendOpLog("lifecycle.purge", { entryIds: [entryId], detail: { reason: "utility_decay", review: "approved" } });
  opts.emit?.({ type: "memory.lifecycle.purge", entryIds: [entryId], reason: "utility_decay" });
  return true;
}

/** 拒绝：不删且不再进队列（§7.2 人工复核结论） */
export async function rejectReview(entryId: string): Promise<boolean> {
  const sql = getSql();
  const rows = await sql`
    UPDATE memory_lifecycle_review SET status = 'rejected', resolved_at = now()
    WHERE entry_id = ${entryId} AND status = 'pending' RETURNING id
  `;
  return rows.length > 0;
}
