/**
 * Memory Store (8.6)
 *
 * 执行已批准的 GovernanceDecision，创建/更新 memory_items。
 * 这是正式记忆的唯一写入入口。
 *
 * 铁律:
 * - 只有 APPROVED 状态的 GovernanceDecision 才能执行
 * - 同一 decisionId 只能执行一次（幂等）
 * - 写入使用 version 乐观锁
 */

import { governanceDecisionDao } from "../../dao/governanceDecision.js";
import { memoryItemDao } from "../../dao/memoryItem.js";
import { memoryCandidateDao } from "../../dao/memoryCandidate.js";
import { getSql } from "../../connection.js";
import type { GovernanceDecision, MemoryItem, MemoryStatus, ScopeDescriptor } from "../../types.js";
import { generateId } from "../platform/idGen.js";
import { NGramEmbeddingService, storeEmbedding } from "../platform/embeddingService.js";

export interface ExecuteResult {
  success: boolean;
  memoryId?: string;
  newVersion?: number;
  reason?: string;
}

export class MemoryStore {
  /**
   * 执行已批准的 GovernanceDecision。
   *
   * APPROVE_CREATE → 创建新的 memory_item
   * APPROVE_UPDATE → 更新已有 memory_item（version 乐观锁）
   * APPROVE_MERGE → 将候选合并到已有 memory_item
   *
   * 幂等：同一 decisionId 重复调用返回首次结果。
   */
  async execute(decision: GovernanceDecision): Promise<ExecuteResult> {
    // 幂等检查
    if (decision.status === "EXECUTED") {
      return {
        success: true,
        memoryId: decision.resultingMemoryId,
        reason: "already_executed",
      };
    }

    // 只有 APPROVED 的才执行
    if (decision.status !== "APPROVED") {
      return { success: false, reason: `Decision not approved (current: ${decision.status})` };
    }

    switch (decision.decision) {
      case "APPROVE_CREATE":
        return this.handleCreate(decision);
      case "APPROVE_UPDATE":
        return this.handleUpdate(decision);
      case "APPROVE_MERGE":
        return this.handleMerge(decision);
      default:
        return { success: false, reason: `Unsupported action: ${decision.decision}` };
    }
  }

  /**
   * 创建新 memory_item。
   */
  private async handleCreate(decision: GovernanceDecision): Promise<ExecuteResult> {
    const candidate = await memoryCandidateDao.findById(decision.candidateId);
    if (!candidate) return { success: false, reason: "Candidate not found" };

    const now = new Date().toISOString();
    const memoryId = generateId("mem");

    const item: MemoryItem = {
      id: memoryId,
      schemaVersion: 1,
      type: decision.adjustedType ?? candidate.proposedType,
      subjectKey: candidate.proposedSubjectKey ?? `${candidate.proposedType}:${memoryId}`,
      subjectKeyVersion: candidate.subjectKeyVersion,
      title: candidate.proposedTitle,
      summary: candidate.proposedSummary,
      status: (decision.resultingStatus as MemoryStatus) ?? "active",
      scope: (decision.adjustedScope as ScopeDescriptor) ?? (candidate.proposedScope as ScopeDescriptor),
      confidence: decision.adjustedConfidence ?? candidate.proposedConfidence,
      verificationStatus: "unverified",
      payload: (decision.adjustedPayload as Record<string, unknown>) ?? candidate.proposedPayload,
      tags: [],
      relatedFiles: [],
      relatedSymbols: [],
      relatedTestRunIds: [],
      sensitivity: candidate.sensitivity,
      version: 1,
      createdBy: decision.decidedBy,
      updatedBy: decision.decidedBy,
      createdAt: now,
      updatedAt: now,
    } as unknown as MemoryItem;

    await memoryItemDao.create(item);

    // 异步生成 embedding（不阻塞写入）
    try {
      const embedder = new NGramEmbeddingService();
      const text = `${item.title} ${item.summary}`;
      const vec = await embedder.embed(text);
      await storeEmbedding(memoryId, item.version.toString(), vec);
    } catch { /* embedding 失败不影响记忆写入 */ }

    // 标记决策已执行
    await governanceDecisionDao.execute(decision.id, memoryId, {
      resultingStatus: "active",
      executedAt: now,
    });

    // 标记候选已晋升
    await memoryCandidateDao.updateStatus(candidate.id, "promoted");

    // 写入 Outbox 事件（幂等：sequence 用 increment）
    const sql = getSql();
    await sql.unsafe(
      `INSERT INTO outbox_events (id, event_type, aggregate_type, aggregate_id, memory_id, memory_version, payload, sequence, transaction_id, status, created_at)
       VALUES ($1, 'MemoryCreated', 'memory', $2, $3, 1, '{}', (SELECT COALESCE(MAX(sequence), 0) + 1 FROM outbox_events WHERE aggregate_id = $2), $4, 'pending', now())`,
      [generateId("outbox"), memoryId, memoryId, generateId("tx")],
    );

    return { success: true, memoryId, newVersion: 1 };
  }

  /**
   * 更新已有 memory_item。
   */
  private async handleUpdate(decision: GovernanceDecision): Promise<ExecuteResult> {
    const targetId = decision.targetMemoryId;
    if (!targetId) return { success: false, reason: "Missing targetMemoryId for update" };

    const existing = await memoryItemDao.findById(targetId);
    if (!existing) return { success: false, reason: `Memory ${targetId} not found` };

    if (decision.expectedVersion !== undefined && existing.version !== decision.expectedVersion) {
      return { success: false, reason: `Version conflict: expected ${decision.expectedVersion}, actual ${existing.version}` };
    }

    const patch: Parameters<typeof memoryItemDao.update>[2] = {};
    if (decision.adjustedPayload) patch.payload = decision.adjustedPayload as Record<string, unknown>;
    if (decision.adjustedConfidence !== undefined) patch.confidence = decision.adjustedConfidence;
    if (decision.resultingStatus) patch.status = decision.resultingStatus as MemoryStatus;
    if (decision.adjustedScope) patch.scope = decision.adjustedScope as ScopeDescriptor;

    const updated = await memoryItemDao.update(targetId, existing.version, patch);
    if (!updated) return { success: false, reason: "Update failed (version conflict)" };

    await governanceDecisionDao.execute(decision.id, targetId, {
      resultingStatus: updated.status,
      executedAt: new Date().toISOString(),
    });

    return { success: true, memoryId: targetId, newVersion: updated.version };
  }

  /**
   * 合并候选到已有 memory_item。
   * MVP: 简单追加 evidence + 更新 confidence。
   */
  private async handleMerge(decision: GovernanceDecision): Promise<ExecuteResult> {
    const targetId = decision.targetMemoryId;
    if (!targetId) return { success: false, reason: "Missing targetMemoryId for merge" };

    const existing = await memoryItemDao.findById(targetId);
    if (!existing) return { success: false, reason: `Memory ${targetId} not found` };

    // 简单合并策略：平均置信度
    const newConfidence = (existing.confidence + (decision.adjustedConfidence ?? 0.5)) / 2;

    const updated = await memoryItemDao.update(targetId, existing.version, {
      confidence: newConfidence,
      verificationStatus: existing.verificationStatus === "verified" ? "verified" : "partially_verified",
    });

    if (!updated) return { success: false, reason: "Merge failed (version conflict)" };

    await governanceDecisionDao.execute(decision.id, targetId, {
      resultingStatus: updated.status,
      executedAt: new Date().toISOString(),
    });

    const candidate = await memoryCandidateDao.findById(decision.candidateId);
    if (candidate) {
      await memoryCandidateDao.updateStatus(candidate.id, "promoted");
    }

    return { success: true, memoryId: targetId, newVersion: updated.version };
  }
}
