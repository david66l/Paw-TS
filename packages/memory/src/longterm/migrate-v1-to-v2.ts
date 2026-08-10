/**
 * v1 → v2 存量记忆迁移（spec v2 接入的存量处理）
 *
 * v1（MemoryRuntime v1）写入的 memory_items 行 type 是 v1 类型
 * （task_summary/decision/failure/user_preference/rule/project_knowledge/skill），
 * 不是 v2 的 kind（semantic/episodic/profile/vault_ref）：
 * - v2 检索路径按 kind 路由（TRIGGER_KINDS 过滤），v1 行不可见
 * - v2 reindex 冒烟对缺 kind 特有字段的行 embed 抛错（历史 ws:* 残留即此类）
 *
 * 本迁移：type → kind 映射 + payload 规范化 + 重算 embedding，逐行走 engine.put
 * （put 保留原 id，ON CONFLICT 现在会更新 type 列）。幂等：type 已是 v2 kind 的跳过。
 *
 * 映射（best-effort，migratedFrom 审计）：
 * - user_preference / rule / project_knowledge / decision → semantic（fact = summary）
 * - task_summary / skill / failure → episodic（whenToUse 从 title/工具名构造）
 *
 * CLI：paw-ts memory migrate-v1-to-v2 [--dry-run] [--repo <id>]
 */

import { getSql, parseJson } from "../db/connection.js";
import { appendOpLog } from "./observability/op-log.js";
import type { MemoryEntry, MemoryKind } from "./store/engine.js";
import { PostgresMemoryStoreEngine } from "./store/postgres-engine.js";

export interface MigrateV1ToV2Options {
  /** 预览不写库 */
  dryRun?: boolean;
  /** 限定 repo（scope->>'repositoryId'）；缺省全部 */
  repo?: string;
  engine?: PostgresMemoryStoreEngine;
}

export interface MigrateV1ToV2Result {
  scanned: number;
  migrated: number;
  skipped: number;
  failed: number;
  dryRun: boolean;
  /** type → 迁移条数（诊断） */
  byType: Record<string, number>;
  failedIds: string[];
}

const V1_TYPES: readonly string[] = [
  "task_summary",
  "decision",
  "failure",
  "user_preference",
  "rule",
  "project_knowledge",
  "skill",
];
const V2_KINDS: readonly string[] = [
  "semantic",
  "episodic",
  "profile",
  "vault_ref",
];

/** type → kind 映射（pure，供单测） */
export function mapV1TypeToKind(type: string): MemoryKind | null {
  if (V2_KINDS.includes(type)) return type as MemoryKind;
  if (
    type === "user_preference" ||
    type === "rule" ||
    type === "project_knowledge" ||
    type === "decision"
  ) {
    return "semantic";
  }
  if (type === "task_summary" || type === "skill" || type === "failure") {
    return "episodic";
  }
  return null;
}

/** 从 v1 行构造 v2 条目（pure，供单测） */
export function buildV2EntryFromV1Row(row: {
  id: string;
  type: string;
  title: string;
  summary: string;
  confidence: number;
  t_valid?: unknown;
  t_invalid?: unknown;
  freq?: number;
  utility?: number;
  payload: unknown;
  /** v1 行 scope 列的 repositoryId（engine.put 用 entry.repo 写 scope） */
  repo?: string;
}): MemoryEntry | null {
  const kind = mapV1TypeToKind(row.type);
  if (!kind) return null;

  const payload = (parseJson(row.payload) ?? {}) as Record<string, unknown>;
  const toIso = (v: unknown): string | undefined =>
    v instanceof Date ? v.toISOString() : typeof v === "string" ? v : undefined;
  const base = {
    id: row.id,
    kind,
    repo: row.repo ?? "",
    created:
      toIso(payload.createdAt) ??
      toIso(payload.created_at) ??
      new Date().toISOString(),
    tValid: toIso(row.t_valid) ?? new Date().toISOString(),
    tInvalid: row.t_invalid != null ? (toIso(row.t_invalid) ?? null) : null,
    source: "agent_verified" as const,
    confidence: row.confidence ?? 0.5,
    evidence: [] as string[],
    freq: row.freq ?? 0,
    utility: row.utility ?? 0,
  };

  if (kind === "semantic") {
    const fact = row.summary || row.title || "";
    if (!fact.trim()) return null; // 空内容无检索价值，跳过
    return {
      ...base,
      kind: "semantic" as const,
      fact,
      keywords: extractMigratedKeywords(row.title, row.summary),
      embeddingKey: `${row.title} ${row.summary}`,
    } as MemoryEntry;
  }
  // episodic：whenToUse 从 title / 工具名构造
  const toolName =
    typeof payload.toolName === "string"
      ? payload.toolName
      : typeof payload.errorPattern === "string"
        ? "failure"
        : "task";
  const title = row.title || row.summary || "";
  if (!title.trim() && !row.summary.trim()) return null; // 空内容跳过
  const whenToUse =
    row.type === "failure"
      ? `When ${toolName} fails, expect ${(row.summary || "an error").slice(0, 120)}`
      : `When working on "${title.slice(0, 120)}", use this experience`;
  return {
    ...base,
    kind: "episodic" as const,
    whenToUse,
    perspective: (row.summary || row.title).slice(0, 500),
    modification: [] as string[],
    issueType: row.type === "failure" ? String(toolName) : "legacy_v1",
    taskId: typeof payload.taskId === "string" ? payload.taskId : "",
  } as unknown as MemoryEntry;
}

/** 迁移 keywords：title/summary 词面切词（≤6 个，供 BM25） */
export function extractMigratedKeywords(...texts: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const text of texts) {
    for (const tok of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
      if (tok.length < 3 || seen.has(tok)) continue;
      seen.add(tok);
      out.push(tok);
      if (out.length >= 6) return out;
    }
  }
  return out;
}

/** 迁移入口：扫描 v1 行 → engine.put（dry-run 只统计） */
export async function migrateV1ToV2(
  opts: MigrateV1ToV2Options = {},
): Promise<MigrateV1ToV2Result> {
  const sql = getSql();
  const engine = opts.engine ?? new PostgresMemoryStoreEngine();
  const dryRun = opts.dryRun === true;

  const conds = ["type = ANY($1::text[])"];
  const params: unknown[] = [V1_TYPES];
  if (opts.repo) {
    params.push(opts.repo);
    conds.push(`scope->>'repositoryId' = $${params.length}`);
  }
  const rows = (await sql.unsafe(
    `SELECT id, type, title, summary, confidence, t_valid, t_invalid, freq, utility, payload, scope
     FROM memory_items WHERE ${conds.join(" AND ")} ORDER BY updated_at ASC`,
    params as never[],
  )) as unknown as Record<string, unknown>[];

  const result: MigrateV1ToV2Result = {
    scanned: rows.length,
    migrated: 0,
    skipped: 0,
    failed: 0,
    dryRun,
    byType: {},
    failedIds: [],
  };

  for (const raw of rows) {
    const type = String(raw.type ?? "");
    result.byType[type] = (result.byType[type] ?? 0) + 1;

    // v1 scope 列（JSONB）→ repo
    const scope = (parseJson(raw.scope) ?? {}) as { repositoryId?: string };
    const repo =
      typeof scope.repositoryId === "string" ? scope.repositoryId : "";

    const entry = buildV2EntryFromV1Row({
      id: String(raw.id),
      type,
      title: String(raw.title ?? ""),
      summary: String(raw.summary ?? ""),
      confidence: Number(raw.confidence ?? 0.5),
      t_valid: raw.t_valid,
      t_invalid: raw.t_invalid,
      freq: Number(raw.freq ?? 0),
      utility: Number(raw.utility ?? 0),
      payload: raw.payload,
      repo,
    });
    if (!entry) {
      result.skipped += 1;
      continue;
    }
    // 空内容不迁移（无检索价值；迁移只产出 semantic/episodic 两 kind）
    const content =
      (entry as unknown as { fact?: string; perspective?: string }).fact ??
      (entry as unknown as { fact?: string; perspective?: string }).perspective;
    if (!content?.trim()) {
      result.skipped += 1;
      continue;
    }

    if (dryRun) {
      result.migrated += 1;
      continue;
    }

    try {
      // migratedFrom 审计标记（payload 内，随 put 序列化）
      const migrated = {
        ...entry,
        migratedFrom: type,
      } as unknown as MemoryEntry;
      await engine.put(migrated);
      result.migrated += 1;
    } catch {
      result.failed += 1;
      result.failedIds.push(String(raw.id));
    }
  }

  if (!dryRun && result.migrated > 0) {
    await appendOpLog("v1_to_v2_migrated", {
      detail: {
        migrated: result.migrated,
        byType: result.byType,
        failed: result.failed,
      },
    });
  }

  return result;
}
