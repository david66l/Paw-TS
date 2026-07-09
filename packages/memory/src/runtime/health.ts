/**
 * 记忆子系统健康检查 —— 供 `paw-ts doctor` 与运维脚本使用。
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { closeSql, getSql, ping as dbPing } from "../db/connection.js";

export type MemoryBackendKind = "db" | "file";

export interface MemoryHealthReport {
  readonly backend: MemoryBackendKind;
  /** 是否解析到 DATABASE_URL（值已脱敏） */
  readonly databaseUrlConfigured: boolean;
  readonly databaseUrlDisplay: string;
  readonly pingOk: boolean;
  readonly migrationsApplied: number;
  readonly migrationsPending: number;
  readonly pendingMigrationNames: readonly string[];
  readonly totalMigrations: number;
  /** 整体是否可用于当前 backend */
  readonly ok: boolean;
  readonly messages: readonly string[];
}

function redactDatabaseUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return url.replace(/:([^:@/]+)@/, ":***@");
  }
}

function listMigrationFiles(): string[] {
  const dir = join(import.meta.dirname, "..", "db", "migrations");
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
  } catch {
    return [];
  }
}

/**
 * 检查记忆后端健康状态。
 *
 * - `backend: "file"`：不连库，ok=true（提示可切换 db）
 * - `backend: "db"`：ping + 比对 _migrations 与 migrations/ 目录
 *
 * @param opts.closeConnection 结束后是否 close 连接池（CLI doctor 建议 true）
 */
export async function checkMemoryHealth(opts: {
  readonly backend: MemoryBackendKind;
  readonly closeConnection?: boolean;
}): Promise<MemoryHealthReport> {
  const messages: string[] = [];
  const rawUrl =
    process.env.DATABASE_URL ?? "postgresql://localhost:5432/paw_memory";
  const databaseUrlConfigured = Boolean(process.env.DATABASE_URL?.trim());
  const databaseUrlDisplay = redactDatabaseUrl(rawUrl);
  const migrationFiles = listMigrationFiles();
  const totalMigrations = migrationFiles.length;

  if (opts.backend === "file") {
    messages.push(
      "Memory backend: file (legacy). Default is db — remove memory_backend=file to use Postgres Runtime.",
    );
    return {
      backend: "file",
      databaseUrlConfigured,
      databaseUrlDisplay,
      pingOk: false,
      migrationsApplied: 0,
      migrationsPending: 0,
      pendingMigrationNames: [],
      totalMigrations,
      ok: true,
      messages,
    };
  }

  // db backend
  let pingOk = false;
  let applied = 0;
  let pendingNames: string[] = [];

  try {
    pingOk = await dbPing();
    if (!pingOk) {
      messages.push(
        "Postgres ping failed. Check DATABASE_URL and that the server is running.",
      );
    } else {
      messages.push("Postgres ping: ok");
      const sql = getSql();
      await sql`
        CREATE TABLE IF NOT EXISTS _migrations (
          version     text PRIMARY KEY,
          applied_at  timestamptz NOT NULL DEFAULT now()
        )
      `;
      const rows = await sql`SELECT version FROM _migrations ORDER BY version`;
      const appliedSet = new Set(
        rows.map((r) => (r as { version: string }).version),
      );
      applied = appliedSet.size;
      pendingNames = migrationFiles.filter((n) => !appliedSet.has(n));
      if (pendingNames.length === 0) {
        messages.push(
          `Migrations: all ${totalMigrations} applied (${applied} rows in _migrations).`,
        );
      } else {
        messages.push(
          `Migrations: ${pendingNames.length} pending. Run: bun run memory:migrate`,
        );
        for (const n of pendingNames.slice(0, 8)) {
          messages.push(`  - ${n}`);
        }
        if (pendingNames.length > 8) {
          messages.push(`  ... and ${pendingNames.length - 8} more`);
        }
      }
    }
  } catch (e) {
    pingOk = false;
    messages.push(
      `Memory health check error: ${e instanceof Error ? e.message : String(e)}`,
    );
  } finally {
    if (opts.closeConnection !== false) {
      try {
        await closeSql();
      } catch {
        /* ignore */
      }
    }
  }

  const ok = pingOk && pendingNames.length === 0;
  if (ok) {
    messages.push("Memory backend db: ready");
  } else if (pingOk) {
    messages.push("Memory backend db: reachable but migrations incomplete");
  } else {
    messages.push("Memory backend db: not ready");
  }

  return {
    backend: "db",
    databaseUrlConfigured,
    databaseUrlDisplay,
    pingOk,
    migrationsApplied: applied,
    migrationsPending: pendingNames.length,
    pendingMigrationNames: pendingNames,
    totalMigrations,
    ok,
    messages,
  };
}

/**
 * 从 settings 解析记忆后端。
 * Phase 5：在线路径仅 db；file 设置被忽略（迁移用 migrate-legacy）。
 */
export function resolveMemoryBackendFromSettings(
  _settings: Record<string, unknown> | undefined,
): MemoryBackendKind {
  if (process.env.PAW_MEMORY_BACKEND === "file") {
    // 仍允许强制 file 仅用于 doctor 诊断，agent 已不读此路径
    return "file";
  }
  return "db";
}
