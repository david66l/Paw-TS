/**
 * GovernanceDecision DAO
 */
import { getSql, parseJson } from "../connection.js";
import type { GovernanceDecision, GovernanceDecisionStatus, GovernanceAction } from "../types.js";

function rowToDecision(row: Record<string, unknown>): GovernanceDecision {
  return {
    id: row.id as string,
    schemaVersion: row.schema_version as number,
    candidateId: row.candidate_id as string,
    decision: row.decision as GovernanceAction,
    reasons: parseJson(row.reasons) as GovernanceDecision["reasons"],
    resultingMemoryId: row.resulting_memory_id as string | undefined,
    resultingStatus: row.resulting_status as GovernanceDecision["resultingStatus"],
    adjustedType: row.adjusted_type as GovernanceDecision["adjustedType"],
    adjustedScope: parseJson(row.adjusted_scope) as GovernanceDecision["adjustedScope"] ?? undefined,
    adjustedConfidence: row.adjusted_confidence as number | undefined,
    adjustedPayload: parseJson(row.adjusted_payload) as Record<string, unknown> ?? undefined,
    requiredActions: parseJson(row.required_actions) as GovernanceDecision["requiredActions"],
    policyVersion: row.policy_version as string,
    decidedBy: parseJson(row.decided_by) as GovernanceDecision["decidedBy"],
    status: row.status as GovernanceDecisionStatus,
    targetMemoryId: row.target_memory_id as string | undefined,
    expectedVersion: row.expected_version as number | undefined,
    executedAt: row.executed_at as string | undefined,
    decidedAt: row.decided_at as string,
    createdAt: row.created_at as string,
  };
}

export const governanceDecisionDao = {
  async create(d: GovernanceDecision): Promise<GovernanceDecision> {
    const sql = getSql();
    const [row] = await sql`
      INSERT INTO governance_decisions (
        id, schema_version, candidate_id, decision, reasons,
        resulting_memory_id, resulting_status, adjusted_type, adjusted_scope,
        adjusted_confidence, adjusted_payload, required_actions, policy_version,
        decided_by, status, target_memory_id, expected_version,
        executed_at, decided_at, created_at
      ) VALUES (
        ${d.id}, ${d.schemaVersion}, ${d.candidateId}, ${d.decision},
        ${sql.json(d.reasons as any)},
        ${d.resultingMemoryId ?? null}, ${d.resultingStatus ?? null},
        ${d.adjustedType ?? null}, ${d.adjustedScope ? sql.json(d.adjustedScope as any) : null},
        ${d.adjustedConfidence ?? null}, ${d.adjustedPayload ? sql.json(d.adjustedPayload as any) : null},
        ${sql.json(d.requiredActions as any)}, ${d.policyVersion},
        ${sql.json(d.decidedBy as any)},
        ${d.status}, ${d.targetMemoryId ?? null}, ${d.expectedVersion ?? null},
        ${d.executedAt ?? null}, ${d.decidedAt}, ${d.createdAt}
      )
      RETURNING *`;
    return rowToDecision(row as Record<string, unknown>);
  },

  async findById(id: string): Promise<GovernanceDecision | null> {
    const sql = getSql();
    const rows = await sql.unsafe("SELECT * FROM governance_decisions WHERE id = $1", [id]);
    return rows.length > 0 ? rowToDecision(rows[0] as Record<string, unknown>) : null;
  },

  async findByCandidate(candidateId: string): Promise<GovernanceDecision[]> {
    const sql = getSql();
    const rows = await sql.unsafe(
      "SELECT * FROM governance_decisions WHERE candidate_id = $1 ORDER BY created_at DESC",
      [candidateId],
    );
    return rows.map((r) => rowToDecision(r as Record<string, unknown>));
  },

  /** 执行决策（幂等）：只允许 APPROVED 且未执行过的 */
  async execute(id: string, resultingMemoryId: string, opts?: { resultingStatus?: string; executedAt?: string }): Promise<GovernanceDecision | null> {
    const sql = getSql();
    const rows = await sql.unsafe(
      `UPDATE governance_decisions SET
        status = 'EXECUTED',
        resulting_memory_id = $2,
        resulting_status = $3,
        executed_at = $4
       WHERE id = $1 AND status = 'APPROVED' AND resulting_memory_id IS NULL
       RETURNING *`,
      [id, resultingMemoryId, opts?.resultingStatus ?? null, opts?.executedAt ?? new Date().toISOString()],
    );
    return rows.length > 0 ? rowToDecision(rows[0] as Record<string, unknown>) : null;
  },

  async isExecuted(id: string): Promise<boolean> {
    const sql = getSql();
    const rows = await sql.unsafe(
      "SELECT 1 FROM governance_decisions WHERE id = $1 AND status = 'EXECUTED'", [id],
    );
    return rows.length > 0;
  },
};
