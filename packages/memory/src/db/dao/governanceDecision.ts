/**
 * GovernanceDecision DAO
 */
import { getSql, parseJson } from "../connection.js";
import type { GovernanceDecisionRow } from "../rows.js";
import type { GovernanceAction, GovernanceDecision, GovernanceDecisionStatus } from "../types.js";

/**
 * 行 → 领域对象。标量列零断言（§M1，行类型见 `db/rows.ts`）。
 *
 * **9 个可空列在这里把 `null` 兑现成 `undefined`**：INSERT 把省略的字段写成
 * `?? null`，而 `memoryStore.ts:153`、`:163` 与 `governanceExecutor.ts:184` 用
 * `!== undefined` 判断 `expectedVersion` / `adjustedConfidence` —— 漏出 `null`
 * 时那些判断会把"没值"当成"有值"。时间列同理：`timestamptz` 到手是 `Date`，
 * 而类型声明的是 `string`。
 */
function rowToDecision(row: GovernanceDecisionRow): GovernanceDecision {
  return {
    id: row.id,
    schemaVersion: row.schema_version,
    candidateId: row.candidate_id,
    decision: row.decision as GovernanceAction,
    reasons: parseJson(row.reasons) as GovernanceDecision["reasons"],
    resultingMemoryId: row.resulting_memory_id ?? undefined,
    resultingStatus: (row.resulting_status ?? undefined) as GovernanceDecision["resultingStatus"],
    adjustedType: (row.adjusted_type ?? undefined) as GovernanceDecision["adjustedType"],
    adjustedScope:
      (parseJson(row.adjusted_scope) as GovernanceDecision["adjustedScope"]) ?? undefined,
    adjustedConfidence: row.adjusted_confidence ?? undefined,
    adjustedPayload:
      (parseJson(row.adjusted_payload) as GovernanceDecision["adjustedPayload"]) ?? undefined,
    requiredActions: parseJson(row.required_actions) as GovernanceDecision["requiredActions"],
    policyVersion: row.policy_version,
    decidedBy: parseJson(row.decided_by) as GovernanceDecision["decidedBy"],
    status: row.status as GovernanceDecisionStatus,
    targetMemoryId: row.target_memory_id ?? undefined,
    expectedVersion: row.expected_version ?? undefined,
    executedAt: row.executed_at?.toISOString(),
    decidedAt: row.decided_at.toISOString(),
    createdAt: row.created_at.toISOString(),
  };
}

export const governanceDecisionDao = {
  async create(d: GovernanceDecision): Promise<GovernanceDecision> {
    const sql = getSql();
    // 断言的唯一位置：驱动边界（§M1）
    const [row] = await sql<GovernanceDecisionRow[]>`
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
    if (!row) {
      throw new Error("governance decision insert returned no row");
    }
    return rowToDecision(row);
  },

  async findById(id: string): Promise<GovernanceDecision | null> {
    const sql = getSql();
    const rows = await sql.unsafe<GovernanceDecisionRow[]>(
      "SELECT * FROM governance_decisions WHERE id = $1",
      [id],
    );
    const row = rows[0];
    return row ? rowToDecision(row) : null;
  },

  async findByCandidate(candidateId: string): Promise<GovernanceDecision[]> {
    const sql = getSql();
    const rows = await sql.unsafe<GovernanceDecisionRow[]>(
      "SELECT * FROM governance_decisions WHERE candidate_id = $1 ORDER BY created_at DESC",
      [candidateId],
    );
    return rows.map((r) => rowToDecision(r));
  },

  /** 执行决策（幂等）：只允许 APPROVED 且未执行过的 */
  async execute(
    id: string,
    resultingMemoryId: string,
    opts?: { resultingStatus?: string; executedAt?: string },
  ): Promise<GovernanceDecision | null> {
    const sql = getSql();
    const rows = await sql.unsafe<GovernanceDecisionRow[]>(
      `UPDATE governance_decisions SET
        status = 'EXECUTED',
        resulting_memory_id = $2,
        resulting_status = $3,
        executed_at = $4
       WHERE id = $1 AND status = 'APPROVED' AND resulting_memory_id IS NULL
       RETURNING *`,
      [
        id,
        resultingMemoryId,
        opts?.resultingStatus ?? null,
        opts?.executedAt ?? new Date().toISOString(),
      ],
    );
    const row = rows[0];
    return row ? rowToDecision(row) : null;
  },

  async isExecuted(id: string): Promise<boolean> {
    const sql = getSql();
    const rows = await sql.unsafe<GovernanceDecisionRow[]>(
      "SELECT 1 FROM governance_decisions WHERE id = $1 AND status = 'EXECUTED'",
      [id],
    );
    return rows.length > 0;
  },
};
