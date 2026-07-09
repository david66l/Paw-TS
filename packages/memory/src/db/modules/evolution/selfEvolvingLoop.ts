/**
 * Self-Evolving Loop (8.12)
 *
 * 离线批处理：从长期使用数据中发现模式，生成 EvolutionCandidate。
 * 铁律：只生成候选，不直接修改 active memory。所有候选必须经过 MemoryGovernance。
 */

import { getSql } from "../../connection.js";
import { MemoryEvaluator } from "./memoryEvaluator.js";
import { MemoryGovernance } from "../write/memoryGovernance.js";
import { GovernanceExecutor } from "../write/governanceExecutor.js";
import { governanceDecisionDao } from "../../dao/governanceDecision.js";
import { generateId } from "../platform/idGen.js";
import type { ActorRef } from "../../types.js";

export type EvolutionType = "MERGE" | "ABSTRACT" | "MARK_STALE" | "DEPRECATE" | "CONFIDENCE_DECREASE";
export type EvolutionStatus = "generated" | "validating" | "pending_review" | "approved" | "rejected" | "applied" | "expired";

export interface EvolutionCandidate {
  id: string;
  batchId: string;
  evolutionType: EvolutionType;
  targetMemoryIds: string[];
  proposedTitle: string;
  proposedSummary: string;
  proposedPayload: Record<string, unknown>;
  proposedConfidence: number;
  riskLevel: string;
  evidence: Record<string, unknown>;
  status: EvolutionStatus;
  governanceDecisionId?: string;
  generatedBy: ActorRef;
  createdAt: string;
}

export interface EvolutionBatch {
  id: string;
  status: string;
  triggerReason: string;
  sampledMemoryCount: number;
  resultCandidateCount: number;
}

export interface EvolutionReport {
  batch: EvolutionBatch;
  candidates: EvolutionCandidate[];
  evaluations: { memoryId: string; suggestion: string; overall: number }[];
}

export class SelfEvolvingLoop {
  private evaluator = new MemoryEvaluator();
  private governance = new MemoryGovernance();
  private executor = new GovernanceExecutor();

  /**
   * 执行一轮演化。返回生成的候选数量。
   */
  async run(reason = "scheduled"): Promise<EvolutionReport> {
    const sql = getSql();
    const batchId = generateId("evb");
    const now = new Date().toISOString();

    // 创建批次
    await sql`
      INSERT INTO evolution_batches (id, status, trigger_reason, sampled_memory_count, started_at)
      VALUES (${batchId}, 'running', ${reason}, 0, ${now})
    `;

    const candidates: EvolutionCandidate[] = [];
    const evaluations: { memoryId: string; suggestion: string; overall: number }[] = [];

    try {
      // 1. 查找低质量记忆 → 生成 DEPRECATE / MARK_STALE 候选
      const lowQualityIds = await this.evaluator.findLowQualityMemories(0.4);
      for (const mid of lowQualityIds) {
        const score = await this.evaluator.evaluate(mid);
        evaluations.push({ memoryId: mid, suggestion: score.suggestion, overall: score.overall });
        if (score.suggestion === "deprecate") {
          candidates.push(await this.createCandidate(batchId, "DEPRECATE", [mid], score, {}, now));
        }
      }

      // 2. 查找重复记忆对 → 生成 MERGE 候选
      const dupes = await this.evaluator.findDuplicatePairs();
      for (const pair of dupes.slice(0, 10)) {
        candidates.push(await this.createCandidate(batchId, "MERGE", [pair.idA, pair.idB],
          { overall: pair.score, suggestion: "merge_candidate" },
          { duplicateScore: pair.score }, now));
      }

      // 3. 提交候选到治理
      let approvedCount = 0;
      for (const cand of candidates) {
        // 将 EvolutionCandidate 转换为 MemoryCandidate 格式提交治理
        const memCand = await this.submitToGovernance(cand);
        if (memCand) {
          const { decision } = await this.governance.evaluate({ candidateId: memCand.id });
          if (decision.status === "APPROVED") {
            await governanceDecisionDao.create(decision);
            const result = await this.executor.execute(decision);
            if (result.success) {
              approvedCount++;
              await sql`UPDATE evolution_candidates SET status = 'approved', governance_decision_id = ${decision.id} WHERE id = ${cand.id}`;
            }
          } else {
            await sql`UPDATE evolution_candidates SET status = ${decision.status === "PENDING_REVIEW" ? "pending_review" : "rejected"}`;
          }
        }
      }

      // 更新批次
      await sql`
        UPDATE evolution_batches SET status = 'completed', result_candidate_count = ${candidates.length}, completed_at = now()
        WHERE id = ${batchId}
      `;

      return {
        batch: { id: batchId, status: "completed", triggerReason: reason, sampledMemoryCount: lowQualityIds.length + dupes.length, resultCandidateCount: approvedCount },
        candidates,
        evaluations,
      };
    } catch (err) {
      await sql`UPDATE evolution_batches SET status = 'failed', completed_at = now() WHERE id = ${batchId}`;
      throw err;
    }
  }

  private async createCandidate(
    batchId: string, type: EvolutionType, targetIds: string[],
    score: { overall: number; suggestion: string },
    evidence: Record<string, unknown> = {},
    now: string,
  ): Promise<EvolutionCandidate> {
    const id = generateId("evc");
    const sql = getSql();
    await sql`
      INSERT INTO evolution_candidates (id, batch_id, evolution_type, target_memory_ids, proposed_title, proposed_summary, proposed_payload, proposed_confidence, risk_level, evidence, status, generated_by, created_at)
      VALUES (${id}, ${batchId}, ${type}, ${sql.array(targetIds)}, ${`Auto-${type}: ${targetIds.length} memories`}, ${`Generated by SelfEvolvingLoop. Score: ${score.overall.toFixed(2)}, suggestion: ${score.suggestion}`}, ${sql.json(evidence as any)}, ${score.overall}, ${type === "DEPRECATE" ? "medium" : "low"}, ${sql.json(evidence as any)}, 'generated', ${sql.json({ actorType: "system", actorId: "self-evolving-loop" } as any)}, ${now})
    `;
    return { id, batchId, evolutionType: type, targetMemoryIds: targetIds, proposedTitle: `Auto-${type}`, proposedSummary: `${type} suggestion`, proposedPayload: evidence, proposedConfidence: score.overall, riskLevel: "medium", evidence, status: "generated", generatedBy: { actorType: "system", actorId: "self-evolving-loop" }, createdAt: now };
  }

  /**
   * 将 EvolutionCandidate 提交为 MemoryCandidate 走标准治理流程。
   */
  private async submitToGovernance(cand: EvolutionCandidate): Promise<{ id: string } | null> {
    const sql = getSql();
    const id = generateId("cand");
    const now = new Date().toISOString();
    try {
      await sql`
        INSERT INTO memory_candidates (id, schema_version, status, proposed_type, proposed_subject_key, subject_key_version, proposed_title, proposed_summary, proposed_payload, proposed_scope, proposed_confidence, source_task_ids, source_refs, evidence_refs, possible_duplicate_ids, possible_conflict_ids, risk_level, review_required, generated_by, generation_reason, sensitivity, created_at, updated_at)
        VALUES (${id}, 1, 'draft', 'project_knowledge', ${`evolved:${cand.evolutionType}:${cand.batchId}`}, 1, ${cand.proposedTitle}, ${cand.proposedSummary}, ${sql.json(cand.proposedPayload as any)}, ${sql.json({ lifecycleScope: "persistent" } as any)}, ${cand.proposedConfidence}, ${sql.array([])}, ${sql.json([] as any)}, ${sql.json([] as any)}, ${sql.array(cand.targetMemoryIds)}, ${sql.array([])}, ${cand.riskLevel}, ${cand.riskLevel !== "low"}, ${sql.json(cand.generatedBy as any)}, ${`auto-${cand.evolutionType}`}, 'internal', ${now}, ${now})
        ON CONFLICT DO NOTHING
      `;
      return { id };
    } catch {
      return null;
    }
  }
}
