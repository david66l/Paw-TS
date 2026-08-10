/**
 * v1 → v2 存量迁移测试。
 *
 * pure 部分：type→kind 映射、行→条目构造、keywords 提取。
 * DB 部分：插入 v1 形状行 → 迁移 → kind 改写/payload 规范化/embedding/幂等/dry-run。
 *
 * 需要 PostgreSQL（V026+）：
 *   DATABASE_URL="postgresql://postgres@127.0.0.1:54329/paw_memory_test" bun test test/migrate-v1-to-v2.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { closeSql, getSql, j } from "../src/db/connection.js";
import {
  buildV2EntryFromV1Row,
  extractMigratedKeywords,
  mapV1TypeToKind,
  migrateV1ToV2,
} from "../src/longterm/migrate-v1-to-v2.js";
import { PostgresMemoryStoreEngine } from "../src/longterm/store/postgres-engine.js";

const DB_URL = process.env.DATABASE_URL ?? "postgresql:///paw_memory_test";
process.env.DATABASE_URL = DB_URL;

const REPO = `migrate-v1-e2e-${Date.now().toString(36)}`;
const migratedIds: string[] = [];

function v1Row(
  type: string,
  overrides: Partial<Record<string, unknown>> = {},
): { id: string; type: string; title: string; summary: string; confidence: number; payload: string } {
  return {
    id: `v1-${type}-${Date.now().toString(36)}`,
    type,
    title: String(overrides.title ?? `Title for ${type}`),
    summary: String(overrides.summary ?? `Summary for ${type} with useful content`),
    confidence: Number(overrides.confidence ?? 0.7),
    payload: j({
      taskId: `tsk_${type}`,
      toolName: "workspace.run_shell",
      createdAt: new Date().toISOString(),
      ...((overrides.payload ?? {}) as Record<string, unknown>),
    }),
  };
}

beforeAll(async () => {
  const sql = getSql();
  const [row] = await sql`SELECT 1 AS ok`;
  expect((row as { ok: number }).ok).toBe(1);
});

afterAll(async () => {
  try {
    const sql = getSql();
    for (const id of migratedIds) {
      await sql.unsafe("DELETE FROM memory_embeddings WHERE memory_id = $1", [id]);
      await sql.unsafe("DELETE FROM memory_items WHERE id = $1", [id]);
    }
    await sql.unsafe("DELETE FROM memory_items WHERE scope->>'repositoryId' = $1", [REPO]);
    await closeSql();
  } catch {
    /* best-effort */
  }
});

describe("pure: type→kind 映射", () => {
  test("7 个 v1 类型全部有映射", () => {
    expect(mapV1TypeToKind("user_preference")).toBe("semantic");
    expect(mapV1TypeToKind("rule")).toBe("semantic");
    expect(mapV1TypeToKind("project_knowledge")).toBe("semantic");
    expect(mapV1TypeToKind("decision")).toBe("semantic");
    expect(mapV1TypeToKind("task_summary")).toBe("episodic");
    expect(mapV1TypeToKind("skill")).toBe("episodic");
    expect(mapV1TypeToKind("failure")).toBe("episodic");
  });

  test("v2 kind 原样透传；未知类型 → null", () => {
    expect(mapV1TypeToKind("semantic")).toBe("semantic");
    expect(mapV1TypeToKind("episodic")).toBe("episodic");
    expect(mapV1TypeToKind("whatever")).toBeNull();
  });
});

describe("pure: v1 行 → v2 条目构造", () => {
  test("user_preference → semantic（fact=summary + keywords）", () => {
    const entry = buildV2EntryFromV1Row(
      v1Row("user_preference", { summary: "Always use vitest for testing" }),
    );
    expect(entry).not.toBeNull();
    if (entry && entry.kind === "semantic") {
      expect(entry.fact).toContain("vitest");
      expect(entry.keywords.length).toBeGreaterThan(0);
      expect(entry.tValid).toBeDefined();
      expect(entry.source).toBe("agent_verified");
    }
  });

  test("failure → episodic（whenToUse 含工具名，issueType=toolName）", () => {
    const entry = buildV2EntryFromV1Row(
      v1Row("failure", {
        title: "Failure: workspace.run_shell",
        summary: "bun test exited 1: ModuleResolutionError",
        payload: { toolName: "workspace.run_shell" },
      }),
    );
    expect(entry).not.toBeNull();
    if (entry && entry.kind === "episodic") {
      expect(entry.whenToUse).toContain("workspace.run_shell");
      expect(entry.whenToUse).toContain("When");
      expect(entry.issueType).toBe("workspace.run_shell");
      expect(entry.perspective).toContain("ModuleResolutionError");
    }
  });

  test("task_summary → episodic（whenToUse 用 title 构造）", () => {
    const entry = buildV2EntryFromV1Row(v1Row("task_summary", { title: "Add redis caching" }));
    expect(entry).not.toBeNull();
    if (entry && entry.kind === "episodic") {
      expect(entry.whenToUse).toContain("Add redis caching");
    }
  });

  test("空内容 → null（跳过）；未知类型 → null", () => {
    expect(buildV2EntryFromV1Row(v1Row("decision", { title: "", summary: " " }))).toBeNull();
    expect(buildV2EntryFromV1Row(v1Row("unknown-type"))).toBeNull();
  });

  test("extractMigratedKeywords 切词去重", () => {
    const kws = extractMigratedKeywords("Use vitest for testing", "vitest is fast");
    expect(kws).toContain("vitest");
    expect(kws).toContain("testing");
    expect(new Set(kws).size).toBe(kws.length);
    expect(kws.length).toBeLessThanOrEqual(6);
  });
});

describe("DB: 迁移闭环", () => {
  const engine = new PostgresMemoryStoreEngine();

  test("dry-run 预览不写库", async () => {
    const sql = getSql();
    const seeds: { type: string; summary?: string }[] = [
      { type: "user_preference", summary: "Always use vitest for testing" },
      { type: "task_summary" },
      { type: "failure" },
      { type: "decision" },
    ];
    for (const seed of seeds) {
      const row = v1Row(seed.type, { summary: seed.summary, payload: { repositoryId: REPO } });
      // jsonb 列必须用 sql.json()（字符串 + ::jsonb 会被 postgres.js 双重编码成 JSON 字符串）
      await sql.unsafe(
        "INSERT INTO memory_items (id, schema_version, type, subject_key, title, summary, status, scope, confidence, verification_status, payload, version, created_at, updated_at, t_valid) VALUES ($1, 1, $2, $3, $4, $5, 'active', $6, $7, 'unverified', $8, 1, now(), now(), now())",
        [row.id, row.type, `legacy:${row.type}`, row.title, row.summary, sql.json({ repositoryId: REPO }), row.confidence, sql.json(JSON.parse(row.payload))],
      );
      migratedIds.push(row.id);
    }

    const result = await migrateV1ToV2({ repo: REPO, dryRun: true });
    expect(result.scanned).toBe(4);
    expect(result.migrated).toBe(4);
    expect(result.dryRun).toBe(true);

    // 未写库：type 仍是 v1
    const rows = (await sql.unsafe(
      "SELECT type FROM memory_items WHERE scope->>'repositoryId' = $1",
      [REPO],
    )) as unknown as { type: string }[];
    expect(rows.every((r) => !["semantic", "episodic"].includes(r.type))).toBe(true);
  });

  test("正式迁移：kind 改写 + embedding + 幂等", async () => {
    const result = await migrateV1ToV2({ repo: REPO });
    expect(result.scanned).toBe(4);
    expect(result.migrated).toBe(4);
    expect(result.failed).toBe(0);
    expect(result.byType.user_preference).toBe(1);

    const sql = getSql();
    const rows = (await sql.unsafe(
      "SELECT id, type, t_valid FROM memory_items WHERE scope->>'repositoryId' = $1",
      [REPO],
    )) as unknown as { id: string; type: string; t_valid: unknown }[];
    expect(rows.length).toBe(4);

    const byType = new Map(rows.map((r) => [r.id, r.type]));
    for (const id of migratedIds) {
      const t = byType.get(id);
      expect(t).toBeDefined();
      expect(["semantic", "episodic"]).toContain(t!);
    }
    // t_valid 已回填
    expect(rows.every((r) => r.t_valid != null)).toBe(true);

    // embedding 已重算
    const emb = (await sql.unsafe(
      "SELECT count(*)::int AS n FROM memory_embeddings WHERE memory_id = ANY($1::text[])",
      [migratedIds],
    )) as unknown as { n: number }[];
    expect(emb[0]!.n).toBe(4);

    // v2 引擎可读 + 可检索
    const entries = await engine.query({ repo: REPO, limit: 10 });
    expect(entries.length).toBe(4);
    expect(entries.every((e) => ["semantic", "episodic"].includes(e.kind))).toBe(true);

    const hits = await engine.searchText("vitest testing", 10);
    expect(hits.length).toBeGreaterThan(0);

    // 幂等：二次迁移全部跳过
    const again = await migrateV1ToV2({ repo: REPO });
    expect(again.scanned).toBe(0);
    expect(again.migrated).toBe(0);
  });
});
