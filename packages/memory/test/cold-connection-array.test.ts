/**
 * 冷连接上的 `text[]` 参数。
 * ==========================
 *
 * 背景（docs/CODE-REVIEW.md §M7）：`db/connection.ts:49-55` 记录了 postgres.js 的
 * `sql.array()` 依赖连接建立后**异步**获取的数组类型映射，冷连接上第一个含数组
 * 参数的查询会拿到未初始化的序列化器；同一个注释给出了解法
 * `textArrayLiteral(...)::text[]` —— 但那个解法**此前零调用点**，而 9 处 DAO 查询
 * 仍在用 `sql.array`。
 *
 * 实测（新进程 + 新客户端 + 第一条查询）：
 *
 *   SELECT ${sql.array(["a","b"])}::text[]  ->  malformed array literal: "a,b"
 *   同一连接上的第二次调用                    ->  OK
 *   SELECT ${textArrayLiteral(["a","b"])}::text[]  ->  OK
 *
 * 也就是说 JS 数组被当成了字符串 `"a,b"` 发过去 —— **不是间歇性的**，而是每个
 * 新连接的第一条数组参数查询都会失败。测试里看不出来，是因为跑测试时连接早已
 * 被前面的查询预热。
 *
 * 运行：`DATABASE_URL="postgresql://…/paw_memory_test" bun test test/cold-connection-array.test.ts`
 */
import { describe, expect, test } from "bun:test";
import postgres from "postgres";

import { textArrayLiteral } from "../src/db/connection.js";

process.env.DATABASE_URL ??= "postgresql://postgres@127.0.0.1:54329/paw_memory_test";
const CONNECTION = process.env.DATABASE_URL;

/** 每次都用**新建的客户端**，确保是冷连接。 */
async function coldQuery<T>(run: (sql: ReturnType<typeof postgres>) => Promise<T>): Promise<T> {
  const sql = postgres(CONNECTION, { max: 4, connect_timeout: 10 });
  try {
    return await run(sql);
  } finally {
    await sql.end();
  }
}

describe("textArrayLiteral", () => {
  test("renders a text[] literal", () => {
    expect(textArrayLiteral(["a", "b"])).toBe('{"a","b"}');
  });

  test("an empty array renders as {}", () => {
    expect(textArrayLiteral([])).toBe("{}");
  });

  test("escapes backslashes before quotes", () => {
    // 先转义反斜杠再转义引号，否则 `\"` 会被二次转义
    expect(textArrayLiteral(['a"b'])).toBe('{"a\\"b"}');
    expect(textArrayLiteral(["a\\b"])).toBe('{"a\\\\b"}');
  });
});

describe("a fresh connection can pass text[] parameters from its first query", () => {
  test("the helper's literal works cold, including hostile characters", async () => {
    const values = ['quote"here', "back\\slash", "comma,inside", "brace{}", "", "unicode 中文"];
    const rows = await coldQuery((sql) => sql`SELECT ${textArrayLiteral(values)}::text[] AS xs`);
    expect((rows[0] as { xs: string[] }).xs).toEqual(values);
  });

  test("an empty array works cold", async () => {
    const rows = await coldQuery((sql) => sql`SELECT ${textArrayLiteral([])}::text[] AS xs`);
    expect((rows[0] as { xs: string[] }).xs).toEqual([]);
  });

  /**
   * 这条钉的是**这个辅助函数存在的理由**。它断言的是 postgres.js 的行为，不是
   * 我们自己的代码 —— 若将来升级驱动修掉了这个缺陷，这里会红，那时就可以去掉
   * `textArrayLiteral` 的强制用法并回到 `sql.array`。在那之前，这条测试防止有人
   * "顺手统一成 sql.array" 而把冷连接 bug 放回去。
   */
  test("sql.array on the same cold connection is the hazard the helper avoids", async () => {
    await expect(
      coldQuery((sql) => sql`SELECT ${sql.array(["a", "b"])}::text[] AS xs`),
    ).rejects.toThrow(/malformed array literal/);
  });

  test("but sql.array succeeds once the connection is warm", async () => {
    const values = await coldQuery(async (sql) => {
      await sql`SELECT 1 AS warm`;
      const rows = await sql`SELECT ${sql.array(["a", "b"])}::text[] AS xs`;
      return (rows[0] as { xs: string[] }).xs;
    });
    expect(values).toEqual(["a", "b"]);
  });
});
