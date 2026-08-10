/**
 * 效用账本辅助（spec v2 §4.2 / §10.3，供 M6 检索管线与 M7 生命周期调用）
 *
 * M1 的引擎已提供单条 bumpLedger；这里补批量记账与采纳率记录：
 * - recordRetrievalHits：检索命中（实际注入）→ 每条 freq+1
 * - recordTaskSuccess：任务成功 → 该任务注入过的条目 utility+1
 * - recordAdoption：采纳事件写 op-log（op=read.adopted），采纳率的原始数据
 *
 * 采纳率口径（spec §10.3）：注入后同 run 内轨迹实际引用/遵循该经验的比例。
 * 判定（M6/M8 接线）：注入后 20 步内出现该经验的关键词/操作序列，
 * 或失败任务随后成功且路径与经验建议一致；规则匹配为主，抽样 LLM-judge 校准。
 * 本模块只负责忠实记录；stats.ts 按 注入数 vs 采纳数 聚合出比率。
 */

import type { MemoryStoreEngine } from "../store/engine.js";
import { appendOpLog } from "./op-log.js";

/** 批量记 freq+1（注入即命中）。单条失败不阻塞其余。 */
export async function recordRetrievalHits(
  engine: MemoryStoreEngine,
  entryIds: readonly string[],
  opts: { runId?: string; detail?: Record<string, unknown> } = {},
): Promise<void> {
  for (const id of entryIds) {
    try {
      await engine.bumpLedger(id, "freq");
    } catch { /* 账本允许近似（spec §4.4），单条失败可丢 */ }
  }
  await appendOpLog("read.inject", {
    runId: opts.runId,
    entryIds: [...entryIds],
    detail: opts.detail ?? {},
  });
}

/** 批量记 utility+1（任务成功结算）。 */
export async function recordTaskSuccess(
  engine: MemoryStoreEngine,
  entryIds: readonly string[],
): Promise<void> {
  for (const id of entryIds) {
    try {
      await engine.bumpLedger(id, "utility");
    } catch { /* 同上 */ }
  }
}

/**
 * 记一条采纳事件：runId 任务实际引用/遵循了 entryIds 中的经验。
 * 判定逻辑：detectAdoption（规则初筛）/ M8 评测 LLM-judge 校准，此处只落 op-log。
 */
export async function recordAdoption(
  runId: string,
  entryIds: readonly string[],
  detail: Record<string, unknown> = {},
): Promise<void> {
  await appendOpLog("read.adopted", { runId, entryIds: [...entryIds], detail });
}

// ── 采纳判定（spec §10.3，规则匹配为主的纯函数初筛）──

/** detectAdoption 的输入条目特征（从注入条目中提取） */
export interface AdoptionProbe {
  id: string;
  /** semantic 的 keywords */
  keywords?: string[];
  /** episodic 的 modification（操作建议序列） */
  modifications?: string[];
}

function normalizeText(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * 判定注入条目是否在轨迹中被实际引用/遵循（§10.3 口径的规则近似）：
 * - 条目任一 keyword（≥4 字符）出现在轨迹文本中；或
 * - 任一 modification 的内容词（>3 字符）≥60% 出现在轨迹文本中
 * 返回被采纳的条目 id。规则为主，抽样 LLM-judge 校准（§10.3）。
 */
export function detectAdoption(
  injected: readonly AdoptionProbe[],
  trajectoryText: string,
): string[] {
  const text = normalizeText(trajectoryText);
  if (!text) return [];
  const out: string[] = [];
  for (const probe of injected) {
    const kwHit = (probe.keywords ?? []).some((k) => {
      const nk = normalizeText(k);
      return nk.length >= 4 && text.includes(nk);
    });
    const modHit = (probe.modifications ?? []).some((m) => {
      const words = normalizeText(m).split(" ").filter((w) => w.length > 3);
      if (words.length === 0) return false;
      const hits = words.filter((w) => text.includes(w)).length;
      return hits / words.length >= 0.6;
    });
    if (kwHit || modHit) out.push(probe.id);
  }
  return out;
}

/** 从 MemoryEntry 提取采纳探针（keywords/modification 按 kind 映射） */
export function probeFromEntry(entry: {
  id: string;
  kind: string;
  keywords?: string[];
  modification?: string[];
}): AdoptionProbe {
  return { id: entry.id, keywords: entry.keywords, modifications: entry.modification };
}
