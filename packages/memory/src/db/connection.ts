/**
 * 数据库连接池 —— 单例 postgres.js 客户端
 */

import postgres from "postgres";

let _sql: ReturnType<typeof postgres> | null = null;

export function getSql(): ReturnType<typeof postgres> {
  if (!_sql) {
    const url = process.env.DATABASE_URL ?? "postgresql://localhost:5432/paw_memory";
    _sql = postgres(url, {
      max: 10,
      idle_timeout: 30,
      connect_timeout: 10,
    });
  }
  return _sql;
}

export async function closeSql(): Promise<void> {
  if (_sql) {
    await _sql.end();
    _sql = null;
  }
}

export async function ping(): Promise<boolean> {
  try {
    const sql = getSql();
    const [row] = await sql`SELECT 1 AS ok`;
    return (row as { ok: number }).ok === 1;
  } catch {
    return false;
  }
}

/** JSON 序列化辅助：postgres.js 的 sql.json() 要求严格的 JSONValue 类型，用此函数桥接 */
export function j(v: unknown): string {
  return JSON.stringify(v);
}

/** 解析 JSONB 列：postgres.js 可能返回字符串或已解析对象，统一返回 unknown 供调用方 cast */
export function parseJson(v: unknown): unknown {
  if (typeof v === "string") return JSON.parse(v) as unknown;
  return v;
}
