/**
 * Admin API — 管理界面后端
 *
 * 提供查看、审批、拒绝 pending 候选记忆的能力。
 * MVP: 函数接口，不实现 HTTP 路由（由上层 API 层调用）。
 */

import { memoryCandidateDao } from "../../dao/memoryCandidate.js";
import { governanceDecisionDao } from "../../dao/governanceDecision.js";
import { memoryItemDao } from "../../dao/memoryItem.js";
import { MemoryGovernance } from "../write/memoryGovernance.js";
import { MemoryStore } from "../write/memoryStore.js";
import type { MemoryCandidate, GovernanceDecision, MemoryItem, ActorRef } from "../../types.js";

export const admin = {
  /** 列出待处理的候选 */
  async listPendingCandidates(limit = 20): Promise<MemoryCandidate[]> {
    return memoryCandidateDao.listByStatus("draft", limit);
  },

  /** 批准候选（人工审批 → 执行写入） */
  async approveCandidate(
    candidateId: string,
    reviewer: ActorRef = { actorType: "human_reviewer", actorId: "admin" },
  ): Promise<{ decision: GovernanceDecision; memoryId?: string }> {
    const governance = new MemoryGovernance();
    const store = new MemoryStore();

    // 1. 评估
    const { decision } = await governance.evaluate({
      candidateId,
      decidedBy: reviewer,
    });

    // 2. 持久化 decision
    await governanceDecisionDao.create(decision);

    // 3. 如果是 APPROVED，执行写入
    if (decision.status === "APPROVED") {
      const result = await store.execute(decision);
      if (result.success) {
        await governanceDecisionDao.execute(decision.id, result.memoryId!, {
          resultingStatus: "active",
        });
      }
      return { decision, memoryId: result.memoryId };
    }

    return { decision };
  },

  /** 拒绝候选 */
  async rejectCandidate(
    candidateId: string,
    reason: string,
    reviewer: ActorRef = { actorType: "human_reviewer", actorId: "admin" },
  ): Promise<GovernanceDecision> {
    const decision: GovernanceDecision = {
      id: `gov_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      schemaVersion: 1,
      candidateId,
      decision: "REJECT",
      reasons: [{ code: "MANUAL_REJECT", description: reason }],
      requiredActions: [],
      policyVersion: "1.0",
      decidedBy: reviewer,
      status: "REJECTED",
      decidedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };

    await governanceDecisionDao.create(decision);
    await memoryCandidateDao.updateStatus(candidateId, "rejected");
    return decision;
  },

  /** 列出所有记忆 */
  async listMemories(type?: string, limit = 20): Promise<MemoryItem[]> {
    return memoryItemDao.query({
      type: type as MemoryItem["type"],
      status: "active",
      limit,
    });
  },

  /** 查看记忆统计 */
  async stats(): Promise<{
    totalMemories: number;
    byType: Record<string, number>;
    byStatus: Record<string, number>;
    pendingCandidates: number;
  }> {
    const allItems = await memoryItemDao.query({ limit: 1000 });
    const byType: Record<string, number> = {};
    const byStatus: Record<string, number> = {};

    for (const item of allItems) {
      byType[item.type] = (byType[item.type] ?? 0) + 1;
      byStatus[item.status] = (byStatus[item.status] ?? 0) + 1;
    }

    const allPending = await memoryCandidateDao.listByStatus("draft", 1000);

    return {
      totalMemories: allItems.length,
      byType,
      byStatus,
      pendingCandidates: allPending.length,
    };
  },
};
