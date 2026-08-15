/**
 * Profile 画像写入（spec v2 §4.2 / §7.3 / §12.3）
 *
 * - 证据门槛：supportCount / evidence.length ≥ 3 才允许存在
 * - 行为描述式：拒绝空形容词（"很谨慎"），要求可操作行为描述
 * - 容量硬上限 15：满时须经 ADD/REMOVE/EDIT 裁决——相似则 EDIT 合并，
 *   否则 REMOVE 效用最低者腾位再 ADD；不得因「当前无关」乱删（启发式只按效用）
 *
 * 巩固调度（每周/每 20 任务从 episodic 抽象）属 v3（§7.6）；本模块提供可调用的
 * 写入门面，供 CLI / 管线 / janitor 容量强制使用。
 */

import type { MemoryStoreEngine, ProfileInsight } from "../store/engine.js";
import { deriveEntryId } from "../store/id.js";
import { appendOpLog } from "../observability/op-log.js";

export const PROFILE_CAP = 15;
export const PROFILE_MIN_SUPPORT = 3;

export interface ProfileDraft {
  insight: string;
  /** 证据指针（episodic/run id 等），长度即 supportCount 下限 */
  evidence: string[];
  repo: string;
  source?: ProfileInsight["source"];
  confidence?: number;
}

export type AdmitProfileResult =
  | { status: "written"; memoryId: string; op: "ADD" }
  | { status: "edited"; memoryId: string; op: "EDIT"; mergedFrom?: string }
  | {
      status: "written";
      memoryId: string;
      op: "ADD";
      removedId: string;
    }
  | { status: "rejected"; reason: string };

export interface AdmitProfileOptions {
  engine: MemoryStoreEngine;
  now?: () => Date;
  /** 画像容量上限，默认 15 */
  cap?: number;
  runId?: string;
  /** Injectable best-effort observation sink; core decisions never depend on it. */
  recordOp?: typeof appendOpLog;
}

/** 行为描述式检查（§7.6）：拒绝纯形容词空洞画像 */
export function isBehaviorDescription(insight: string): boolean {
  const s = insight.trim();
  if (s.length < 8) return false;
  // 「很谨慎」「非常仔细」「is cautious」
  if (/^(?:很|非常|比较|挺|有点)\S{1,8}$/u.test(s)) return false;
  if (/^(?:is|are|seems?|feels?)\s+[a-z-]+$/i.test(s)) return false;
  return true;
}

export function validateProfileDraft(
  draft: ProfileDraft,
): { ok: true; supportCount: number } | { ok: false; reason: string } {
  const insight = draft.insight?.trim() ?? "";
  if (!insight) return { ok: false, reason: "empty_insight" };
  if (!isBehaviorDescription(insight)) return { ok: false, reason: "not_behavior_description" };
  const evidence = (draft.evidence ?? []).map((e) => e.trim()).filter(Boolean);
  const unique = [...new Set(evidence)];
  if (unique.length < PROFILE_MIN_SUPPORT) {
    return { ok: false, reason: `evidence_below_${PROFILE_MIN_SUPPORT}` };
  }
  if (!draft.repo?.trim()) return { ok: false, reason: "missing_repo" };
  return { ok: true, supportCount: unique.length };
}

/**
 * 词面重叠（用于 EDIT 合并判定）：共享 ≥2 个特征视为同主题。
 * 拉丁：≥4 字符词；中文：二字滑动窗口（整句 `{2,}` 贪婪会吞成单 token，导致永不命中）。
 */
export function profileSimilarity(a: string, b: string): number {
  const terms = (s: string) => {
    const out = new Set<string>();
    const lower = s.toLowerCase();
    const lat = /[a-z0-9]{4,}/g;
    let m: RegExpExecArray | null;
    while ((m = lat.exec(lower))) out.add(m[0]!);
    const chars = [...s].filter((c) => /[\u4e00-\u9fff]/u.test(c));
    for (let i = 0; i < chars.length - 1; i++) {
      out.add(chars[i]! + chars[i + 1]!);
    }
    return out;
  };
  const A = terms(a);
  const B = terms(b);
  if (A.size === 0 || B.size === 0) return 0;
  let hits = 0;
  for (const t of A) if (B.has(t)) hits += 1;
  return hits;
}

function utilityScore(p: ProfileInsight): number {
  // 效用低者优先腾位；freq=0 时用 utility 本身
  if (p.freq <= 0) return p.utility;
  return p.utility / p.freq;
}

async function listActiveProfiles(
  engine: MemoryStoreEngine,
  repo: string,
): Promise<ProfileInsight[]> {
  const rows = await engine.query({ kind: "profile", repo, limit: 200 });
  return rows.filter((e): e is ProfileInsight => e.kind === "profile" && e.tInvalid == null);
}

/**
 * 写入一条画像：证据门槛 → 相似 EDIT → 容量腾位 ADD。
 */
export async function admitProfile(
  draft: ProfileDraft,
  opts: AdmitProfileOptions,
): Promise<AdmitProfileResult> {
  const recordOp = opts.recordOp ?? appendOpLog;
  const checked = validateProfileDraft(draft);
  if (!checked.ok) {
    await recordOp("write.rejected", {
      runId: opts.runId,
      detail: { reason: checked.reason, kind: "profile" },
    });
    return { status: "rejected", reason: checked.reason };
  }

  const nowIso = (opts.now?.() ?? new Date()).toISOString();
  const evidence = [...new Set(draft.evidence.map((e) => e.trim()).filter(Boolean))];
  const cap = opts.cap ?? PROFILE_CAP;
  const existing = await listActiveProfiles(opts.engine, draft.repo);

  // 同主题 → EDIT 合并（不占新名额）
  let best: { entry: ProfileInsight; hits: number } | null = null;
  for (const e of existing) {
    const hits = profileSimilarity(draft.insight, e.insight);
    if (hits >= 2 && (!best || hits > best.hits)) best = { entry: e, hits };
  }
  if (best) {
    const mergedEvidence = [...new Set([...best.entry.evidence, ...evidence])];
    const updated: ProfileInsight = {
      ...best.entry,
      insight: draft.insight.trim().length >= best.entry.insight.length
        ? draft.insight.trim()
        : best.entry.insight,
      supportCount: Math.max(best.entry.supportCount, mergedEvidence.length, PROFILE_MIN_SUPPORT),
      evidence: mergedEvidence,
      confidence: Math.max(best.entry.confidence, draft.confidence ?? 0.7),
      // 不改 id：内容哈希若变会成新 id；EDIT 语义是原地更新同 id
      // 用原 id 强制 put（引擎 derive 若不同会插新行）——此处保持 insight 合并后仍 put 原 payload id
    };
    // 强制沿用原 id，避免内容哈希漂移成 ADD
    const withId = { ...updated, id: best.entry.id };
    await opts.engine.put(withId);
    await recordOp("governed", {
      runId: opts.runId,
      entryIds: [best.entry.id],
      detail: { op: "EDIT", kind: "profile", supportCount: withId.supportCount },
    });
    return { status: "edited", memoryId: best.entry.id, op: "EDIT" };
  }

  const candidate: ProfileInsight = {
    id: "",
    kind: "profile",
    repo: draft.repo,
    created: nowIso,
    tValid: nowIso,
    tInvalid: null,
    source: draft.source ?? "agent_inferred",
    confidence: draft.confidence ?? 0.7,
    evidence,
    freq: 0,
    utility: 0,
    insight: draft.insight.trim(),
    supportCount: checked.supportCount,
  };

  let removedId: string | undefined;
  if (existing.length >= cap) {
    // REMOVE：效用最低且非 user_statement（§7.3：满时先腾位；不得因当前无关）
    const removable = existing
      .filter((p) => p.source !== "user_statement")
      .sort((a, b) => {
        const ua = utilityScore(a);
        const ub = utilityScore(b);
        if (ua !== ub) return ua - ub;
        return a.freq - b.freq;
      });
    const victim = removable[0];
    if (!victim) {
      await recordOp("write.rejected", {
        runId: opts.runId,
        detail: { reason: "profile_cap_no_removable", kind: "profile", cap },
      });
      return { status: "rejected", reason: "profile_cap_no_removable" };
    }
    await opts.engine.invalidate(victim.id, nowIso);
    removedId = victim.id;
    await recordOp("governed", {
      runId: opts.runId,
      entryIds: [victim.id],
      detail: { op: "REMOVE", kind: "profile", reason: "capacity" },
    });
  }

  await opts.engine.put(candidate);
  const memoryId = candidate.id || deriveEntryId(candidate, opts.engine.scope);
  await recordOp("governed", {
    runId: opts.runId,
    entryIds: [memoryId],
    detail: { op: "ADD", kind: "profile", supportCount: candidate.supportCount, removedId },
  });

  if (removedId) {
    return { status: "written", memoryId, op: "ADD", removedId };
  }
  return { status: "written", memoryId, op: "ADD" };
}

/**
 * 容量强制（janitor 用）：活跃画像超过 cap 时，按效用升序软失效多余条目，
 * 直到 ≤ cap。user_statement 豁免。
 */
export async function enforceProfileCapacity(
  engine: MemoryStoreEngine,
  opts: {
    repo?: string;
    cap?: number;
    now?: () => Date;
    runId?: string;
    recordOp?: typeof appendOpLog;
  } = {},
): Promise<string[]> {
  const recordOp = opts.recordOp ?? appendOpLog;
  const cap = opts.cap ?? PROFILE_CAP;
  const nowIso = (opts.now?.() ?? new Date()).toISOString();
  const filter = opts.repo
    ? { kind: "profile" as const, repo: opts.repo, limit: 200 }
    : { kind: "profile" as const, limit: 500 };
  const rows = (await engine.query(filter)).filter(
    (e): e is ProfileInsight => e.kind === "profile" && e.tInvalid == null,
  );
  if (rows.length <= cap) return [];

  const removable = rows
    .filter((p) => p.source !== "user_statement")
    .sort((a, b) => {
      const ua = utilityScore(a);
      const ub = utilityScore(b);
      if (ua !== ub) return ua - ub;
      return a.freq - b.freq;
    });

  const need = rows.length - cap;
  const victims = removable.slice(0, need);
  for (const v of victims) {
    await engine.invalidate(v.id, nowIso);
  }
  if (victims.length > 0) {
    await recordOp("lifecycle.purge", {
      runId: opts.runId,
      entryIds: victims.map((v) => v.id),
      detail: { reason: "profile_capacity", cap },
    });
  }
  return victims.map((v) => v.id);
}
