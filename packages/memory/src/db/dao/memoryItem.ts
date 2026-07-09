/**
 * MemoryItem DAO
 */
import { getSql, parseJson } from "../connection.js";
import type { MemoryItem, MemoryType, MemoryStatus, ScopeDescriptor } from "../types.js";

function rowToItem(row: Record<string, unknown>): MemoryItem {
  return {
    id: row.id as string,
    schemaVersion: row.schema_version as number,
    type: row.type as MemoryType,
    subjectKey: row.subject_key as string,
    subjectKeyVersion: row.subject_key_version as number,
    title: row.title as string,
    summary: row.summary as string,
    status: row.status as MemoryStatus,
    scope: parseJson(row.scope) as ScopeDescriptor,
    confidence: row.confidence as number,
    verificationStatus: (row.verification_status as string) as MemoryItem["verificationStatus"],
    payload: parseJson(row.payload) as Record<string, unknown>,
    tags: row.tags as string[],
    relatedFiles: row.related_files as string[],
    relatedSymbols: row.related_symbols as string[],
    relatedTestRunIds: row.related_test_run_ids as string[],
    sensitivity: row.sensitivity as MemoryItem["sensitivity"],
    version: row.version as number,
    createdBy: parseJson(row.created_by) as MemoryItem["createdBy"],
    updatedBy: parseJson(row.updated_by) as MemoryItem["updatedBy"],
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  } as unknown as MemoryItem;
}

const memoryItemColumns = [
  "id","schema_version","type","subject_key","subject_key_version",
  "title","summary","status","scope","confidence","verification_status",
  "payload","tags","related_files","related_symbols","related_test_run_ids",
  "sensitivity","version","created_by","updated_by","created_at","updated_at",
];

function snapshotFromRow(row: Record<string, unknown>): Record<string, unknown> {
  const snap: Record<string, unknown> = {};
  for (const col of memoryItemColumns) snap[col] = row[col];
  return snap;
}

async function insertVersion(
  sql: ReturnType<typeof getSql>,
  memoryId: string, version: number, snapshot: Record<string, unknown>,
  changeType: string, changeReason: string, governanceDecisionId?: string,
): Promise<void> {
  const id = `memv_${memoryId}_${version}`;
  await sql`
    INSERT INTO memory_versions (id, memory_id, version, snapshot, change_type, change_reason, governance_decision_id, created_by, created_at)
    VALUES (${id}, ${memoryId}, ${version}, ${sql.json(snapshot as any)}, ${changeType}, ${changeReason}, ${governanceDecisionId ?? null}, '{}'::jsonb, now())
  `;
}

export const memoryItemDao = {
  async create(item: MemoryItem): Promise<MemoryItem> {
    const sql = getSql();
    const [row] = await sql`
      INSERT INTO memory_items (
        id, schema_version, type, subject_key, subject_key_version,
        title, summary, status, scope, confidence, verification_status,
        payload, tags, related_files, related_symbols, related_test_run_ids,
        sensitivity, version, created_by, updated_by, created_at, updated_at
      ) VALUES (
        ${item.id}, ${item.schemaVersion}, ${item.type}, ${item.subjectKey}, ${item.subjectKeyVersion},
        ${item.title}, ${item.summary}, ${item.status}, ${sql.json(item.scope as any)}, ${item.confidence},
        ${item.verificationStatus}, ${sql.json(item.payload as any)}, ${sql.array(item.tags ?? [])},
        ${sql.array(item.relatedFiles ?? [])}, ${sql.array(item.relatedSymbols ?? [])}, ${sql.array(item.relatedTestRunIds ?? [])},
        ${item.sensitivity}, ${item.version}, ${sql.json(item.createdBy as any)}, ${sql.json(item.updatedBy as any)},
        ${item.createdAt}, ${item.updatedAt}
      )
      RETURNING *`;
    const created = rowToItem(row as Record<string, unknown>);
    await insertVersion(sql, created.id, created.version, snapshotFromRow(row as Record<string, unknown>), "create", "");
    return created;
  },

  async findById(id: string): Promise<MemoryItem | null> {
    const sql = getSql();
    const rows = await sql.unsafe("SELECT * FROM memory_items WHERE id = $1", [id]);
    return rows.length > 0 ? rowToItem(rows[0] as Record<string, unknown>) : null;
  },

  async findBySubjectKey(subjectKey: string, status?: MemoryStatus): Promise<MemoryItem[]> {
    const sql = getSql();
    const rows = status
      ? await sql.unsafe("SELECT * FROM memory_items WHERE subject_key = $1 AND status = $2 ORDER BY updated_at DESC", [subjectKey, status])
      : await sql.unsafe("SELECT * FROM memory_items WHERE subject_key = $1 ORDER BY updated_at DESC", [subjectKey]);
    return rows.map((r) => rowToItem(r as Record<string, unknown>));
  },

  async query(opts: {
    type?: MemoryType;
    status?: MemoryStatus;
    scopeRepoId?: string;
    scopeUserId?: string;
    tags?: string[];
    limit?: number;
    offset?: number;
  }): Promise<MemoryItem[]> {
    const sql = getSql();
    const limit = opts.limit ?? 20;
    const offset = opts.offset ?? 0;

    // Build query using tagged template for proper JSONB support
    if (opts.scopeRepoId && opts.scopeUserId && opts.type) {
      const rows = await sql`
        SELECT * FROM memory_items
        WHERE type = ${opts.type} AND status = ${opts.status ?? "active"}
          AND scope->>'repositoryId' = ${opts.scopeRepoId}
          AND scope->>'userId' = ${opts.scopeUserId}
        ORDER BY updated_at DESC LIMIT ${limit} OFFSET ${offset}`;
      return rows.map((r) => rowToItem(r as Record<string, unknown>));
    }
    if (opts.scopeRepoId && opts.type) {
      const rows = await sql`
        SELECT * FROM memory_items
        WHERE type = ${opts.type} AND status = ${opts.status ?? "active"}
          AND scope->>'repositoryId' = ${opts.scopeRepoId}
        ORDER BY updated_at DESC LIMIT ${limit} OFFSET ${offset}`;
      return rows.map((r) => rowToItem(r as Record<string, unknown>));
    }
    if (opts.type) {
      const rows = await sql`
        SELECT * FROM memory_items
        WHERE type = ${opts.type} AND status = ${opts.status ?? "active"}
        ORDER BY updated_at DESC LIMIT ${limit} OFFSET ${offset}`;
      return rows.map((r) => rowToItem(r as Record<string, unknown>));
    }
    if (opts.scopeRepoId) {
      const rows = await sql`
        SELECT * FROM memory_items
        WHERE status = ${opts.status ?? "active"}
          AND scope->>'repositoryId' = ${opts.scopeRepoId}
        ORDER BY updated_at DESC LIMIT ${limit} OFFSET ${offset}`;
      return rows.map((r) => rowToItem(r as Record<string, unknown>));
    }
    const rows = await sql`
      SELECT * FROM memory_items
      WHERE status = ${opts.status ?? "active"}
      ORDER BY updated_at DESC LIMIT ${limit} OFFSET ${offset}`;
    return rows.map((r) => rowToItem(r as Record<string, unknown>));
  },

  async update(id: string, expectedVersion: number, patch: {
    title?: string; summary?: string; status?: MemoryStatus;
    confidence?: number; verificationStatus?: string;
    payload?: Record<string, unknown>; tags?: string[]; scope?: ScopeDescriptor;
  }): Promise<MemoryItem | null> {
    const sql = getSql();

    if (Object.keys(patch).length === 0) return memoryItemDao.findById(id);

    // Build query with tagged template composition
    const [row] = await sql`
      UPDATE memory_items SET
        title = ${patch.title ?? sql`title`},
        summary = ${patch.summary ?? sql`summary`},
        status = ${patch.status ?? sql`status`},
        confidence = ${patch.confidence ?? sql`confidence`},
        verification_status = ${patch.verificationStatus ?? sql`verification_status`},
        payload = ${patch.payload !== undefined ? sql.json(patch.payload as any) : sql`payload`},
        tags = ${patch.tags !== undefined ? sql.array(patch.tags) : sql`tags`},
        scope = ${patch.scope !== undefined ? sql.json(patch.scope as any) : sql`scope`},
        updated_at = now(),
        version = version + 1
      WHERE id = ${id} AND version = ${expectedVersion}
      RETURNING *`;
    if (!row) return null;
    const updated = rowToItem(row as Record<string, unknown>);
    await insertVersion(sql, updated.id, updated.version, snapshotFromRow(row as Record<string, unknown>), "update", "");
    return updated;
  },

  /** 查询某个记忆的所有历史版本 */
  async listVersions(memoryId: string): Promise<{ version: number; changeType: string; createdAt: string; snapshot: Record<string, unknown> }[]> {
    const sql = getSql();
    const rows = await sql`SELECT version, change_type, created_at, snapshot FROM memory_versions WHERE memory_id = ${memoryId} ORDER BY version DESC`;
    return (rows as unknown as { version: number; change_type: string; created_at: string; snapshot: unknown }[]).map((r) => ({
      version: r.version,
      changeType: r.change_type,
      createdAt: r.created_at,
      snapshot: parseJson(r.snapshot) as Record<string, unknown>,
    }));
  },
};
