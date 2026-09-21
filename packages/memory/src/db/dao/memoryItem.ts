/**
 * MemoryItem DAO
 */
import { getSql, parseJson, textArrayLiteral } from "../connection.js";
import type { MemoryItemRow } from "../rows.js";
import type { MemoryItem, MemoryStatus, MemoryType, ScopeDescriptor } from "../types.js";

/**
 * 行 → 领域对象。**标量列零断言** —— 它们直接来自 `MemoryItemRow`
 * （§M1：类型由 `db/rows.ts` 提供，不再是 22 个字段断言 + 一次双重断言）。
 *
 * 剩下的断言只有两类，且都是真实需要的：
 * - jsonb 列：`parseJson` 的返回类型是 `unknown`，必须在此收窄；
 * - 两个枚举列（`type` / `status`）：列里存的是 `text`，窄化到
 *   `MemoryType` / `MemoryStatus` 是**未经校验的**断言，与改动前一致 ——
 *   本次没有把"非法枚举值静默通过"改成抛错，那是另一个行为决定。
 */
function rowToItem(row: MemoryItemRow): MemoryItem {
  return {
    id: row.id,
    schemaVersion: row.schema_version,
    type: row.type as MemoryType,
    subjectKey: row.subject_key,
    subjectKeyVersion: row.subject_key_version,
    title: row.title,
    summary: row.summary,
    status: row.status as MemoryStatus,
    scope: parseJson(row.scope) as ScopeDescriptor,
    confidence: row.confidence,
    verificationStatus: row.verification_status as MemoryItem["verificationStatus"],
    payload: parseJson(row.payload) as MemoryItem["payload"],
    tags: row.tags,
    relatedFiles: row.related_files,
    relatedSymbols: row.related_symbols,
    relatedTestRunIds: row.related_test_run_ids,
    sensitivity: row.sensitivity as MemoryItem["sensitivity"],
    version: row.version,
    createdBy: parseJson(row.created_by) as MemoryItem["createdBy"],
    updatedBy: parseJson(row.updated_by) as MemoryItem["updatedBy"],
    // timestamptz 到手是 `Date`，而 `MemoryItem` 声明的是 `string` ——
    // 原先的 `as string` 让这个不一致一直藏着（§M1 的实证例子）。
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    // 唯一剩下的一处断言，且只针对**判别式联合**：`MemoryItem` 是按 `type`
    // 判别的联合，各成员的 `payload` 形状不同，而数据库行里 `type`（text）
    // 与 `payload`（jsonb）之间的对应关系无法被类型系统表达。
    //
    // 它**不再**承担列名校验 —— 那部分已经由 `MemoryItemRow` 在编译期完成：
    // 列改名、改类型、漏字段现在都是编译错误，而不是运行期 `undefined`。
    // 这正是 §M1 要的效果；把这一处也消掉需要按 `type` 分支构造联合成员，
    // 那是另一件事（并且要连带定义每种 payload 的校验）。
  } as MemoryItem;
}

const memoryItemColumns = [
  "id",
  "schema_version",
  "type",
  "subject_key",
  "subject_key_version",
  "title",
  "summary",
  "status",
  "scope",
  "confidence",
  "verification_status",
  "payload",
  "tags",
  "related_files",
  "related_symbols",
  "related_test_run_ids",
  "sensitivity",
  "version",
  "created_by",
  "updated_by",
  "created_at",
  "updated_at",
];

function snapshotFromRow(row: Record<string, unknown>): Record<string, unknown> {
  const snap: Record<string, unknown> = {};
  for (const col of memoryItemColumns) snap[col] = row[col];
  return snap;
}

async function insertVersion(
  sql: ReturnType<typeof getSql>,
  memoryId: string,
  version: number,
  snapshot: Record<string, unknown>,
  changeType: string,
  changeReason: string,
  governanceDecisionId?: string,
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
    // 断言的唯一位置：驱动边界。`RETURNING *` 的形状由 `MemoryItemRow` 声明，
    // 之后的映射不再需要逐字段断言（§M1）。
    const [row] = await sql<MemoryItemRow[]>`
      INSERT INTO memory_items (
        id, schema_version, type, subject_key, subject_key_version,
        title, summary, status, scope, confidence, verification_status,
        payload, tags, related_files, related_symbols, related_test_run_ids,
        sensitivity, version, created_by, updated_by, created_at, updated_at
      ) VALUES (
        ${item.id}, ${item.schemaVersion}, ${item.type}, ${item.subjectKey}, ${item.subjectKeyVersion},
        ${item.title}, ${item.summary}, ${item.status}, ${sql.json(item.scope as any)}, ${item.confidence},
        ${item.verificationStatus}, ${sql.json(item.payload as any)}, ${textArrayLiteral(item.tags ?? [])}::text[],
        ${textArrayLiteral(item.relatedFiles ?? [])}::text[], ${textArrayLiteral(item.relatedSymbols ?? [])}::text[], ${textArrayLiteral(item.relatedTestRunIds ?? [])}::text[],
        ${item.sensitivity}, ${item.version}, ${sql.json(item.createdBy as any)}, ${sql.json(item.updatedBy as any)},
        ${item.createdAt}, ${item.updatedAt}
      )
      RETURNING *`;
    // `RETURNING *` 必然带一行；原先的 `as Record<string, unknown>` 顺手把
    // 可能为 undefined 这件事也断言掉了（`row.id` 会抛 TypeError）。
    if (!row) {
      throw new Error("memory item insert returned no row");
    }
    const created = rowToItem(row);
    await insertVersion(sql, created.id, created.version, snapshotFromRow(row), "create", "");
    return created;
  },

  async findById(id: string): Promise<MemoryItem | null> {
    const sql = getSql();
    const rows = await sql.unsafe<MemoryItemRow[]>("SELECT * FROM memory_items WHERE id = $1", [
      id,
    ]);
    const row = rows[0];
    return row ? rowToItem(row) : null;
  },

  async findBySubjectKey(subjectKey: string, status?: MemoryStatus): Promise<MemoryItem[]> {
    const sql = getSql();
    const rows = status
      ? await sql.unsafe<MemoryItemRow[]>(
          "SELECT * FROM memory_items WHERE subject_key = $1 AND status = $2 ORDER BY updated_at DESC",
          [subjectKey, status],
        )
      : await sql.unsafe<MemoryItemRow[]>(
          "SELECT * FROM memory_items WHERE subject_key = $1 ORDER BY updated_at DESC",
          [subjectKey],
        );
    return rows.map((r) => rowToItem(r));
  },

  /**
   * Structured lookup by any combination of the declared filters.
   *
   * Every filter that is passed is applied. The previous version branched over a
   * few hand-picked combinations and silently ignored the rest: `tags` never
   * reached SQL at all, and `scopeUserId` was dropped unless a type *and* a
   * repository were also supplied. Callers therefore received a wider result set
   * than they asked for — across users that is a disclosure, not a nuisance.
   */
  async query(opts: {
    type?: MemoryType;
    /** Multi-type filter; takes precedence over `type` when provided. */
    types?: readonly MemoryType[];
    status?: MemoryStatus;
    scopeRepoId?: string;
    scopeUserId?: string;
    tags?: readonly string[];
    limit?: number;
    offset?: number;
  }): Promise<MemoryItem[]> {
    const sql = getSql();
    const limit = opts.limit ?? 20;
    const offset = opts.offset ?? 0;

    const values: (string | number | string[])[] = [];
    const bind = (value: string | number | string[]): string => {
      values.push(value);
      return `$${values.length}`;
    };

    const conditions = [`status = ${bind(opts.status ?? "active")}`];
    const types = [...(opts.types ?? (opts.type === undefined ? [] : [opts.type]))];
    if (types.length > 0) {
      // `ANY` keeps the single-type case on the same code path as the multi-type
      // one, and still uses the (type, status) and scope indexes.
      conditions.push(`type = ANY(${bind(types)})`);
    }
    if (opts.scopeRepoId !== undefined) {
      conditions.push(`scope->>'repositoryId' = ${bind(opts.scopeRepoId)}`);
    }
    if (opts.scopeUserId !== undefined) {
      conditions.push(`scope->>'userId' = ${bind(opts.scopeUserId)}`);
    }
    if (opts.tags !== undefined && opts.tags.length > 0) {
      // `tags` is text[] with a GIN index, so overlap (`&&`) is the indexed test.
      conditions.push(`tags && ${bind([...opts.tags])}`);
    }
    const limitParam = bind(limit);
    const offsetParam = bind(offset);

    const rows = await sql.unsafe<MemoryItemRow[]>(
      `SELECT * FROM memory_items
        WHERE ${conditions.join(" AND ")}
        ORDER BY updated_at DESC LIMIT ${limitParam} OFFSET ${offsetParam}`,
      values,
    );
    return rows.map((r) => rowToItem(r));
  },

  async update(
    id: string,
    expectedVersion: number,
    patch: {
      title?: string;
      summary?: string;
      status?: MemoryStatus;
      confidence?: number;
      verificationStatus?: string;
      payload?: Record<string, unknown>;
      tags?: string[];
      scope?: ScopeDescriptor;
    },
  ): Promise<MemoryItem | null> {
    const sql = getSql();

    if (Object.keys(patch).length === 0) return memoryItemDao.findById(id);

    // Build query with tagged template composition
    const [row] = await sql<MemoryItemRow[]>`
      UPDATE memory_items SET
        title = ${patch.title ?? sql`title`},
        summary = ${patch.summary ?? sql`summary`},
        status = ${patch.status ?? sql`status`},
        confidence = ${patch.confidence ?? sql`confidence`},
        verification_status = ${patch.verificationStatus ?? sql`verification_status`},
        payload = ${patch.payload !== undefined ? sql.json(patch.payload as any) : sql`payload`},
        tags = ${patch.tags !== undefined ? sql`${textArrayLiteral(patch.tags)}::text[]` : sql`tags`},
        scope = ${patch.scope !== undefined ? sql.json(patch.scope as any) : sql`scope`},
        updated_at = now(),
        version = version + 1
      WHERE id = ${id} AND version = ${expectedVersion}
      RETURNING *`;
    if (!row) return null;
    const updated = rowToItem(row);
    await insertVersion(sql, updated.id, updated.version, snapshotFromRow(row), "update", "");
    return updated;
  },

  /** 查询某个记忆的所有历史版本 */
  async listVersions(memoryId: string): Promise<
    {
      version: number;
      changeType: string;
      createdAt: string;
      snapshot: Record<string, unknown>;
    }[]
  > {
    const sql = getSql();
    const rows =
      await sql`SELECT version, change_type, created_at, snapshot FROM memory_versions WHERE memory_id = ${memoryId} ORDER BY version DESC`;
    return (
      rows as unknown as {
        version: number;
        change_type: string;
        created_at: string;
        snapshot: unknown;
      }[]
    ).map((r) => ({
      version: r.version,
      changeType: r.change_type,
      createdAt: r.created_at,
      snapshot: parseJson(r.snapshot) as Record<string, unknown>,
    }));
  },
};
