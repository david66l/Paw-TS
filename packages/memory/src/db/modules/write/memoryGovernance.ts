/**
 * Memory Governance (8.11)
 *
 * 对 MemoryCandidate 进行质检、去重、冲突检测，生成 GovernanceDecision。
 * MVP: 规则引擎，不做模型调用。自动处理低风险，冲突/高风险 → REQUEST_REVIEW。
 *
 * 铁律: MemoryGovernance 只写 governance_decisions 表，不直接操作 memory_items。
 */

import { getSql } from "../../connection.js";
import { memoryCandidateDao } from "../../dao/memoryCandidate.js";
import { memoryItemDao } from "../../dao/memoryItem.js";
import type {
  GovernanceDecision, MemoryCandidate, GovernanceAction, ActorRef,
} from "../../types.js";
import { generateId } from "../platform/idGen.js";
import { PolicyEngine, type GovernancePolicy } from "../platform/policyEngine.js";
import { NGramEmbeddingService, cosineSimilarity } from "../platform/embeddingService.js";

export interface EvaluateInput {
  candidateId: string;
  policyVersion?: string;
  decidedBy?: ActorRef;
}

export interface EvaluateResult {
  decision: GovernanceDecision;
  duplicateOf?: string;
  conflictWith?: string;
}

export class MemoryGovernance {
  private policy: GovernancePolicy;

  constructor(policyEngine?: PolicyEngine) {
    this.policy = policyEngine?.getDefaults().governance ?? new PolicyEngine().getDefaults().governance;
  }

  /** 注入自定义策略（用于测试或动态更新） */
  setPolicy(policy: GovernancePolicy): void {
    this.policy = policy;
  }
  /**
   * 评估一个候选记忆。
   * 返回 GovernanceDecision（status = APPROVED / REJECTED / PENDING_REVIEW）。
   */
  async evaluate(input: EvaluateInput): Promise<EvaluateResult> {
    const candidate = await memoryCandidateDao.findById(input.candidateId);
    if (!candidate) throw new Error(`Candidate ${input.candidateId} not found`);

    const now = new Date().toISOString();
    const decidedBy = input.decidedBy ?? { actorType: "system", actorId: "governance" };

    // 1. 基础校验
    const schemaErrors = this.validateSchema(candidate);
    if (schemaErrors.length > 0) {
      return this.decide(candidate, "REJECT", schemaErrors, decidedBy, input.policyVersion, now);
    }

    // 2. 查重：同 subjectKey + scope 的已有 active 记忆
    if (candidate.proposedSubjectKey) {
      const existing = await memoryItemDao.findBySubjectKey(candidate.proposedSubjectKey, "active");
      if (existing.length > 0) {
        // 检查是否完全重复（同 subjectKey + 同 scope repo）
        const dup = existing.find((e) =>
          this.scopeOverlap(candidate.proposedScope, e.scope)
        );
        if (dup) {
          const merge = this.decide(candidate, "APPROVE_MERGE",
            [{ code: "DUPLICATE", description: `Duplicate of existing memory ${dup.id}` }],
            decidedBy, input.policyVersion, now);
          return {
            decision: { ...merge.decision, targetMemoryId: dup.id },
            duplicateOf: dup.id,
          };
        }

        // 同 subjectKey 但不同 scope → 允许创建，但标记关联
        await memoryCandidateDao.updateStatus(candidate.id, "evaluating", {
          possibleDuplicateIds: existing.map((e) => e.id),
        });
      }
    }

    // 2b. 语义去重：用 embedding 检测不同 subjectKey 但内容相似的记忆
    const embedder = new NGramEmbeddingService();
    const candidateText = `${candidate.proposedTitle} ${candidate.proposedSummary}`;
    const candidateVec = await embedder.embed(candidateText);

    const sql = getSql();
    const similarRows = await sql`
      SELECT m.id, m.title, m.type, me.embedding
      FROM memory_items m
      JOIN memory_embeddings me ON me.memory_id = m.id
      WHERE m.status = 'active' AND m.id != COALESCE(${candidate.proposedSubjectKey ?? ""}, '')
      ORDER BY me.embedding <-> ${`[${candidateVec.join(",")}]`}::vector
      LIMIT 5
    `;
    for (const row of similarRows as unknown as { id: string; title: string; type: string; embedding: unknown }[]) {
      const storedVec = parseEmbedding(row.embedding);
      const sim = cosineSimilarity(candidateVec, storedVec);
      if (sim >= this.policy.duplicateThreshold) {
        const merge = this.decide(candidate, "APPROVE_MERGE",
          [{ code: "SEMANTIC_DUPLICATE", description: `Semantically similar (${sim.toFixed(2)}) to ${row.id}: ${row.title}` }],
          decidedBy, input.policyVersion, now);
        return {
          decision: { ...merge.decision, targetMemoryId: row.id },
          duplicateOf: row.id,
        };
      }
    }

    // 3. 冲突检测：同 subjectKey 但内容差异大 → 标记
    if (candidate.proposedSubjectKey) {
      const allSameSubject = await memoryItemDao.findBySubjectKey(candidate.proposedSubjectKey);
      const conflicts = allSameSubject.filter((m) => m.status === "active" && !this.isSimilar(candidate, m));
      if (conflicts.length > 0) {
        await memoryCandidateDao.updateStatus(candidate.id, "evaluating", {
          possibleConflictIds: conflicts.map((c) => c.id),
        });
        // 冲突且无法自动解决 → 人工 review
        if (candidate.riskLevel === "high" || candidate.riskLevel === "critical") {
          return {
            ...this.decide(candidate, "REQUEST_REVIEW",
              [{ code: "CONFLICT", description: `Conflicts with existing memories: ${conflicts.map((c) => c.id).join(", ")}` }],
              decidedBy, input.policyVersion, now),
            conflictWith: conflicts[0]?.id,
          };
        }
        // 低风险冲突 → 拒绝新候选，保留已有
        return {
          ...this.decide(candidate, "REJECT",
            [{ code: "CONFLICT", description: `Conflicts with existing active memory` }],
            decidedBy, input.policyVersion, now),
          conflictWith: conflicts[0]?.id,
        };
      }
    }

    // 4. 风险分级决策（阈值来自 PolicyEngine）
    const lowThreshold = this.policy.autoApproveLowRiskThreshold;
    const medThreshold = this.policy.autoApproveMediumRiskThreshold;

    if (candidate.riskLevel === "low" && !candidate.reviewRequired && candidate.proposedConfidence >= lowThreshold) {
      return this.decide(candidate, "APPROVE_CREATE",
        [{ code: "LOW_RISK", description: `Low risk, confidence ${candidate.proposedConfidence} >= ${lowThreshold}` }],
        decidedBy, input.policyVersion, now);
    }

    if (candidate.riskLevel === "medium" && candidate.proposedConfidence >= medThreshold) {
      return this.decide(candidate, "APPROVE_CREATE",
        [{ code: "MEDIUM_RISK_APPROVED", description: `Medium risk, confidence ${candidate.proposedConfidence} >= ${medThreshold}` }],
        decidedBy, input.policyVersion, now);
    }

    // 高风险 / 低置信度 → 人工 review
    return this.decide(candidate, "REQUEST_REVIEW",
      [{ code: "REVIEW_REQUIRED", description: `Risk: ${candidate.riskLevel}, confidence: ${candidate.proposedConfidence}` }],
      decidedBy, input.policyVersion, now);
  }

  // ── Private helpers ──

  private decide(
    candidate: MemoryCandidate,
    action: GovernanceAction,
    reasons: { code: string; description: string }[],
    decidedBy: ActorRef,
    policyVersion = "1.0",
    now: string,
  ): EvaluateResult {
    const decision: GovernanceDecision = {
      id: generateId("gov"),
      schemaVersion: 1,
      candidateId: candidate.id,
      decision: action,
      reasons,
      resultingMemoryId: undefined,
      resultingStatus: action.startsWith("APPROVE") ? "active" : undefined,
      adjustedType: candidate.proposedType,
      adjustedScope: candidate.proposedScope as GovernanceDecision["adjustedScope"],
      adjustedConfidence: candidate.proposedConfidence,
      adjustedPayload: candidate.proposedPayload,
      requiredActions: [],
      policyVersion,
      decidedBy,
      status: action === "REQUEST_REVIEW" ? "PENDING_REVIEW"
        : action.startsWith("APPROVE") ? "APPROVED"
        : "REJECTED",
      decidedAt: now,
      createdAt: now,
    };

    return { decision };
  }

  private validateSchema(candidate: MemoryCandidate): { code: string; description: string }[] {
    const errors: { code: string; description: string }[] = [];
    if (!candidate.proposedTitle) errors.push({ code: "MISSING_TITLE", description: "Title is required" });
    if (!candidate.proposedType) errors.push({ code: "MISSING_TYPE", description: "Type is required" });
    if (candidate.proposedConfidence < 0) errors.push({ code: "INVALID_CONFIDENCE", description: "Confidence must be >= 0" });
    return errors;
  }

  /** 简单 scope 重叠判断：同 repositoryId 即重叠 */
  private scopeOverlap(a: unknown, b: unknown): boolean {
    const aRepo = (a as any)?.repositoryId as string | undefined;
    const bRepo = (b as any)?.repositoryId as string | undefined;
    return aRepo !== undefined && aRepo === bRepo;
  }

  /** 简单相似度判断：title 前 100 字符相同视为相似 */
  private isSimilar(candidate: MemoryCandidate, existing: { title: string }): boolean {
    const ct = candidate.proposedTitle.slice(0, 100).toLowerCase();
    const et = existing.title.slice(0, 100).toLowerCase();
    return ct === et;
  }
}

/** 解析 pgvector 返回的向量字符串 "[0.1,0.2,...]" → number[] */
function parseEmbedding(raw: unknown): number[] {
  if (Array.isArray(raw)) return raw as number[];
  if (typeof raw === "string") {
    try { return JSON.parse(raw) as number[]; } catch { return []; }
  }
  return [];
}
