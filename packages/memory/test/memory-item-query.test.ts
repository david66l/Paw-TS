/**
 * memoryItemDao.query 过滤器覆盖测试。
 *
 * 回归点：旧实现按几种手写的过滤器组合分支，没命中的组合会静默丢弃过滤器 ——
 * `tags` 从未下推到 SQL，`scopeUserId` 在没有 type 时被忽略，
 * 于是调用方拿到的结果集比它要求的更宽（跨用户即等于泄漏）。
 *
 * 需要 PostgreSQL，ping 失败时 skip 而非 fail：
 *   DATABASE_URL="postgresql://paw:paw@127.0.0.1:54329/paw_memory_test" bun test test/memory-item-query.test.ts
 */

import { afterAll, describe, expect, test } from "bun:test";
import { closeSql, getSql, ping } from "../src/db/connection.js";
import { memoryItemDao } from "../src/db/dao/memoryItem.js";
import type { MemoryItem } from "../src/db/types.js";

process.env.DATABASE_URL ??= "postgresql://postgres@127.0.0.1:54329/paw_memory_test";

const dbOk = await ping();
const it = dbOk ? test : test.skip;

/** Namespaced so the shared test database keeps unrelated rows untouched. */
const PREFIX = `mitemquery-${Date.now()}-`;
const REPO = `${PREFIX}repo`;
const OTHER_REPO = `${PREFIX}other-repo`;
const USER = `${PREFIX}user-a`;
const OTHER_USER = `${PREFIX}user-b`;

type SeedType = MemoryItem["type"];

/**
 * `MemoryItem` is a discriminated union over `payload`, but this test only
 * exercises the column filters, so the payload is deliberately empty.
 */
function seed(input: {
  readonly id: string;
  readonly type: SeedType;
  readonly repositoryId: string;
  readonly userId: string;
  readonly tags: string[];
}): MemoryItem {
  const now = new Date().toISOString();
  return {
    id: `${PREFIX}${input.id}`,
    schemaVersion: 1,
    type: input.type,
    subjectKey: `${PREFIX}${input.id}`,
    subjectKeyVersion: 1,
    title: input.id,
    summary: "",
    status: "active",
    scope: { repositoryId: input.repositoryId, userId: input.userId },
    confidence: 0.5,
    verificationStatus: "unverified",
    payload: {},
    tags: input.tags,
    relatedFiles: [],
    relatedSymbols: [],
    relatedTestRunIds: [],
    sensitivity: "internal",
    version: 1,
    createdBy: { actorType: "system", actorId: "memory-item-query-test" },
    updatedBy: { actorType: "system", actorId: "memory-item-query-test" },
    createdAt: now,
    updatedAt: now,
  } as unknown as MemoryItem;
}

/** A rule owned by USER in REPO. */
const RULE = seed({ id: "rule", type: "rule", repositoryId: REPO, userId: USER, tags: ["alpha"] });
/** A decision owned by USER in REPO, different type and tag. */
const DECISION = seed({
  id: "decision",
  type: "decision",
  repositoryId: REPO,
  userId: USER,
  tags: ["beta"],
});
/** Same repo, different user: must never leak into USER's results. */
const OTHER_USER_RULE = seed({
  id: "other-user-rule",
  type: "rule",
  repositoryId: REPO,
  userId: OTHER_USER,
  tags: ["alpha"],
});
/** Same user, different repo. */
const OTHER_REPO_RULE = seed({
  id: "other-repo-rule",
  type: "rule",
  repositoryId: OTHER_REPO,
  userId: USER,
  tags: ["alpha"],
});

const SEEDS = [RULE, DECISION, OTHER_USER_RULE, OTHER_REPO_RULE];

const ids = (items: MemoryItem[]): string[] => items.map((item) => item.id).sort();

/** `updated_at DESC` ties inside one millisecond, so compare as sets. */
const shortIds = (items: MemoryItem[]): string[] =>
  items.map((item) => item.id.replace(PREFIX, "")).sort();

if (dbOk) {
  for (const item of SEEDS) await memoryItemDao.create(item);
}

afterAll(async () => {
  if (dbOk) {
    const sql = getSql();
    const created = SEEDS.map((item) => item.id);
    await sql`DELETE FROM memory_versions WHERE memory_id = ANY(${sql.array(created)})`;
    await sql`DELETE FROM memory_items WHERE id = ANY(${sql.array(created)})`;
    await closeSql();
  }
});

describe("memoryItemDao.query filter coverage", () => {
  it("applies scopeUserId even when no type is requested", async () => {
    const items = await memoryItemDao.query({ scopeRepoId: REPO, scopeUserId: USER });
    // The old branch for "repo but no type" dropped the user filter and would
    // also have returned OTHER_USER_RULE.
    expect(shortIds(items)).toEqual(["decision", "rule"]);
  });

  it("applies a multi-type filter instead of truncating to the first type", async () => {
    const items = await memoryItemDao.query({
      types: ["decision", "rule"],
      scopeRepoId: REPO,
      scopeUserId: USER,
    });
    expect(shortIds(items)).toEqual(["decision", "rule"]);
  });

  it("applies the tags filter, which previously never reached SQL", async () => {
    const alpha = await memoryItemDao.query({
      tags: ["alpha"],
      scopeRepoId: REPO,
      scopeUserId: USER,
    });
    expect(shortIds(alpha)).toEqual(["rule"]);

    const beta = await memoryItemDao.query({
      tags: ["beta"],
      scopeRepoId: REPO,
      scopeUserId: USER,
    });
    expect(shortIds(beta)).toEqual(["decision"]);

    const both = await memoryItemDao.query({
      tags: ["alpha", "beta"],
      scopeRepoId: REPO,
      scopeUserId: USER,
    });
    // `&&` is overlap, so a union of both tags matches both items.
    expect(shortIds(both)).toEqual(["decision", "rule"]);
  });

  it("treats an empty tag list as no tag filter", async () => {
    const items = await memoryItemDao.query({
      tags: [],
      scopeRepoId: REPO,
      scopeUserId: USER,
    });
    expect(shortIds(items)).toEqual(["decision", "rule"]);
  });

  it("applies a repository filter without a user filter", async () => {
    const items = await memoryItemDao.query({ type: "rule", scopeRepoId: REPO });
    expect(shortIds(items)).toEqual(["other-user-rule", "rule"]);
  });

  it("applies a user filter without a repository filter", async () => {
    const items = await memoryItemDao.query({ type: "rule", scopeUserId: USER });
    expect(shortIds(items)).toEqual(["other-repo-rule", "rule"]);
  });

  it("combines every declared filter", async () => {
    const items = await memoryItemDao.query({
      type: "rule",
      tags: ["alpha"],
      scopeRepoId: REPO,
      scopeUserId: USER,
    });
    expect(shortIds(items)).toEqual(["rule"]);
    expect(ids(items)).toEqual([RULE.id]);
  });

  it("honours limit and offset", async () => {
    const first = await memoryItemDao.query({ scopeRepoId: REPO, limit: 1 });
    expect(first).toHaveLength(1);
    const second = await memoryItemDao.query({ scopeRepoId: REPO, limit: 1, offset: 1 });
    expect(second).toHaveLength(1);
    expect(second[0]?.id).not.toBe(first[0]?.id);
  });

  it("returns nothing when a filter cannot match", async () => {
    const items = await memoryItemDao.query({
      tags: ["no-such-tag"],
      scopeRepoId: REPO,
      scopeUserId: USER,
    });
    expect(items).toEqual([]);
  });
});
