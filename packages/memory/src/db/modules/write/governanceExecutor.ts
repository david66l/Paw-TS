/**
 * Governance Executor (8.11.14)
 *
 * 接收已批准的 GovernanceDecision，校验前置条件，在事务中执行变更。
 * 与 Governance Evaluator 分离：Evaluator 回答"是否应该变更"，Executor 回答"现在能否执行"。
 *
 * 铁律: 前置条件不满足时拒绝执行，不绕过校验。
 */

import { getSql } from "../../connection.js";
import { governanceDecisionDao } from "../../dao/governanceDecision.js";
import { memoryItemDao } from "../../dao/memoryItem.js";
import { memoryCandidateDao } from "../../dao/memoryCandidate.js";
import type { GovernanceDecision, MemoryItem, MemoryStatus, ScopeDescriptor } from "../../types.js";
import { generateId } from "../platform/idGen.js";
import { NGramEmbeddingService, storeEmbedding } from "../platform/embeddingService.js";

export interface ExecutionResult {
  success: boolean;
  memoryId?: string;
  newVersion?: number;
  reason?: string;
}

export type PreconditionFailure =
  | "STALE_DECISION"
  | "REVISION_CHANGED"
  | "POLICY_CHANGED"
  | "SECURITY_RECHECK_REQUIRED"
  | "CONFIRMATION_REQUIRED"
  | "DECISION_EXPIRED"
  | "ALREADY_EXECUTED";

export class GovernanceExecutor {
  /**
   * 执行已批准的 GovernanceDecision。
   * 必须先通过前置条件校验，再在事务中完成写入 + Outbox。
   */
  async execute(decision: GovernanceDecision): Promise<ExecutionResult> {
    // 幂等检查
    const already = await governanceDecisionDao.isExecuted(decision.id);
    if (already) {
      const existing = await governanceDecisionDao.findById(decision.id);
      return { success: true, memoryId: existing?.resultingMemoryId, reason: "already_executed" };
    }

    // 只有 APPROVED 才执行
    if (decision.status !== "APPROVED") {
      return { success: false, reason: `Decision not approved (current: ${decision.status})` };
    }

    // 前置条件 1: 决策未过期
    if (decision.decidedAt) {
      const decidedTime = new Date(decision.decidedAt).getTime();
      const maxAge = 30 * 60 * 1000; // 30 minutes
      if (Date.now() - decidedTime > maxAge) {
        return { success: false, reason: "DECISION_EXPIRED" };
      }
    }

    // 前置条件 2: 目标版本校验（APPROVE_UPDATE/APPROVE_MERGE 时需要）
    if (decision.targetMemoryId && decision.expectedVersion !== undefined) {
      const existing = await memoryItemDao.findById(decision.targetMemoryId);
      if (!existing) return { success: false, reason: `Target memory ${decision.targetMemoryId} not found` };
      if (existing.version !== decision.expectedVersion) {
        return { success: false, reason: `REVISION_CHANGED: expected v${decision.expectedVersion}, actual v${existing.version}` };
      }
    }

    // 事务执行：tx 类型兼容性问题，用 any 桥接
    const sql = getSql() as any;
    try {
      return await sql.begin(async (tx: any) => {
        const result = await this.executeAction(decision);
        if (!result.success) throw new Error(result.reason);

        const memId = result.memoryId!;
        const seq = await this.nextSequence(tx, memId);
        await tx`
          INSERT INTO outbox_events (id, event_type, aggregate_type, aggregate_id, memory_id, memory_version, payload, sequence, transaction_id, status, created_at)
          VALUES (${generateId("outbox")}, 'MemoryCreated', 'memory', ${memId}, ${memId}, ${result.newVersion ?? 1}, '{}'::jsonb, ${seq}, ${generateId("tx")}, 'pending', now())
        `;
        await tx`
          UPDATE governance_decisions SET status = 'EXECUTED', resulting_memory_id = ${memId}, executed_at = now()
          WHERE id = ${decision.id}
        `;
        return result;
      });
    } catch (err: any) {
      return { success: false, reason: `Transaction failed: ${err?.message ?? String(err)}` };
    }
  }

  private async executeAction(decision: GovernanceDecision): Promise<ExecutionResult> {
    const candidate = await memoryCandidateDao.findById(decision.candidateId);
    if (!candidate) return { success: false, reason: "Candidate not found" };

    const now = new Date().toISOString();

    switch (decision.decision) {
      case "APPROVE_CREATE": {
        const memoryId = generateId("mem");
        const item = {
          id: memoryId, schemaVersion: 1,
          type: decision.adjustedType ?? candidate.proposedType,
          subjectKey: candidate.proposedSubjectKey ?? `${candidate.proposedType}:${memoryId}`,
          subjectKeyVersion: candidate.subjectKeyVersion,
          title: candidate.proposedTitle, summary: candidate.proposedSummary,
          status: (decision.resultingStatus as MemoryStatus) ?? "active",
          scope: (decision.adjustedScope as ScopeDescriptor) ?? (candidate.proposedScope as ScopeDescriptor),
          confidence: decision.adjustedConfidence ?? candidate.proposedConfidence,
          verificationStatus: "unverified" as const,
          payload: (decision.adjustedPayload as Record<string, unknown>) ?? candidate.proposedPayload,
          tags: [] as string[], relatedFiles: [] as string[], relatedSymbols: [] as string[], relatedTestRunIds: [] as string[],
          sensitivity: candidate.sensitivity as "public" | "internal" | "confidential" | "restricted",
          version: 1,
          createdBy: decision.decidedBy, updatedBy: decision.decidedBy,
          createdAt: now, updatedAt: now,
        } as unknown as MemoryItem;

        await memoryItemDao.create(item);
        await memoryCandidateDao.updateStatus(candidate.id, "promoted");

        // 异步生成 embedding
        try {
          const embedder = new NGramEmbeddingService();
          await storeEmbedding(memoryId, "1", await embedder.embed(`${item.title} ${item.summary}`));
        } catch { /* non-blocking */ }

        return { success: true, memoryId, newVersion: 1 };
      }

      case "APPROVE_UPDATE": {
        const targetId = decision.targetMemoryId;
        if (!targetId) return { success: false, reason: "Missing targetMemoryId" };

        const existing = await memoryItemDao.findById(targetId);
        if (!existing) return { success: false, reason: `Memory ${targetId} not found` };

        const patch: Parameters<typeof memoryItemDao.update>[2] = {};
        if (decision.adjustedPayload) patch.payload = decision.adjustedPayload as Record<string, unknown>;
        if (decision.adjustedConfidence !== undefined) patch.confidence = decision.adjustedConfidence;
        if (decision.resultingStatus) patch.status = decision.resultingStatus as MemoryStatus;
        if (decision.adjustedScope) patch.scope = decision.adjustedScope as ScopeDescriptor;

        const updated = await memoryItemDao.update(targetId, existing.version, patch);
        if (!updated) return { success: false, reason: "Update failed (version conflict)" };
        return { success: true, memoryId: targetId, newVersion: updated.version };
      }

      case "APPROVE_MERGE": {
        const targetId = decision.targetMemoryId;
        if (!targetId) return { success: false, reason: "Missing targetMemoryId" };

        const existing = await memoryItemDao.findById(targetId);
        if (!existing) return { success: false, reason: `Memory ${targetId} not found` };

        const newConfidence = (existing.confidence + (decision.adjustedConfidence ?? 0.5)) / 2;
        const updated = await memoryItemDao.update(targetId, existing.version, {
          confidence: newConfidence,
          verificationStatus: existing.verificationStatus === "verified" ? "verified" : "partially_verified",
        });
        if (!updated) return { success: false, reason: "Merge failed (version conflict)" };

        await memoryCandidateDao.updateStatus(candidate.id, "promoted");
        return { success: true, memoryId: targetId, newVersion: updated.version };
      }

      default:
        return { success: false, reason: `Unsupported action: ${decision.decision}` };
    }
  }

  private async nextSequence(sql: any, aggregateId: string): Promise<number> {
    const rows = await sql`SELECT COALESCE(MAX(sequence), 0) + 1 AS seq FROM outbox_events WHERE aggregate_id = ${aggregateId}`;
    return Number((rows[0] as { seq: number }).seq);
  }
}
