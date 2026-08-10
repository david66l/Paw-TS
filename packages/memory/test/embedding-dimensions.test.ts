/**
 * Embedding 维度回归测试（M2 修 M1 遗留 bug）
 *
 * 背景：治理写入路径（MemoryStore / GovernanceExecutor）曾用默认 256 维
 * NGramEmbeddingService 写 memory_embeddings.embedding（V008，vector(1536)），
 * 维度不匹配在 pgvector 层报错后被 try/catch 静默吞掉，embedding 从未真正写入。
 * 本测试锁定：治理写入后 memory_embeddings 中确实存在 1536 维向量。
 *
 * 需要 PostgreSQL 测试数据库，ping 失败时 skip 而非 fail：
 *   DATABASE_URL="postgresql://postgres@127.0.0.1:54329/paw_memory_test" bun test test/embedding-dimensions.test.ts
 */

import { describe, test, expect, afterAll } from "bun:test";
import { getSql, closeSql, ping } from "../src/db/connection.js";
import {
  NGramEmbeddingService,
  MEMORY_EMBEDDING_DIMENSIONS,
} from "../src/db/modules/platform/embeddingService.js";
import { memoryCandidateDao } from "../src/db/dao/memoryCandidate.js";
import { governanceDecisionDao } from "../src/db/dao/governanceDecision.js";
import { MemoryStore } from "../src/db/modules/write/memoryStore.js";
import type { GovernanceDecision, MemoryCandidate } from "../src/db/types.js";

process.env.DATABASE_URL ??= "postgresql://postgres@127.0.0.1:54329/paw_memory_test";

const dbOk = await ping();
const it = dbOk ? test : test.skip;

const RUN = Date.now().toString(36);
const CANDIDATE_ID = `cand_m2dim_${RUN}`;
const DECISION_ID = `gov_m2dim_${RUN}`;
let memoryId: string | undefined;

afterAll(async () => {
  if (dbOk) {
    const sql = getSql();
    if (memoryId) {
      await sql`DELETE FROM memory_embeddings WHERE memory_id = ${memoryId}`;
      await sql`DELETE FROM memory_versions WHERE memory_id = ${memoryId}`;
      await sql`DELETE FROM outbox_events WHERE aggregate_id = ${memoryId}`;
      await sql`DELETE FROM memory_items WHERE id = ${memoryId}`;
    }
    await sql`DELETE FROM governance_decisions WHERE id = ${DECISION_ID}`;
    await sql`DELETE FROM memory_candidates WHERE id = ${CANDIDATE_ID}`;
  }
  await closeSql();
});

describe("embedding 维度一致性", () => {
  test("统一维度常量对齐 V008 vector(1536)", () => {
    expect(MEMORY_EMBEDDING_DIMENSIONS).toBe(1536);
    expect(new NGramEmbeddingService(MEMORY_EMBEDDING_DIMENSIONS).dimensions).toBe(1536);
  });

  it("治理写入路径（MemoryStore）落库 1536 维 embedding", async () => {
    const now = new Date().toISOString();
    const actor = { actorType: "system" as const, actorId: "m2-dim-test" };

    const candidate: MemoryCandidate = {
      id: CANDIDATE_ID,
      schemaVersion: 1,
      status: "approved",
      proposedType: "project_knowledge",
      proposedSubjectKey: `m2dim:${RUN}`,
      subjectKeyVersion: 1,
      proposedTitle: "Embedding dimension regression probe",
      proposedSummary: "Governance write path must store a 1536-dim embedding",
      proposedPayload: { assertion: "probe" },
      proposedScope: { repositoryId: "m2-dim-test-repo" },
      proposedConfidence: 0.8,
      sourceTaskIds: [],
      sourceRefs: [],
      evidenceRefs: [],
      possibleDuplicateIds: [],
      possibleConflictIds: [],
      riskLevel: "low",
      reviewRequired: false,
      generatedBy: actor,
      generationReason: "m2 regression test",
      sensitivity: "internal",
      createdAt: now,
      updatedAt: now,
    };
    await memoryCandidateDao.create(candidate);

    const decision: GovernanceDecision = {
      id: DECISION_ID,
      schemaVersion: 1,
      candidateId: CANDIDATE_ID,
      decision: "APPROVE_CREATE",
      reasons: [],
      requiredActions: [],
      policyVersion: "m2-test",
      decidedBy: actor,
      status: "APPROVED",
      decidedAt: now,
      createdAt: now,
    };
    await governanceDecisionDao.create(decision);

    const stored = await governanceDecisionDao.findById(DECISION_ID);
    expect(stored).not.toBeNull();

    const result = await new MemoryStore().execute(stored!);
    expect(result.success).toBe(true);
    memoryId = result.memoryId;
    expect(memoryId).toBeDefined();

    // 回归断言：embedding 真实落库且维度为 1536
    const sql = getSql();
    const rows = await sql`
      SELECT vector_dims(embedding)::int AS dims
      FROM memory_embeddings WHERE memory_id = ${memoryId!}
    `;
    expect(rows.length).toBe(1);
    expect((rows[0] as { dims: number }).dims).toBe(1536);
  });
});
