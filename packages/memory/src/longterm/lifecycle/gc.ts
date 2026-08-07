/**
 * memory gc（spec v2 §7.2 / §9.2，M7）
 *
 * 物理清理已软失效（tInvalid≠null）的条目：
 * 1. 先归档到 memory_gc_archive 表（V029；可选 --export 再导出 JSONL，
 *    对应 file 后端的 _meta/archive-YYYYMM.jsonl）
 * 2. 再物理删除 memory_items 行（memory_embeddings ON DELETE CASCADE）
 *
 * --dry-run 只报告不动数据。
 */

import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { getSql } from "../../db/connection.js";
import { generateId } from "../../db/modules/platform/idGen.js";
import { appendOpLog } from "../observability/op-log.js";

export interface GcOptions {
  dryRun?: boolean;
  /** 可选：额外导出 JSONL 到该目录（生成 archive-YYYYMM.jsonl） */
  exportDir?: string;
  repo?: string;
  /** 单批上限（防误操作），默认 500 */
  limit?: number;
}

export interface GcReport {
  /** 符合清理条件的已失效条目数 */
  eligible: number;
  archived: number;
  deleted: number;
  dryRun: boolean;
  /** 导出文件路径（未导出为 null） */
  exportPath: string | null;
  archivedIds: string[];
}

interface DeadRow {
  id: string;
  entry: Record<string, unknown>;
}

async function loadDeadRows(repo: string | undefined, limit: number): Promise<DeadRow[]> {
  const sql = getSql();
  const rows = repo
    ? await sql`
        SELECT * FROM memory_items
        WHERE t_invalid IS NOT NULL AND scope->>'repositoryId' = ${repo}
        ORDER BY t_invalid ASC LIMIT ${limit}
      `
    : await sql`
        SELECT * FROM memory_items WHERE t_invalid IS NOT NULL
        ORDER BY t_invalid ASC LIMIT ${limit}
      `;
  return (rows as unknown as Record<string, unknown>[]).map((r) => ({
    id: r.id as string,
    entry: r,
  }));
}

export async function collectGarbage(opts: GcOptions = {}): Promise<GcReport> {
  const limit = opts.limit ?? 500;
  const dead = await loadDeadRows(opts.repo, limit);
  const report: GcReport = {
    eligible: dead.length,
    archived: 0,
    deleted: 0,
    dryRun: opts.dryRun ?? false,
    exportPath: null,
    archivedIds: dead.map((d) => d.id),
  };
  if (dead.length === 0 || report.dryRun) return report;

  const sql = getSql();

  // 1. 归档（db 表）
  for (const d of dead) {
    await sql`
      INSERT INTO memory_gc_archive (id, entry_id, archived_at, entry)
      VALUES (${generateId("gca")}, ${d.id}, now(), ${sql.json(d.entry as any)})
    `;
    report.archived += 1;
  }

  // 2. 可选 JSONL 导出
  if (opts.exportDir) {
    await mkdir(opts.exportDir, { recursive: true });
    const month = new Date().toISOString().slice(0, 7).replace("-", "");
    const path = join(opts.exportDir, `archive-${month}.jsonl`);
    for (const d of dead) {
      await appendFile(path, JSON.stringify({ archivedAt: new Date().toISOString(), ...d.entry }) + "\n", "utf-8");
    }
    report.exportPath = path;
  }

  // 3. 物理删除
  for (const d of dead) {
    await sql`DELETE FROM memory_items WHERE id = ${d.id}`;
    report.deleted += 1;
  }

  // 4. op-log（修复批次 B #13）：物理删除留痕，diff 的 purged 口径读此
  await appendOpLog("lifecycle.gc", {
    entryIds: report.archivedIds,
    detail: { archived: report.archived, archive: "memory_gc_archive", exportPath: report.exportPath },
  });

  return report;
}

/** 查归档（gc 后可查） */
export async function queryArchive(entryId: string): Promise<Record<string, unknown> | null> {
  const sql = getSql();
  const rows = await sql`
    SELECT entry FROM memory_gc_archive WHERE entry_id = ${entryId} ORDER BY archived_at DESC LIMIT 1
  `;
  if (rows.length === 0) return null;
  const raw = (rows[0] as { entry: unknown }).entry;
  return (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<string, unknown>;
}
