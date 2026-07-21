/**
 * Memory Retriever (8.7)
 *
 * 结构化过滤 + 关键词匹配 + pgvector 向量检索（hybrid mode）。
 * 向量检索失败时自动降级为纯关键词。
 */

import { getSql } from "../../connection.js";
import { memoryItemDao } from "../../dao/memoryItem.js";
import type { MemoryItem, MemoryType, MemoryStatus } from "../../types.js";
import { PolicyEngine, type RetrievalPolicy } from "../platform/policyEngine.js";
import { NGramEmbeddingService, cosineSimilarity } from "../platform/embeddingService.js";
import { tokenizeForMemoryScore } from "../../../shared/memory-quality.js";

export interface RetrievalRequest {
  taskId: string;
  repositoryId?: string;
  userId?: string;
  query: string;
  types?: MemoryType[];
  limit?: number;
  minConfidence?: number;
}

export interface RetrievalResult {
  items: { memory: MemoryItem; score: number; matchReasons: string[] }[];
  degraded: boolean;
  retrievalMode: "memory_only" | "hybrid";
}

export type ScoredMemory = {
  memory: MemoryItem;
  score: number;
  matchReasons: string[];
};

/** 类型配额：偏好优先，限制 task_summary 噪声 */
const TYPE_QUOTA: Record<string, number> = {
  user_preference: 3,
  decision: 2,
  failure: 2,
  project_knowledge: 2,
  rule: 2,
  skill: 1,
  task_summary: 1,
};

/**
 * 按类型配额截断已排序（高分在前）的列表。
 * 导出供单测。
 */
export function applyTypeQuotas(
  scored: readonly ScoredMemory[],
  limit: number,
): ScoredMemory[] {
  const used: Record<string, number> = {};
  const out: ScoredMemory[] = [];
  for (const s of scored) {
    if (out.length >= limit) break;
    const t = s.memory.type || "unknown";
    const cap = TYPE_QUOTA[t] ?? 2;
    const n = used[t] ?? 0;
    if (n >= cap) continue;
    used[t] = n + 1;
    // task_summary 降权展示：已在 keywordScore 侧可选处理；此处只配额
    out.push(s);
  }
  return out;
}

export class MemoryRetriever {
  private policy: RetrievalPolicy;
  private embedder = new NGramEmbeddingService();

  constructor(policyEngine?: PolicyEngine) {
    this.policy = policyEngine?.getDefaults().retrieval ?? new PolicyEngine().getDefaults().retrieval;
  }

  async retrieve(req: RetrievalRequest): Promise<RetrievalResult> {
    const limit = req.limit ?? this.policy.topK;
    const minConfidence = req.minConfidence ?? this.policy.minScore;
    const query = (req.query ?? "").trim();

    // 空查询：不 dump 全库（旧逻辑用 confidence 打分会把 topK 全塞进 prompt）
    if (!query) {
      return { items: [], degraded: false, retrievalMode: "memory_only" };
    }

    // 结构化过滤
    const items = await memoryItemDao.query({
      type: req.types?.[0],
      status: "active",
      scopeRepoId: req.repositoryId,
      scopeUserId: req.userId,
      limit: limit * 3,
    });

    // 关键词评分
    const keywordScored = items.map((item) => ({
      memory: item,
      kwScore: this.keywordScore(item, query),
      matchReasons: this.matchReasons(item, query),
    }));

    // 尝试向量检索：对已过滤结果按 embedding 相似度重排
    try {
      const queryVec = await this.embedder.embed(req.query);
      const sql = getSql();
      // 批量查询已过滤 memory 的 embedding 向量
      const ids = keywordScored.map((ks) => ks.memory.id);
      if (ids.length > 0) {
        const embeddings = await sql`
          SELECT memory_id, embedding FROM memory_embeddings WHERE memory_id = ANY(${sql.array(ids)})
        `;
        const vecMap = new Map<string, number[]>();
        for (const r of embeddings as unknown as { memory_id: string; embedding: string }[]) {
          vecMap.set(r.memory_id, parseVector(r.embedding));
        }

        // 融合：有 embedding 则 0.7kw + 0.3vec，无 embedding 直接用 kwScore
        // 关键词分为 0 时，纯向量分数需达到更高阈值，避免无关项混入
        const fused = keywordScored.map((ks) => {
          const storedVec = vecMap.get(ks.memory.id);
          if (!storedVec) {
            return {
              memory: ks.memory,
              score: ks.kwScore,
              matchReasons: ks.matchReasons,
            };
          }
          const vecSim = cosineSimilarity(queryVec, storedVec);
          const score =
            ks.kwScore > 0
              ? ks.kwScore * 0.7 + vecSim * 0.3
              : vecSim * 0.45;
          return {
            memory: ks.memory,
            score,
            matchReasons: ks.matchReasons,
          };
        });
        const ranked = fused
          .filter((s) => s.score >= minConfidence)
          .sort((a, b) => b.score - a.score);
        return {
          items: applyTypeQuotas(ranked, limit),
          degraded: false,
          retrievalMode: "hybrid",
        };
      }
    } catch {
      // 向量检索不可用 → 降级为纯关键词
    }

    // 纯关键词降级
    const scored = keywordScored
      .map((ks) => ({
        memory: ks.memory,
        score: ks.kwScore,
        matchReasons: ks.matchReasons,
      }))
      .filter((s) => s.score >= minConfidence)
      .sort((a, b) => b.score - a.score);

    return {
      items: applyTypeQuotas(scored, limit),
      degraded: false,
      retrievalMode: "memory_only",
    };
  }

  private keywordScore(item: MemoryItem, query: string): number {
    const qTerms = tokenizeForMemoryScore(query);
    if (qTerms.length === 0) return 0;
    let score = 0;
    let hits = 0;
    const title = item.title.toLowerCase();
    const summary = item.summary.toLowerCase();
    const subjectKey = item.subjectKey.toLowerCase();
    const tags = (item.tags ?? []).join(" ").toLowerCase();
    for (const term of qTerms) {
      let termHit = false;
      if (title.includes(term)) {
        score += 0.4;
        termHit = true;
      }
      if (summary.includes(term)) {
        score += 0.3;
        termHit = true;
      }
      if (subjectKey.includes(term)) {
        score += 0.2;
        termHit = true;
      }
      if (tags.includes(term)) {
        score += 0.1;
        termHit = true;
      }
      if (termHit) hits += 1;
    }
    if (hits === 0) return 0;
    // 命中比例加权：避免长查询里偶然一词拉高无关记忆
    const coverage = hits / qTerms.length;
    let final = score * item.confidence * (0.5 + 0.5 * coverage);
    // task_summary 略降权，给 preference/decision 让位
    if (item.type === "task_summary") final *= 0.85;
    return Math.min(1.0, final);
  }

  private matchReasons(item: MemoryItem, query: string): string[] {
    const reasons: string[] = [];
    const qTerms = tokenizeForMemoryScore(query);
    for (const term of qTerms) {
      if (item.title.toLowerCase().includes(term)) reasons.push(`title:${term}`);
      if (item.summary.toLowerCase().includes(term)) reasons.push(`summary:${term}`);
      if (item.subjectKey.toLowerCase().includes(term)) reasons.push(`subject:${term}`);
    }
    return reasons.slice(0, 3);
  }

  async keywordSearch(keyword: string, limit = 10): Promise<MemoryItem[]> {
    const sql = getSql();
    const rows = await sql`
      SELECT * FROM memory_items
      WHERE status = 'active'
        AND (title ILIKE ${"%" + keyword + "%"} OR summary ILIKE ${"%" + keyword + "%"} OR subject_key ILIKE ${"%" + keyword + "%"})
      ORDER BY confidence DESC LIMIT ${limit}
    `;
    return rows.map((r) => {
      const row = r as Record<string, unknown>;
      return {
        id: row.id as string, type: row.type as MemoryType, subjectKey: row.subject_key as string,
        title: row.title as string, summary: row.summary as string, status: row.status as MemoryStatus,
        confidence: row.confidence as number, version: row.version as number,
        createdAt: row.created_at as string, updatedAt: row.updated_at as string,
      } as MemoryItem;
    });
  }
}

function parseVector(raw: unknown): number[] {
  if (Array.isArray(raw)) return raw as number[];
  if (typeof raw === "string") {
    try { return JSON.parse(raw) as number[]; } catch { return []; }
  }
  return [];
}
