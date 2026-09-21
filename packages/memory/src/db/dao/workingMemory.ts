/**
 * WorkingMemory DAO
 */
import { getSql, parseJson } from "../connection.js";
import type { WorkingMemory, WorkingMemorySnapshot } from "../types.js";

function rowToWm(row: Record<string, unknown>): WorkingMemory {
  const state = parseJson(row.state) as Record<string, unknown>;
  return {
    id: row.id as string,
    taskId: row.task_id as string,
    revision: row.revision as number,
    goal: (row.goal as string) ?? "",
    constraints: state.constraints as WorkingMemory["constraints"],
    plan: state.plan as WorkingMemory["plan"],
    todos: state.todos as WorkingMemory["todos"],
    completedSteps: state.completedSteps as WorkingMemory["completedSteps"],
    readFiles: state.readFiles as WorkingMemory["readFiles"],
    modifiedFiles: state.modifiedFiles as WorkingMemory["modifiedFiles"],
    executedTools: state.executedTools as WorkingMemory["executedTools"],
    diffSummary: state.diffSummary as WorkingMemory["diffSummary"],
    testRunIds: state.testRunIds as string[],
    currentTestSummary: state.currentTestSummary as WorkingMemory["currentTestSummary"],
    activeHypotheses: state.activeHypotheses as WorkingMemory["activeHypotheses"],
    rejectedHypotheses: state.rejectedHypotheses as WorkingMemory["rejectedHypotheses"],
    openQuestions: state.openQuestions as WorkingMemory["openQuestions"],
    nextAction: state.nextAction as WorkingMemory["nextAction"],
    contextPointers: state.contextPointers as WorkingMemory["contextPointers"],
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export const workingMemoryDao = {
  async create(wm: WorkingMemory): Promise<WorkingMemory> {
    const sql = getSql();
    // tagged template + sql.json：让驱动**只编码一次**。
    // 原先传 `JSON.stringify(wm)`（位置参数），postgres.js 认出目标是 jsonb 后又编码
    // 一次，落库成**双重编码的 jsonb 字符串**（实测 `jsonb_typeof(state)='string'`、
    // `state->>'goal'` 为 NULL）。读路径靠 `parseJson` 兼容两种形态所以一直没暴露。
    // `as any` 是既有约定：`sql.json` 收 `JSONValue`，而 `WorkingMemory` 是 interface，
    // 没有索引签名（同目录 `memoryItem.ts` 的 `sql.json(item.scope as any)` 同理）。
    const rows = await sql`
      INSERT INTO working_memories (id, task_id, revision, goal, state, created_at, updated_at)
      VALUES (${wm.id}, ${wm.taskId}, 1, ${wm.goal}, ${sql.json(wm as any)}, ${wm.createdAt}, ${wm.updatedAt})
      RETURNING *`;
    return rowToWm(rows[0] as Record<string, unknown>);
  },

  async findById(id: string): Promise<WorkingMemory | null> {
    const sql = getSql();
    const rows = await sql.unsafe("SELECT * FROM working_memories WHERE id = $1", [id]);
    return rows.length > 0 ? rowToWm(rows[0] as Record<string, unknown>) : null;
  },

  async findByTaskId(taskId: string): Promise<WorkingMemory | null> {
    const sql = getSql();
    const rows = await sql.unsafe("SELECT * FROM working_memories WHERE task_id = $1", [taskId]);
    return rows.length > 0 ? rowToWm(rows[0] as Record<string, unknown>) : null;
  },

  async update(
    id: string,
    expectedRevision: number,
    wm: WorkingMemory,
  ): Promise<WorkingMemory | null> {
    const sql = getSql();
    const rows = await sql`
      UPDATE working_memories SET goal = ${wm.goal}, state = ${sql.json(wm as any)},
        updated_at = now(), revision = revision + 1
       WHERE id = ${id} AND revision = ${expectedRevision} RETURNING *`;
    return rows.length > 0 ? rowToWm(rows[0] as Record<string, unknown>) : null;
  },

  // ── Snapshot ──

  async createSnapshot(snap: WorkingMemorySnapshot): Promise<WorkingMemorySnapshot> {
    const sql = getSql();
    const rows = await sql`
      INSERT INTO working_memory_snapshots
        (id, task_id, working_memory_id, working_memory_revision, reason, snapshot, created_by, created_at)
      VALUES (${snap.id}, ${snap.taskId}, ${snap.workingMemoryId}, ${snap.workingMemoryRevision},
        ${snap.reason}, ${sql.json(snap.snapshot as any)}, ${sql.json(snap.createdBy as any)},
        ${snap.createdAt})
      RETURNING *`;
    return rowToSnapshot(rows[0] as Record<string, unknown>);
  },

  async listSnapshots(taskId: string): Promise<WorkingMemorySnapshot[]> {
    const sql = getSql();
    const rows = await sql.unsafe(
      "SELECT * FROM working_memory_snapshots WHERE task_id = $1 ORDER BY created_at DESC",
      [taskId],
    );
    return rows.map((r) => rowToSnapshot(r as Record<string, unknown>));
  },
};

function rowToSnapshot(row: Record<string, unknown>): WorkingMemorySnapshot {
  return {
    id: row.id as string,
    taskId: row.task_id as string,
    workingMemoryId: row.working_memory_id as string,
    workingMemoryRevision: row.working_memory_revision as number,
    reason: row.reason as WorkingMemorySnapshot["reason"],
    snapshot: parseJson(row.snapshot) as WorkingMemory,
    createdBy: parseJson(row.created_by) as WorkingMemorySnapshot["createdBy"],
    createdAt: row.created_at as string,
  };
}
