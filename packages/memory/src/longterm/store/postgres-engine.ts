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
  MEMORY_EMBEDDING_DIMENSIONS,
  NGramEmbeddingService,
  cosineSimilarity,
  storeEmbedding,
} from "../../db/modules/platform/embeddingService.js";
import { appendOpLog } from "../observability/op-log.js";
import {
  LEDGER_UTILITY_MAX,
  type LedgerEntry,
  type MemoryEntry,
  type MemoryFilter,
  type MemoryStoreEngine,
  type ReindexReport,
  type ScoredId,
} from "./engine.js";
import { deriveEntryId } from "./id.js";
import {
  createMemoryScopeKey,
  type MemoryScopeKey,
} from "./scope-key.js";

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
function renderSearchText(entry: MemoryEntry): {
  title: string;
  summary: string;
  tags: string[];
} {
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
        ]
          .filter(Boolean)
          .join("\n"),
        tags: [entry.issueType, ...(entry.branch ? [entry.branch] : [])],
      };
    case "profile":
      return { title: entry.insight, summary: entry.insight, tags: [] };
    case "vault_ref":
      return {
        title: entry.refDescription,
        summary: entry.refDescription,
        tags: [],
      };
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
    try {
      return JSON.parse(raw) as number[];
    } catch {
      return [];
    }
  }
  return [];
}

export class PostgresMemoryStoreEngine implements MemoryStoreEngine {
  readonly scope?: MemoryScopeKey;
  private readonly embedder = new NGramEmbeddingService(EMBEDDING_DIMENSIONS);

  constructor(scope?: MemoryScopeKey) {
    this.scope = scope ? createMemoryScopeKey(scope) : undefined;
  }

  async put(entry: MemoryEntry): Promise<void> {
    const sql = getSql();
    const id = entry.id || deriveEntryId(entry, this.scope);
    const now = new Date().toISOString();
    const created = entry.created || now;
    const tValid = entry.tValid || created;
    const { title, summary, tags } = renderSearchText(entry);
    const whenToUse = entry.kind === "episodic" ? entry.whenToUse : null;
    const whenToUseCol = whenToUse ?? null;
    const history = entry.kind === "semantic" ? (entry.history ?? []) : [];
    // payload 存完整条目（kind 特有字段 + source/evidence 等），基础列字段在读出时以列为准
    const payload = { ...entry, id };
    const storedScope =
      this.scope ??
      ({
        tenantId: "legacy",
        userId: "legacy",
        workspaceId: entry.repo || "legacy",
        repositoryId: entry.repo || "legacy",
      } satisfies MemoryScopeKey);
    // verification_status 按条目推导（修复批次 A #2）：固化通道（可信 source）→ verified；
    // 降级条目（payload.degraded）与纯推断（agent_inferred）→ unverified
    const degraded = (entry as { degraded?: boolean }).degraded === true;
    const verificationStatus = degraded
      ? "unverified"
      : [
            "agent_verified",
            "user_statement",
            "repo_docs",
            "trial_graduated",
          ].includes(entry.source)
        ? "verified"
        : "unverified";

    const rows = await sql`
      INSERT INTO memory_items (
        id, schema_version, type, subject_key, subject_key_version,
        title, summary, status, scope, confidence, verification_status,
        payload, tags,
        version, created_at, updated_at,
        t_valid, t_invalid, when_to_use, freq, utility, history
      ) VALUES (
        ${id}, 2, ${entry.kind}, ${id}, 1,
        ${title}, ${summary}, 'active', ${sql.json(storedScope as any)}, ${entry.confidence}, ${verificationStatus},
        ${sql.json(payload as any)}, ${textArrayLiteral(tags)}::text[],
        1, ${created}, ${now},
        ${tValid}, ${entry.tInvalid ?? null}, ${whenToUseCol}, ${entry.freq ?? 0}, ${entry.utility ?? 0}, ${sql.json(history as any)}
      )
      ON CONFLICT (id) DO UPDATE SET
        type = EXCLUDED.type,
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
      WHERE ${this.scope == null}
         OR (
           memory_items.scope->>'tenantId' = ${this.scope?.tenantId ?? ""}
           AND memory_items.scope->>'userId' = ${this.scope?.userId ?? ""}
           AND memory_items.scope->>'workspaceId' = ${this.scope?.workspaceId ?? ""}
           AND memory_items.scope->>'repositoryId' = ${this.scope?.repositoryId ?? ""}
         )
      RETURNING id
    `;
    if (rows.length === 0) {
      throw new Error("Memory ID collision outside the active scope");
    }
    // 注意：upsert 不触碰 freq/utility/t_valid/created_at —— 账本与时间线不被同内容重写覆盖

    // 派生索引：embedding 失败不阻塞写入（spec §9.6 降级总则）
    try {
      const vec = await this.embedder.embed(embeddingInput(entry));
      await storeEmbedding(id, "1", vec, `ngram-${EMBEDDING_DIMENSIONS}`);
    } catch {
      /* embedding 失败不影响条目写入 */
    }
  }

  async get(id: string): Promise<MemoryEntry | null> {
    const sql = getSql();
    const rows = await sql`
      SELECT * FROM memory_items
      WHERE id = ${id}
        ${this.scope ? sql`AND scope->>'tenantId' = ${this.scope.tenantId}
          AND scope->>'userId' = ${this.scope.userId}
          AND scope->>'workspaceId' = ${this.scope.workspaceId}
          AND scope->>'repositoryId' = ${this.scope.repositoryId}` : sql``}
    `;
    return rows.length > 0 ? rowToEntry(rows[0] as Row) : null;
  }

  async invalidate(id: string, tInvalid: string): Promise<void> {
    const sql = getSql();
    await sql`
      UPDATE memory_items SET t_invalid = ${tInvalid}, updated_at = now()
      WHERE id = ${id}
        ${this.scope ? sql`AND scope->>'tenantId' = ${this.scope.tenantId}
          AND scope->>'userId' = ${this.scope.userId}
          AND scope->>'workspaceId' = ${this.scope.workspaceId}
          AND scope->>'repositoryId' = ${this.scope.repositoryId}` : sql``}
    `;
  }

  async delete(id: string): Promise<void> {
    const sql = getSql();
    // memory_embeddings ON DELETE CASCADE（V008），无需显式清理
    await sql`
      DELETE FROM memory_items WHERE id = ${id}
        ${this.scope ? sql`AND scope->>'tenantId' = ${this.scope.tenantId}
          AND scope->>'userId' = ${this.scope.userId}
          AND scope->>'workspaceId' = ${this.scope.workspaceId}
          AND scope->>'repositoryId' = ${this.scope.repositoryId}` : sql``}
    `;
  }

  async query(filter: MemoryFilter): Promise<MemoryEntry[]> {
    const sql = getSql();
    const conds: string[] = ["1=1"];
    const params: unknown[] = [];

    if (this.scope) {
      for (const [key, value] of Object.entries(this.scope)) {
        params.push(value);
        conds.push(`scope->>'${key}' = $${params.length}`);
      }
    }

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

  async searchText(queryText: string, k: number, repo?: string): Promise<ScoredId[]> {
    const sql = getSql();
    // 三路全文取最大 rank：V013 search_tsv（'english'）+ V027 when_to_use_tsv（'simple'）
    // + V032 search_tsv_simple（'simple'，含 title/summary/when_to_use——中文场景句兜底，
    // 'english' 配置对 CJK token 区分度差，修复批次 B #12）。
    // 只检索活跃且未降级的条目（spec §6.3 硬默认）。
    // repo 可选：注入路径 repo 密封（A 仓库任务不注入 B 仓库记忆）。
    const repoCond = repo ? sql`AND scope->>'repositoryId' = ${repo}` : sql``;
    const scopeCond = this.scope
      ? sql`AND scope->>'tenantId' = ${this.scope.tenantId}
          AND scope->>'userId' = ${this.scope.userId}
          AND scope->>'workspaceId' = ${this.scope.workspaceId}
          AND scope->>'repositoryId' = ${this.scope.repositoryId}`
      : sql``;
    const rows = await sql`
      SELECT id, GREATEST(
               ts_rank(search_tsv, plainto_tsquery('english', ${queryText})),
               ts_rank(when_to_use_tsv, plainto_tsquery('simple', ${queryText})),
               ts_rank(search_tsv_simple, plainto_tsquery('simple', ${queryText}))
             ) AS score
      FROM memory_items
      WHERE t_invalid IS NULL
        AND verification_status != 'invalidated'
        AND COALESCE(payload->>'degraded', 'false') != 'true'
        ${scopeCond}
        ${repoCond}
        AND (
          search_tsv @@ plainto_tsquery('english', ${queryText})
          OR when_to_use_tsv @@ plainto_tsquery('simple', ${queryText})
          OR search_tsv_simple @@ plainto_tsquery('simple', ${queryText})
        )
      ORDER BY score DESC
      LIMIT ${k}
    `;
    return (rows as unknown as { id: string; score: number }[]).map((r) => ({
      id: r.id,
      score: r.score,
    }));
  }

  async searchVector(queryText: string, k: number, repo?: string): Promise<ScoredId[]> {
    const sql = getSql();
    const queryVec = await this.embedder.embed(queryText);
    const formatted = `[${queryVec.join(",")}]`;
    // repo 可选：注入路径 repo 密封（否则共享库中同内容异仓库条目竞争 top-k）
    const repoCond = repo ? sql`AND m.scope->>'repositoryId' = ${repo}` : sql``;
    const scopeCond = this.scope
      ? sql`AND m.scope->>'tenantId' = ${this.scope.tenantId}
          AND m.scope->>'userId' = ${this.scope.userId}
          AND m.scope->>'workspaceId' = ${this.scope.workspaceId}
          AND m.scope->>'repositoryId' = ${this.scope.repositoryId}`
      : sql``;

    // 主路：pgvector 余弦距离（V008）
    try {
      const rows = await sql`
        SELECT m.id, 1 - (e.embedding <=> ${formatted}::vector) AS score
        FROM memory_embeddings e
        JOIN memory_items m ON m.id = e.memory_id
        WHERE m.t_invalid IS NULL
          AND m.verification_status != 'invalidated'
          AND COALESCE(m.payload->>'degraded', 'false') != 'true'
          ${scopeCond}
          ${repoCond}
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
          ${scopeCond}
          ${repoCond}
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
    const rows = await sql`
      SELECT freq, utility FROM memory_items WHERE id = ${id}
        ${this.scope ? sql`AND scope->>'tenantId' = ${this.scope.tenantId}
          AND scope->>'userId' = ${this.scope.userId}
          AND scope->>'workspaceId' = ${this.scope.workspaceId}
          AND scope->>'repositoryId' = ${this.scope.repositoryId}` : sql``}
    `;
    if (rows.length === 0) return null;
    const row = rows[0] as { freq: number; utility: number };
    return { freq: row.freq, utility: row.utility };
  }

  async bumpLedger(id: string, field: "freq" | "utility"): Promise<void> {
    const sql = getSql();
    if (field === "freq") {
      await sql`
        UPDATE memory_items SET freq = freq + 1 WHERE id = ${id}
          ${this.scope ? sql`AND scope->>'tenantId' = ${this.scope.tenantId}
            AND scope->>'userId' = ${this.scope.userId}
            AND scope->>'workspaceId' = ${this.scope.workspaceId}
            AND scope->>'repositoryId' = ${this.scope.repositoryId}` : sql``}
      `;
    } else {
      // utility 封顶（红队修复：utility farming 防御）——所有递增路径（含 settleRunOutcome/
      // recordTaskSuccess 聚合结算与 bumpLedger 直调）都汇聚到这一个 SQL，统一 clamp
      await sql`
        UPDATE memory_items SET utility = LEAST(utility + 1, ${LEDGER_UTILITY_MAX}) WHERE id = ${id}
          ${this.scope ? sql`AND scope->>'tenantId' = ${this.scope.tenantId}
            AND scope->>'userId' = ${this.scope.userId}
            AND scope->>'workspaceId' = ${this.scope.workspaceId}
            AND scope->>'repositoryId' = ${this.scope.repositoryId}` : sql``}
      `;
    }
  }

  async reindex(): Promise<ReindexReport> {
    const sql = getSql();
    // 扫描与冒烟同一过滤口径：活跃 + 非降级（修复批次 C #14）
    const rows = await sql`
      SELECT * FROM memory_items
      WHERE t_invalid IS NULL
        AND COALESCE(payload->>'degraded', 'false') != 'true'
        ${this.scope ? sql`AND scope->>'tenantId' = ${this.scope.tenantId}
          AND scope->>'userId' = ${this.scope.userId}
          AND scope->>'workspaceId' = ${this.scope.workspaceId}
          AND scope->>'repositoryId' = ${this.scope.repositoryId}` : sql``}
    `;
    let indexed = 0;
    let failed = 0;
    const entries: MemoryEntry[] = [];
    for (const raw of rows as unknown as Row[]) {
      try {
        const entry = rowToEntry(raw);
        entries.push(entry);
        const vec = await this.embedder.embed(embeddingInput(entry));
        await storeEmbedding(
          entry.id,
          "1",
          vec,
          `ngram-${EMBEDDING_DIMENSIONS}`,
        );
        indexed += 1;
      } catch {
        failed += 1;
      }
    }

    // 冒烟回归（spec §4.3，修复批次 C #14）：随机抽 ≤10 条，用**关键词子集**
    // （keywords 前 2 个 / 文本前 40 字符截断变体）查询，断言出现在 top-10——
    // 不再用"条目自己的完整文本查自己"（那是永真冒烟）。
    const smokeSample = shuffle(entries).slice(0, 10);
    const smokeFailedIds: string[] = [];
    let smokePassed = 0;
    for (const entry of smokeSample) {
      try {
        const probe = smokeProbe(entry);
        const [textHits, vecHits] = await Promise.all([
          this.searchText(probe, 10).catch(() => [] as ScoredId[]),
          this.searchVector(probe, 10).catch(() => [] as ScoredId[]),
        ]);
        if (
          textHits.some((h) => h.id === entry.id) ||
          vecHits.some((h) => h.id === entry.id)
        ) {
          smokePassed += 1;
        } else {
          smokeFailedIds.push(entry.id);
        }
      } catch {
        smokeFailedIds.push(entry.id);
      }
    }

    const report = {
      scanned: rows.length,
      indexed,
      failed,
      smoke: {
        total: smokeSample.length,
        passed: smokePassed,
        failedIds: smokeFailedIds,
      },
    };
    // reindex 留痕（修复批次 C #14）
    try {
      await appendOpLog("reindex", {
        detail: {
          scanned: report.scanned,
          indexed,
          failed,
          smokeTotal: report.smoke.total,
          smokePassed,
          smokeFailedIds,
        },
      });
    } catch {
      /* op-log 失败不影响 reindex 结果 */
    }
    return report;
  }
}

function shuffle<T>(xs: T[]): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** 冒烟探针：条目文本的关键词子集（非全文），模拟真实查询形态 */
export function smokeProbe(entry: MemoryEntry): string {
  if (entry.kind === "semantic" && entry.keywords.length > 0) {
    return entry.keywords.slice(0, 2).join(" ");
  }
  const text = embeddingInput(entry);
  return text.slice(0, 40);
}
