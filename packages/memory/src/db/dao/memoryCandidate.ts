/**
 * MemoryCandidate DAO
 */
import { getSql, parseJson } from "../connection.js";
import type { MemoryCandidate, CandidateStatus, MemoryType } from "../types.js";

function rowToCandidate(row: Record<string, unknown>): MemoryCandidate {
  return {
    id: row.id as string,
    schemaVersion: row.schema_version as number,
    status: row.status as CandidateStatus,
    proposedType: row.proposed_type as MemoryType,
    proposedSubjectKey: row.proposed_subject_key as string | undefined,
    subjectKeyVersion: row.subject_key_version as number,
    proposedTitle: row.proposed_title as string,
    proposedSummary: row.proposed_summary as string,
    proposedPayload: parseJson(row.proposed_payload) as Record<string, unknown>,
    proposedScope: parseJson(row.proposed_scope) as Record<string, unknown>,
    proposedConfidence: row.proposed_confidence as number,
    sourceTaskIds: row.source_task_ids as string[],
    sourceRefs: parseJson(row.source_refs) as MemoryCandidate["sourceRefs"],
    evidenceRefs: parseJson(row.evidence_refs) as MemoryCandidate["evidenceRefs"],
    possibleDuplicateIds: row.possible_duplicate_ids as string[],
    possibleConflictIds: row.possible_conflict_ids as string[],
    riskLevel: row.risk_level as MemoryCandidate["riskLevel"],
    reviewRequired: row.review_required as boolean,
    generatedBy: parseJson(row.generated_by) as MemoryCandidate["generatedBy"],
    generationReason: row.generation_reason as string,
    sensitivity: row.sensitivity as MemoryCandidate["sensitivity"],
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    expiresAt: row.expires_at as string | undefined,
  };
}

export const memoryCandidateDao = {
  async create(c: MemoryCandidate): Promise<MemoryCandidate> {
    const sql = getSql();
    const [row] = await sql`
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
    return rowToCandidate(row as Record<string, unknown>);
  },

  async findById(id: string): Promise<MemoryCandidate | null> {
    const sql = getSql();
    const rows = await sql.unsafe("SELECT * FROM memory_candidates WHERE id = $1", [id]);
    return rows.length > 0 ? rowToCandidate(rows[0] as Record<string, unknown>) : null;
  },

  async updateStatus(
    id: string, status: CandidateStatus,
    opts?: { possibleDuplicateIds?: string[]; possibleConflictIds?: string[] },
  ): Promise<MemoryCandidate | null> {
    const sql = getSql();
    const rows = await sql.unsafe(
      `UPDATE memory_candidates SET
        status = $2,
        possible_duplicate_ids = COALESCE($3, possible_duplicate_ids),
        possible_conflict_ids = COALESCE($4, possible_conflict_ids),
        updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, status, opts?.possibleDuplicateIds ?? null, opts?.possibleConflictIds ?? null],
    );
    return rows.length > 0 ? rowToCandidate(rows[0] as Record<string, unknown>) : null;
  },

  async listByStatus(status: CandidateStatus, limit = 50): Promise<MemoryCandidate[]> {
    const sql = getSql();
    const rows = await sql.unsafe(
      "SELECT * FROM memory_candidates WHERE status = $1 ORDER BY created_at DESC LIMIT $2",
      [status, limit],
    );
    return rows.map((r) => rowToCandidate(r as Record<string, unknown>));
  },

  async listBySourceTask(taskId: string): Promise<MemoryCandidate[]> {
    const sql = getSql();
    const rows = await sql.unsafe(
      "SELECT * FROM memory_candidates WHERE $1 = ANY(source_task_ids) ORDER BY created_at DESC",
      [taskId],
    );
    return rows.map((r) => rowToCandidate(r as Record<string, unknown>));
  },

  async findBySubjectKey(subjectKey: string): Promise<MemoryCandidate[]> {
    const sql = getSql();
    const rows = await sql.unsafe(
      "SELECT * FROM memory_candidates WHERE proposed_subject_key = $1 ORDER BY created_at DESC",
      [subjectKey],
    );
    return rows.map((r) => rowToCandidate(r as Record<string, unknown>));
  },
};
