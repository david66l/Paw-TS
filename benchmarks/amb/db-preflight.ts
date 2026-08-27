import { closeSql, getSql, ping } from "../../packages/memory/src/db/connection.js";

const reachable = await ping();
let database = "unknown";
let memoryItems = false;
let errorCode: string | undefined;
try {
  const sql = getSql();
  const rows = await sql`
    SELECT
      current_database() AS database,
      to_regclass('public.memory_items')::text AS memory_items
  `;
  const row = rows[0] as
    | { readonly database?: unknown; readonly memory_items?: unknown }
    | undefined;
  database = String(row?.database ?? "unknown");
  memoryItems = row?.memory_items != null;
} catch (error) {
  errorCode =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : error instanceof Error
        ? error.name
        : "UnknownError";
} finally {
  await closeSql();
}

console.log(
  JSON.stringify({
    schemaVersion: "paw.amb-db-preflight.v1",
    reachable,
    database,
    memoryItems,
    ...(errorCode ? { errorCode } : {}),
  }),
);
