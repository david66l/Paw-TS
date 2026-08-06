/**
 * 混合召回融合层（spec v2 §6.3）
 *
 * 两路召回（BM25/全文 + embedding）取并集打分：
 *   score(m) = α · normalize(bm25) + (1−α) · cos(emb(query), emb(m.key))
 *   α：T1(task_start)=0.5，T2(action_failed)=0.7（错误日志词面重叠主导）
 *
 * 硬默认（存储/检索层责任，非调用方责任）：
 * - 过滤 tInvalid≠null（引擎 searchText/searchVector 已过滤，此处二次兜底）
 * - 过滤 verification_status='invalidated' 的降级条目（引擎 SQL 层过滤）
 *
 * 排序附加分（小权重）：同 branch +0.05；source=user_statement +0.1；近 30 天 +0.05。
 *
 * 冷启动纪律：空库/无命中 → 返回空数组，零开销。
 * 降级（spec §6.7）：任一路失败 → 另一路单独工作，degraded=true。
 */

import type {
  MemoryEntry,
  MemoryKind,
  MemoryStoreEngine,
  ScoredId,
} from "../store/engine.js";

/** 各触发点的 α 取值（spec §6.3） */
export const RECALL_ALPHA = {
  /** T1 task_start：语义/词面各半 */
  taskStart: 0.5,
  /** T2 action_failed：错误日志词面重叠主导 */
  actionFailed: 0.7,
} as const;

/** 候选池大小（spec §6.3：top-10） */
export const RECALL_CANDIDATES = 10;

export const BONUS_SAME_BRANCH = 0.05;
export const BONUS_USER_STATEMENT = 0.1;
export const BONUS_RECENT = 0.05;
const RECENT_WINDOW_MS = 30 * 24 * 3600 * 1000;

export interface RecallContext {
  /** 当前任务分支：episodic 条目同 branch 附加分 */
  branch?: string;
  /** 可注入时钟（测试用），默认当前时间 */
  now?: Date;
}

export interface RecallOptions {
  /** BM25 权重，见 RECALL_ALPHA；默认 taskStart=0.5 */
  alpha?: number;
  /** 候选池上限，默认 10 */
  candidates?: number;
  /** 限定 kind */
  kind?: MemoryKind;
  context?: RecallContext;
}

export interface ScoredEntry {
  entry: MemoryEntry;
  /** 融合后总分（含附加分） */
  score: number;
  /** 归一化后的 BM25 分（0–1） */
  bm25Score: number;
  /** 余弦相似度（clamp 到 0–1） */
  vectorScore: number;
  /** 命中的附加分说明（如 "same_branch"） */
  bonuses: string[];
}

export interface RecallResult {
  items: ScoredEntry[];
  /** true = 某一路召回失败，结果仅来自单路 */
  degraded: boolean;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * 纯函数：融合两路命中并打分排序。
 * 抽出来供单测直接构造输入（不依赖 DB / 引擎）。
 */
export function fuseRecall(
  textHits: readonly ScoredId[],
  vectorHits: readonly ScoredId[],
  entriesById: ReadonlyMap<string, MemoryEntry>,
  opts: RecallOptions = {},
): ScoredEntry[] {
  const alpha = opts.alpha ?? RECALL_ALPHA.taskStart;
  const now = opts.context?.now ?? new Date();

  const textScoreById = new Map(textHits.map((h) => [h.id, h.score]));
  const vectorScoreById = new Map(vectorHits.map((h) => [h.id, h.score]));
  const maxText = Math.max(0, ...textHits.map((h) => h.score));

  const ids = [...new Set([...textScoreById.keys(), ...vectorScoreById.keys()])];
  const out: ScoredEntry[] = [];

  for (const id of ids) {
    const entry = entriesById.get(id);
    if (!entry) continue;
    // 硬默认二次兜底：软失效条目不进召回池
    if (entry.tInvalid != null) continue;
    if (opts.kind && entry.kind !== opts.kind) continue;

    const bm25 = maxText > 0 ? (textScoreById.get(id) ?? 0) / maxText : 0;
    const vector = clamp01(vectorScoreById.get(id) ?? 0);

    const bonuses: string[] = [];
    let bonus = 0;
    if (
      opts.context?.branch &&
      entry.kind === "episodic" &&
      entry.branch === opts.context.branch
    ) {
      bonus += BONUS_SAME_BRANCH;
      bonuses.push("same_branch");
    }
    if (entry.source === "user_statement") {
      bonus += BONUS_USER_STATEMENT;
      bonuses.push("user_statement");
    }
    const createdMs = Date.parse(entry.created);
    if (!Number.isNaN(createdMs) && now.getTime() - createdMs <= RECENT_WINDOW_MS) {
      bonus += BONUS_RECENT;
      bonuses.push("recent");
    }

    out.push({
      entry,
      score: alpha * bm25 + (1 - alpha) * vector + bonus,
      bm25Score: bm25,
      vectorScore: vector,
      bonuses,
    });
  }

  return out.sort((a, b) => b.score - a.score);
}

/**
 * 两路召回 + 融合打分的完整流程。
 * 任一路失败时降级为单路（spec §6.7），不抛错。
 */
export async function hybridRecall(
  engine: MemoryStoreEngine,
  queryText: string,
  opts: RecallOptions = {},
): Promise<RecallResult> {
  const k = opts.candidates ?? RECALL_CANDIDATES;

  // 冷启动纪律：空查询零开销
  if (!queryText.trim()) return { items: [], degraded: false };

  let textHits: ScoredId[] = [];
  let vectorHits: ScoredId[] = [];
  let degraded = false;

  try {
    textHits = await engine.searchText(queryText, k);
  } catch {
    degraded = true;
  }
  try {
    vectorHits = await engine.searchVector(queryText, k);
  } catch {
    degraded = true;
  }

  const ids = [...new Set([...textHits, ...vectorHits].map((h) => h.id))];
  if (ids.length === 0) return { items: [], degraded };

  const entriesById = new Map<string, MemoryEntry>();
  for (const id of ids) {
    try {
      const entry = await engine.get(id);
      if (entry) entriesById.set(id, entry);
    } catch {
      degraded = true;
    }
  }

  const items = fuseRecall(textHits, vectorHits, entriesById, opts).slice(0, k);
  return { items, degraded };
}
