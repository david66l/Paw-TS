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
  opts: { runId?: string } = {},
): Promise<void> {
  for (const id of entryIds) {
    try {
      await engine.bumpLedger(id, "freq");
    } catch { /* 账本允许近似（spec §4.4），单条失败可丢 */ }
  }
  await appendOpLog("read.inject", {
    runId: opts.runId,
    entryIds: [...entryIds],
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
 * 判定逻辑在调用方（M6 检索管线/M8 评测），此处只落 op-log。
 */
export async function recordAdoption(
  runId: string,
  entryIds: readonly string[],
  detail: Record<string, unknown> = {},
): Promise<void> {
  await appendOpLog("read.adopted", { runId, entryIds: [...entryIds], detail });
}
