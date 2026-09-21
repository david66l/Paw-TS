/**
 * MemoryCandidate DAO
 */
import { getSql, parseJson } from "../connection.js";
import type { MemoryCandidateRow } from "../rows.js";
import type { CandidateStatus, MemoryCandidate, MemoryType } from "../types.js";

/**
 * 行 → 领域对象。标量列零断言（§M1，行类型见 `db/rows.ts`）。
 *
 * 两个**可空列**在这里把类型兑现：驱动对可空列返回 `null`，而
 * `MemoryCandidate` 声明的是 `| undefined`，所以显式转一次 ——
 * 原先的 `as string | undefined` 让 `null` 以 `string | undefined` 的身份漏了出去。
 */
function rowToCandidate(row: MemoryCandidateRow): MemoryCandidate {
  return {
    id: row.id,
    schemaVersion: row.schema_version,
    status: row.status as CandidateStatus,
    proposedType: row.proposed_type as MemoryType,
    proposedSubjectKey: row.proposed_subject_key ?? undefined,
    subjectKeyVersion: row.subject_key_version,
    proposedTitle: row.proposed_title,
    proposedSummary: row.proposed_summary,
    proposedPayload: parseJson(row.proposed_payload) as MemoryCandidate["proposedPayload"],
    proposedScope: parseJson(row.proposed_scope) as MemoryCandidate["proposedScope"],
    proposedConfidence: row.proposed_confidence,
    sourceTaskIds: row.source_task_ids,
    sourceRefs: parseJson(row.source_refs) as MemoryCandidate["sourceRefs"],
    evidenceRefs: parseJson(row.evidence_refs) as MemoryCandidate["evidenceRefs"],
    possibleDuplicateIds: row.possible_duplicate_ids,
    possibleConflictIds: row.possible_conflict_ids,
    riskLevel: row.risk_level as MemoryCandidate["riskLevel"],
    reviewRequired: row.review_required,
    generatedBy: parseJson(row.generated_by) as MemoryCandidate["generatedBy"],
    generationReason: row.generation_reason,
    sensitivity: row.sensitivity as MemoryCandidate["sensitivity"],
    // timestamptz 到手是 `Date`；`expires_at` 还可空，所以是 `?.`
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    expiresAt: row.expires_at?.toISOString(),
  };
}

export const memoryCandidateDao = {
  async create(c: MemoryCandidate): Promise<MemoryCandidate> {
    const sql = getSql();
    // 断言的唯一位置：驱动边界（§M1）
    const [row] = await sql<MemoryCandidateRow[]>`
      INSERT INTO memory_candidates (
        id, schema_version, status, proposed_type, proposed_subject_key, subject_key_version,
        proposed_title, proposed_summary, proposed_payload, proposed_scope,
        proposed_confidence, source_task_ids, source_refs, evidence_refs,
        possible_duplicate_ids, possible_conflict_ids, risk_level,
        review_required, generated_by, generation_reason, sensitivity,
        created_at, updated_at, expires_at
      ) VALUES (
        ${c.id}, ${c.schemaVersion}, ${c.status}, ${c.proposedType}, ${c.proposedSubjectKey ?? null},
        ${c.subjectKeyVersion}, ${c.proposedTitle}, ${c.proposedSummary},
        ${sql.json(c.proposedPayload as any)}, ${sql.json(c.proposedScope as any)},
        ${c.proposedConfidence}, ${sql.array(c.sourceTaskIds ?? [])},
        ${sql.json(c.sourceRefs as any)}, ${sql.json(c.evidenceRefs as any)},
        ${sql.array(c.possibleDuplicateIds ?? [])}, ${sql.array(c.possibleConflictIds ?? [])},
        ${c.riskLevel}, ${c.reviewRequired}, ${sql.json(c.generatedBy as any)},
        ${c.generationReason}, ${c.sensitivity}, ${c.createdAt}, ${c.updatedAt},
        ${c.expiresAt ?? null}
      )
      RETURNING *`;
    if (!row) {
      throw new Error("memory candidate insert returned no row");
    }
    return rowToCandidate(row);
  },

  async findById(id: string): Promise<MemoryCandidate | null> {
    const sql = getSql();
    const rows = await sql.unsafe<MemoryCandidateRow[]>(
      "SELECT * FROM memory_candidates WHERE id = $1",
      [id],
    );
    const row = rows[0];
    return row ? rowToCandidate(row) : null;
  },

  async updateStatus(
    id: string,
    status: CandidateStatus,
    opts?: { possibleDuplicateIds?: string[]; possibleConflictIds?: string[] },
  ): Promise<MemoryCandidate | null> {
    const sql = getSql();
    const rows = await sql.unsafe<MemoryCandidateRow[]>(
      `UPDATE memory_candidates SET
        status = $2,
        possible_duplicate_ids = COALESCE($3, possible_duplicate_ids),
        possible_conflict_ids = COALESCE($4, possible_conflict_ids),
        updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, status, opts?.possibleDuplicateIds ?? null, opts?.possibleConflictIds ?? null],
    );
    const row = rows[0];
    return row ? rowToCandidate(row) : null;
  },

  async listByStatus(status: CandidateStatus, limit = 50): Promise<MemoryCandidate[]> {
    const sql = getSql();
    const rows = await sql.unsafe<MemoryCandidateRow[]>(
      "SELECT * FROM memory_candidates WHERE status = $1 ORDER BY created_at DESC LIMIT $2",
      [status, limit],
    );
    return rows.map((r) => rowToCandidate(r));
  },

  async listBySourceTask(taskId: string): Promise<MemoryCandidate[]> {
    const sql = getSql();
    const rows = await sql.unsafe<MemoryCandidateRow[]>(
      "SELECT * FROM memory_candidates WHERE $1 = ANY(source_task_ids) ORDER BY created_at DESC",
      [taskId],
    );
    return rows.map((r) => rowToCandidate(r));
  },

  async findBySubjectKey(subjectKey: string): Promise<MemoryCandidate[]> {
    const sql = getSql();
    const rows = await sql.unsafe<MemoryCandidateRow[]>(
      "SELECT * FROM memory_candidates WHERE proposed_subject_key = $1 ORDER BY created_at DESC",
      [subjectKey],
    );
    return rows.map((r) => rowToCandidate(r));
  },
};
