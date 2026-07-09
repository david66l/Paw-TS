/**
 * Memory Evaluator
 *
 * 基于使用数据评估记忆质量。为 Self-Evolving Loop 提供决策依据。
 * MVP: 使用 memory_usage_records + audit_records 计算基础指标。
 */

import { getSql } from "../../connection.js";

export interface MemoryQualityScore {
  memoryId: string;
  usefulness: number;    // 0-1, 被成功使用的频率
  freshness: number;     // 0-1, 最近使用时间
  accuracy: number;      // 0-1, 用户纠正率（低=高准确度）
  overall: number;       // 0-1, 综合评分
  usageCount: number;
  lastUsedAt?: string;
  correctionCount: number;
  suggestion: "keep" | "review" | "deprecate" | "merge_candidate";
}

export class MemoryEvaluator {
  /**
   * 评估单条记忆的质量。
   */
  async evaluate(memoryId: string): Promise<MemoryQualityScore> {
    const sql = getSql();
    const now = Date.now();

    // 使用记录
    const usageRows = await sql`
      SELECT model_usage, outcome, user_feedback, recorded_at
      FROM memory_usage_records WHERE memory_id = ${memoryId}
      ORDER BY recorded_at DESC`;
    const usages = usageRows as unknown as { model_usage: string; outcome: string; user_feedback: string; recorded_at: string }[];

    // 审计记录（修正/删除）
    const auditRows = await sql`
      SELECT event_type, created_at FROM audit_records
      WHERE entity_type = 'memory' AND entity_id = ${memoryId}
      ORDER BY created_at DESC`;
    const audits = auditRows as unknown as { event_type: string; created_at: string }[];

    const usageCount = usages.length;
    const helpfulCount = usages.filter((u) => u.outcome === "helpful").length;
    const correctionCount = audits.filter((a) =>
      a.event_type === "memory_updated" || a.event_type === "memory_status_changed"
    ).length;
    const lastUsedAt = usages[0]?.recorded_at;

    // Usefulness: 被成功使用的比例
    const usefulness = usageCount > 0 ? helpfulCount / usageCount : 0.5;

    // Freshness: 最近使用时间（30 天内 = 1.0, 90 天 = 0.0）
    let freshness = 0.5;
    if (lastUsedAt) {
      const daysSince = (now - new Date(lastUsedAt).getTime()) / 86400000;
      freshness = Math.max(0, Math.min(1, 1 - daysSince / 90));
    }

    // Accuracy: 纠正越少越准确
    const accuracy = usageCount > 0 ? Math.max(0, 1 - correctionCount / (usageCount + correctionCount)) : 0.5;

    // Overall 综合
    const overall = usefulness * 0.4 + freshness * 0.3 + accuracy * 0.3;

    // 建议
    let suggestion: MemoryQualityScore["suggestion"] = "keep";
    if (overall < 0.3) suggestion = "deprecate";
    else if (overall < 0.5) suggestion = "review";
    else if (correctionCount > 3 && accuracy < 0.6) suggestion = "merge_candidate";

    return { memoryId, usefulness, freshness, accuracy, overall, usageCount, lastUsedAt, correctionCount, suggestion };
  }

  /**
   * 批量评估：获取所有需要检查的记忆 ID 列表。
   */
  async findLowQualityMemories(_threshold = 0.4): Promise<string[]> {
    const sql = getSql();
    // 查找使用率低或长期未使用的 active 记忆
    const rows = await sql`
      SELECT m.id FROM memory_items m
      LEFT JOIN memory_usage_records u ON u.memory_id = m.id
      WHERE m.status = 'active'
      GROUP BY m.id
      HAVING COUNT(u.id) = 0
         OR MAX(u.recorded_at) < now() - INTERVAL '30 days'
      LIMIT 100`;
    return (rows as unknown as { id: string }[]).map((r) => r.id);
  }

  /**
   * 查找可合并的重复记忆（同 type + 相似 title）。
   */
  async findDuplicatePairs(): Promise<{ idA: string; idB: string; score: number }[]> {
    const sql = getSql();
    const rows = await sql`
      SELECT a.id AS id_a, b.id AS id_b, similarity(a.title, b.title) AS sim
      FROM memory_items a
      JOIN memory_items b ON a.type = b.type AND a.id < b.id AND a.status = 'active' AND b.status = 'active'
      WHERE similarity(a.title, b.title) > 0.6
      ORDER BY sim DESC LIMIT 20`;
    return (rows as unknown as { id_a: string; id_b: string; sim: number }[]).map((r) => ({
      idA: r.id_a, idB: r.id_b, score: Number(r.sim),
    }));
  }
}
