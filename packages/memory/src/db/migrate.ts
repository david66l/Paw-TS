/**
 * 迁移执行器 —— 从 migrations/ 目录按顺序执行 .sql 文件
 *
 * 用法:
 *   bun run src/db/migrate.ts          # 执行所有未应用的迁移
 *   bun run src/db/migrate.ts --dry    # 列出待执行的迁移，不实际执行
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getSql, closeSql } from "./connection.js";

const MIGRATIONS_DIR = join(import.meta.dirname, "migrations");

function listMigrations(): { name: string; path: string }[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, path: join(MIGRATIONS_DIR, name) }));
}

async function runMigrations(dryRun = false): Promise<void> {
  const sql = getSql();

  // 确保迁移记录表存在
  await sql`
    CREATE TABLE IF NOT EXISTS _migrations (
      version     text PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `;

  const migrations = listMigrations();
  if (migrations.length === 0) {
    console.log("No migration files found.");
    return;
  }

  // 查询已应用的迁移
  const applied = await sql`SELECT version FROM _migrations ORDER BY version`;
  const appliedSet = new Set(applied.map((r) => (r as { version: string }).version));

  const pending = migrations.filter((m) => !appliedSet.has(m.name));
  if (pending.length === 0) {
    console.log(`All ${migrations.length} migrations already applied.`);
    return;
  }

  if (dryRun) {
    console.log(`Would apply ${pending.length} migration(s):`);
    for (const m of pending) console.log(`  - ${m.name}`);
    return;
  }

  console.log(`Applying ${pending.length} migration(s)...`);

  for (const m of pending) {
    const content = readFileSync(m.path, "utf-8");
    console.log(`  → ${m.name}`);
    await sql.unsafe(content);
    await sql`INSERT INTO _migrations (version) VALUES (${m.name})`;
    console.log(`    ✓ done`);
  }

  console.log("All migrations applied.");
}

const dry = process.argv.includes("--dry");
await runMigrations(dry);
await closeSql();
