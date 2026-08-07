/**
 * Postgres 存储引擎（spec v2 §9.1 MemoryStoreEngine 的 db 后端实现）
 *
 * 对现有 db 链路的接口化包装，不重写存储层：
 * - 条目落 memory_items 表：kind → type 列；完整条目 JSON → payload；
 *   可检索文本镜像到 title/summary/tags/when_to_use（复用 V013 tsvector 触发器）
 * - 双时戳/效用账本/版本链直映射 V026 新增列
 * - searchText 复用 V013 tsvector/GIN；searchVector 复用 V008 pgvector
 *   + 现有 NGramEmbeddingService（维度 1536 对齐 embedding 列）
 */

import { getSql, parseJson, textArrayLiteral } from "../../db/connection.js";
import {
  NGramEmbeddingService,
  storeEmbedding,
  cosineSimilarity,
  MEMORY_EMBEDDING_DIMENSIONS,
} from "../../db/modules/platform/embeddingService.js";
import { deriveEntryId } from "./id.js";
import type {
  LedgerEntry,
  MemoryEntry,
  MemoryFilter,
  MemoryStoreEngine,
  ReindexReport,
  ScoredId,
} from "./engine.js";

/** memory_embeddings.embedding 列为 vector(1536)（V008），embedding 服务统一使用该维度 */
const EMBEDDING_DIMENSIONS = MEMORY_EMBEDDING_DIMENSIONS;

type Row = Record<string, unknown>;

function toIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

function toIsoOrNull(v: unknown): string | null {
  return v == null ? null : toIso(v);
}

/** 各 kind 的可检索文本镜像（喂给 V013 tsvector 触发器与 embedding） */
function renderSearchText(entry: MemoryEntry): { title: string; summary: string; tags: string[] } {
  switch (entry.kind) {
    case "semantic":
      return { title: entry.fact, summary: entry.fact, tags: entry.keywords };
    case "episodic":
      return {
        title: entry.perspective,
        summary: [
          entry.whenToUse,
          ...entry.modification,
          entry.failureFixPair?.feedback ?? "",
        ].filter(Boolean).join("\n"),
        tags: [entry.issueType, ...(entry.branch ? [entry.branch] : [])],
      };
    case "profile":
      return { title: entry.insight, summary: entry.insight, tags: [] };
    case "vault_ref":
      return { title: entry.refDescription, summary: entry.refDescription, tags: [] };
  }
}

/** 各 kind 参与向量化的文本（spec §4.3：semantic 用 embeddingKey，episodic 用 whenToUse） */
function embeddingInput(entry: MemoryEntry): string {
  switch (entry.kind) {
    case "semantic":
      return entry.embeddingKey || `${entry.fact} ${entry.keywords.join(" ")}`;
    case "episodic":
      return entry.whenToUse;
    case "profile":
      return entry.insight;
    case "vault_ref":
      return entry.refDescription;
  }
}

function rowToEntry(row: Row): MemoryEntry {
  const stored = (parseJson(row.payload) ?? {}) as Record<string, unknown>;
  const scope = (parseJson(row.scope) ?? {}) as { repositoryId?: string };
  const history = parseJson(row.history) as unknown;
  return {
    ...stored,
    id: row.id as string,
    kind: row.type as MemoryEntry["kind"],
    repo: scope.repositoryId ?? (stored.repo as string) ?? "",
    created: toIso(row.created_at),
    tValid: toIso(row.t_valid ?? row.created_at),
    tInvalid: toIsoOrNull(row.t_invalid),
    confidence: row.confidence as number,
    freq: (row.freq as number) ?? 0,
    utility: (row.utility as number) ?? 0,
    ...(Array.isArray(history) && history.length > 0 ? { history } : {}),
  } as unknown as MemoryEntry;
}

function parseVector(raw: unknown): number[] {
  if (Array.isArray(raw)) return raw as number[];
  if (typeof raw === "string") {
    try { return JSON.parse(raw) as number[]; } catch { return []; }
  }
  return [];
}

export class PostgresMemoryStoreEngine implements MemoryStoreEngine {
  private readonly embedder = new NGramEmbeddingService(EMBEDDING_DIMENSIONS);

  async put(entry: MemoryEntry): Promise<void> {
    const sql = getSql();
    const id = entry.id || deriveEntryId(entry);
    const now = new Date().toISOString();
    const created = entry.created || now;
    const tValid = entry.tValid || created;
    const { title, summary, tags } = renderSearchText(entry);
    const whenToUse = entry.kind === "episodic" ? entry.whenToUse : null;
    const whenToUseCol = whenToUse ?? null;
    const history = entry.kind === "semantic" ? (entry.history ?? []) : [];
    // payload 存完整条目（kind 特有字段 + source/evidence 等），基础列字段在读出时以列为准
    const payload = { ...entry, id };
    // verification_status 按条目推导（修复批次 A #2）：固化通道（可信 source）→ verified；
    // 降级条目（payload.degraded）与纯推断（agent_inferred）→ unverified
    const degraded = (entry as { degraded?: boolean }).degraded === true;
    const verificationStatus = degraded
      ? "unverified"
      : ["agent_verified", "user_statement", "repo_docs", "trial_graduated"].includes(entry.source)
        ? "verified"
        : "unverified";

    await sql`
      INSERT INTO memory_items (
        id, schema_version, type, subject_key, subject_key_version,
        title, summary, status, scope, confidence, verification_status,
        payload, tags,
        version, created_at, updated_at,
        t_valid, t_invalid, when_to_use, freq, utility, history
      ) VALUES (
        ${id}, 2, ${entry.kind}, ${id}, 1,
        ${title}, ${summary}, 'active', ${sql.json({ repositoryId: entry.repo })}, ${entry.confidence}, ${verificationStatus},
        ${sql.json(payload as any)}, ${textArrayLiteral(tags)}::text[],
        1, ${created}, ${now},
        ${tValid}, ${entry.tInvalid ?? null}, ${whenToUseCol}, ${entry.freq ?? 0}, ${entry.utility ?? 0}, ${sql.json(history as any)}
      )
      ON CONFLICT (id) DO UPDATE SET
        title = EXCLUDED.title,
        summary = EXCLUDED.summary,
        confidence = EXCLUDED.confidence,
        verification_status = EXCLUDED.verification_status,
        payload = EXCLUDED.payload,
        tags = EXCLUDED.tags,
        when_to_use = EXCLUDED.when_to_use,
        t_invalid = EXCLUDED.t_invalid,
        history = EXCLUDED.history,
        version = memory_items.version + 1,
        updated_at = now()
    `;
    // 注意：upsert 不触碰 freq/utility/t_valid/created_at —— 账本与时间线不被同内容重写覆盖

    // 派生索引：embedding 失败不阻塞写入（spec §9.6 降级总则）
    try {
      const vec = await this.embedder.embed(embeddingInput(entry));
      await storeEmbedding(id, "1", vec, `ngram-${EMBEDDING_DIMENSIONS}`);
    } catch { /* embedding 失败不影响条目写入 */ }
  }

  async get(id: string): Promise<MemoryEntry | null> {
    const sql = getSql();
    const rows = await sql`SELECT * FROM memory_items WHERE id = ${id}`;
    return rows.length > 0 ? rowToEntry(rows[0] as Row) : null;
  }

  async invalidate(id: string, tInvalid: string): Promise<void> {
    const sql = getSql();
    await sql`
      UPDATE memory_items SET t_invalid = ${tInvalid}, updated_at = now()
      WHERE id = ${id}
    `;
  }

  async delete(id: string): Promise<void> {
    const sql = getSql();
    // memory_embeddings ON DELETE CASCADE（V008），无需显式清理
    await sql`DELETE FROM memory_items WHERE id = ${id}`;
  }

  async query(filter: MemoryFilter): Promise<MemoryEntry[]> {
    const sql = getSql();
    const conds: string[] = ["1=1"];
    const params: unknown[] = [];

    if (!filter.includeInvalidated) {
      conds.push("t_invalid IS NULL");
      // 降级条目过滤（spec §6.3）：verification_status='invalidated' 不进检索池
      conds.push("verification_status != 'invalidated'");
    }
    // 蒸馏降级条目（§5.7 append-only）默认在 query/list 可见（修复批次 A #4）；
    // 自动注入的排除在 searchText/searchVector 检索路径
    if (filter.includeDegraded === false) {
      conds.push("COALESCE(payload->>'degraded', 'false') != 'true'");
    }
    if (filter.kind) {
      params.push(filter.kind);
      conds.push(`type = $${params.length}`);
    }
    if (filter.repo) {
      params.push(filter.repo);
      conds.push(`scope->>'repositoryId' = $${params.length}`);
    }
    if (filter.source) {
      params.push(filter.source);
      conds.push(`payload->>'source' = $${params.length}`);
    }
    params.push(filter.limit ?? 50);
    const limit = `$${params.length}`;
    params.push(filter.offset ?? 0);
    const offset = `$${params.length}`;

    const rows = await sql.unsafe(
      `SELECT * FROM memory_items WHERE ${conds.join(" AND ")} ORDER BY updated_at DESC LIMIT ${limit} OFFSET ${offset}`,
      params as never[],
    );
    return rows.map((r) => rowToEntry(r as Row));
  }

  async searchText(queryText: string, k: number): Promise<ScoredId[]> {
    const sql = getSql();
    // 两路全文：V013 search_tsv（'english'，title/summary/subject/tags）
    // + V027 when_to_use_tsv（'simple'，episodic 检索键，中文友好），取较大 rank。
    // 只检索活跃且未降级的条目（spec §6.3 硬默认）。
    const rows = await sql`
      SELECT id, GREATEST(
               ts_rank(search_tsv, plainto_tsquery('english', ${queryText})),
               ts_rank(when_to_use_tsv, plainto_tsquery('simple', ${queryText}))
             ) AS score
      FROM memory_items
      WHERE t_invalid IS NULL
        AND verification_status != 'invalidated'
        AND COALESCE(payload->>'degraded', 'false') != 'true'
        AND (
          search_tsv @@ plainto_tsquery('english', ${queryText})
          OR when_to_use_tsv @@ plainto_tsquery('simple', ${queryText})
        )
      ORDER BY score DESC
      LIMIT ${k}
    `;
    return (rows as unknown as { id: string; score: number }[]).map((r) => ({
      id: r.id,
      score: r.score,
    }));
  }

  async searchVector(queryText: string, k: number): Promise<ScoredId[]> {
    const sql = getSql();
    const queryVec = await this.embedder.embed(queryText);
    const formatted = `[${queryVec.join(",")}]`;

    // 主路：pgvector 余弦距离（V008）
    try {
      const rows = await sql`
        SELECT m.id, 1 - (e.embedding <=> ${formatted}::vector) AS score
        FROM memory_embeddings e
        JOIN memory_items m ON m.id = e.memory_id
        WHERE m.t_invalid IS NULL
          AND m.verification_status != 'invalidated'
          AND COALESCE(m.payload->>'degraded', 'false') != 'true'
        ORDER BY e.embedding <=> ${formatted}::vector ASC
        LIMIT ${k}
      `;
      return (rows as unknown as { id: string; score: number }[]).map((r) => ({
        id: r.id,
        score: r.score,
      }));
    } catch {
      // 降级：JS 侧余弦（与 MemoryRetriever 的降级策略一致；spec §9.6）
      const rows = await sql`
        SELECT e.memory_id, e.embedding
        FROM memory_embeddings e
        JOIN memory_items m ON m.id = e.memory_id
        WHERE m.t_invalid IS NULL
          AND m.verification_status != 'invalidated'
          AND COALESCE(m.payload->>'degraded', 'false') != 'true'
      `;
      return (rows as unknown as { memory_id: string; embedding: unknown }[])
        .map((r) => ({
          id: r.memory_id,
          score: cosineSimilarity(queryVec, parseVector(r.embedding)),
        }))
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, k);
    }
  }

  async ledger(id: string): Promise<LedgerEntry | null> {
    const sql = getSql();
    const rows = await sql`SELECT freq, utility FROM memory_items WHERE id = ${id}`;
    if (rows.length === 0) return null;
    const row = rows[0] as { freq: number; utility: number };
    return { freq: row.freq, utility: row.utility };
  }

  async bumpLedger(id: string, field: "freq" | "utility"): Promise<void> {
    const sql = getSql();
    if (field === "freq") {
      await sql`UPDATE memory_items SET freq = freq + 1 WHERE id = ${id}`;
    } else {
      await sql`UPDATE memory_items SET utility = utility + 1 WHERE id = ${id}`;
    }
  }

  async reindex(): Promise<ReindexReport> {
    const sql = getSql();
    const rows = await sql`
      SELECT * FROM memory_items WHERE t_invalid IS NULL
    `;
    let indexed = 0;
    let failed = 0;
    const entries: MemoryEntry[] = [];
    for (const raw of rows as unknown as Row[]) {
      try {
        const entry = rowToEntry(raw);
        entries.push(entry);
        const vec = await this.embedder.embed(embeddingInput(entry));
        await storeEmbedding(entry.id, "1", vec, `ngram-${EMBEDDING_DIMENSIONS}`);
        indexed += 1;
      } catch {
        failed += 1;
      }
    }

    // 冒烟回归（spec §4.3）：抽最多 10 条刚重建索引的条目，
    // 用各自检索键文本做向量查询，验证能被召回
    const smokeSample = entries.slice(0, 10);
    const smokeFailedIds: string[] = [];
    let smokePassed = 0;
    for (const entry of smokeSample) {
      try {
        const hits = await this.searchVector(embeddingInput(entry), 5);
        if (hits.some((h) => h.id === entry.id)) {
          smokePassed += 1;
        } else {
          smokeFailedIds.push(entry.id);
        }
      } catch {
        smokeFailedIds.push(entry.id);
      }
    }

    return {
      scanned: rows.length,
      indexed,
      failed,
      smoke: { total: smokeSample.length, passed: smokePassed, failedIds: smokeFailedIds },
    };
  }
}
