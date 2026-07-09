/**
 * TaskSession DAO
 */
import { getSql } from "../connection.js";
import type { TaskSession } from "../types.js";

function rowToTask(row: Record<string, unknown>): TaskSession {
  return {
    id: row.id as string,
    schemaVersion: row.schema_version as number,
    organizationId: row.organization_id as string | undefined,
    userId: row.user_id as string | undefined,
    workspaceId: row.workspace_id as string | undefined,
    repositoryId: row.repository_id as string | undefined,
    parentTaskId: row.parent_task_id as string | undefined,
    rootTaskId: (row.root_task_id as string) ?? (row.id as string),
    title: row.title as string | undefined,
    initialUserRequest: row.initial_user_request as string,
    status: row.status as TaskSession["status"],
    branch: row.branch as string | undefined,
    baseCommit: row.base_commit as string | undefined,
    headCommit: row.head_commit as string | undefined,
    currentWorkingMemoryId: row.current_working_memory_id as string | undefined,
    latestCheckpointId: row.latest_checkpoint_id as string | undefined,
    startedAt: row.started_at as string | undefined,
    completedAt: row.completed_at as string | undefined,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    revision: row.revision as number,
  };
}

export const taskSessionDao = {
  async create(task: TaskSession): Promise<TaskSession> {
    const sql = getSql();
    const rows = await sql.unsafe(
      `INSERT INTO task_sessions (
        id, schema_version, organization_id, user_id, workspace_id, repository_id,
        parent_task_id, root_task_id, title, initial_user_request, status,
        branch, base_commit, head_commit, current_working_memory_id, latest_checkpoint_id,
        started_at, completed_at, created_at, updated_at, revision
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
      RETURNING *`,
      [task.id, task.schemaVersion, task.organizationId ?? null, task.userId ?? null,
        task.workspaceId ?? null, task.repositoryId ?? null, task.parentTaskId ?? null,
        task.rootTaskId, task.title ?? null, task.initialUserRequest, task.status,
        task.branch ?? null, task.baseCommit ?? null, task.headCommit ?? null,
        task.currentWorkingMemoryId ?? null, task.latestCheckpointId ?? null,
        task.startedAt ?? null, task.completedAt ?? null, task.createdAt, task.updatedAt,
        task.revision],
    );
    return rowToTask(rows[0] as Record<string, unknown>);
  },

  async findById(id: string): Promise<TaskSession | null> {
    const sql = getSql();
    const rows = await sql.unsafe("SELECT * FROM task_sessions WHERE id = $1", [id]);
    return rows.length > 0 ? rowToTask(rows[0] as Record<string, unknown>) : null;
  },

  async updateStatus(
    id: string,
    expectedRevision: number,
    status: TaskSession["status"],
    opts?: { headCommit?: string; startedAt?: string; completedAt?: string; currentWorkingMemoryId?: string; latestCheckpointId?: string },
  ): Promise<TaskSession | null> {
    const sql = getSql();
    const rows = await sql.unsafe(
      `UPDATE task_sessions SET
        status = $2, current_working_memory_id = COALESCE($3, current_working_memory_id),
        latest_checkpoint_id = COALESCE($4, latest_checkpoint_id),
        head_commit = COALESCE($5, head_commit), started_at = COALESCE($6, started_at),
        completed_at = COALESCE($7, completed_at),
        updated_at = now(), revision = revision + 1
      WHERE id = $1 AND revision = $8 RETURNING *`,
      [id, status, opts?.currentWorkingMemoryId ?? null, opts?.latestCheckpointId ?? null,
        opts?.headCommit ?? null, opts?.startedAt ?? null, opts?.completedAt ?? null,
        expectedRevision],
    );
    return rows.length > 0 ? rowToTask(rows[0] as Record<string, unknown>) : null;
  },

  async listByStatus(status: TaskSession["status"], limit = 20): Promise<TaskSession[]> {
    const sql = getSql();
    const rows = await sql.unsafe(
      "SELECT * FROM task_sessions WHERE status = $1 ORDER BY created_at DESC LIMIT $2",
      [status, limit],
    );
    return rows.map((r) => rowToTask(r as Record<string, unknown>));
  },
};
