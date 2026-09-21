/**
 * 相对时间窗口：解析与检索层重排。
 * ==================================
 *
 * 从 `evidence-resolution-pass.ts` 的 `resolveEvidencePass` 抽出（docs/CODE-REVIEW.md §M4）。
 * 那个函数 1500+ 行，其中**两处**共用同一段前导 —— 解析 cutoff → 守卫有限性 →
 * 调 `extractRelativeTimeWindowV1` → 失败即放弃：
 *
 * - `:712-736` 用窗口对命中做稳定重排；
 * - `:1189-1205` 用窗口给证据包需求标签拼一个 `[时间窗:…]` 后缀。
 *
 * 两处的失败默认值不同（重排保持原序；标签保持空串），所以这里只收敛**解析**
 * 与**重排**两件事，不收敛失败后的动作 —— 调用点各自决定回退成什么。
 *
 * 这样做的直接收益：§M4 点名的那条不变量（"这是软加权，不是硬过滤"）从一个
 * 千行函数内部的匿名 `try` 块，变成一个具名且可单独测试的函数。
 */

// 从**定义处**导入，而不是走 evidence-first.js 那个转发门面（§M5 记的就是
// "公开符号 grep 不到实现"）。类型定义在 evidence-contracts.ts:140。
import type { MemoryEvidenceNotebookHitV1 } from "../evidence-contracts.js";
import {
  type MeaRelativeTimeWindowV1,
  extractRelativeTimeWindowV1,
} from "../relative-time-anchor.js";

/** 需求维度的命中分组（与 `resolveEvidencePass` 内部同形）。 */
export type RequirementHitsV1 = readonly (readonly MemoryEvidenceNotebookHitV1[])[];

/**
 * 解析相对时间窗口；未提供上界、上界不可解析、问题无时间短语、
 * 或提取过程抛错时，一律返回 `undefined`。
 *
 * 注意 `extractRelativeTimeWindowV1` 内部已经守卫了 `Number.isFinite(cutoffMs)`
 * （`relative-time-anchor.ts:234`），这里再挡一次的作用是在"未提供上界"时
 * 不进入调用 —— 那个参数不是可选的。
 */
export function resolveRelativeTimeWindowV1(
  query: string,
  evidenceTimeUpperBound: string | undefined,
): MeaRelativeTimeWindowV1 | undefined {
  try {
    const cutoffMs = evidenceTimeUpperBound ? Date.parse(evidenceTimeUpperBound) : undefined;
    if (cutoffMs === undefined || !Number.isFinite(cutoffMs)) return undefined;
    return extractRelativeTimeWindowV1(query, cutoffMs) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * 按窗口对命中做**稳定**重排：窗口内优先，组内保序。
 *
 * 这是软加权，不是硬过滤 —— 窗口外的命中仍然留在结果里，只是排在后面。
 * 没有窗口时返回入参本身（同一个引用，调用方可以据此判断"零触发"）。
 *
 * 单遍分类，而不是原先的"两次 `filter` + `includes`"：后者是 O(n²)，
 * 且依赖对象同一性做集合判定。逐条判定的结果与之一致，但不再需要
 * 用 `includes` 反推补集。
 */
export function reorderHitsByRelativeTimeWindowV1(
  requirementHits: RequirementHitsV1,
  window: MeaRelativeTimeWindowV1 | undefined,
): RequirementHitsV1 {
  if (!window) return requirementHits;
  return requirementHits.map((hits) => {
    const inWindow: MemoryEvidenceNotebookHitV1[] = [];
    const outWindow: MemoryEvidenceNotebookHitV1[] = [];
    for (const hit of hits) {
      const observed = hit.observedAt ? Date.parse(hit.observedAt) : undefined;
      const inside =
        observed !== undefined &&
        Number.isFinite(observed) &&
        observed >= window.startMs &&
        observed < window.endMs;
      if (inside) {
        inWindow.push(hit);
      } else {
        outWindow.push(hit);
      }
    }
    return Object.freeze([...inWindow, ...outWindow]);
  });
}

/**
 * 解析窗口并重排，**保证不抛**：任何失败都返回入参原序。
 *
 * 与原先 `:712-736` 那个 `try` 块的语义逐字对应 —— 排序增强失败绝不阻断主流程。
 */
export function applyRelativeTimeReorderV1(
  requirementHits: RequirementHitsV1,
  query: string,
  evidenceTimeUpperBound: string | undefined,
): RequirementHitsV1 {
  try {
    const window = resolveRelativeTimeWindowV1(query, evidenceTimeUpperBound);
    if (!window) return requirementHits;
    return reorderHitsByRelativeTimeWindowV1(requirementHits, window);
  } catch {
    // 排序增强失败保持原序，绝不阻断主流程。
    return requirementHits;
  }
}
