/**
 * 驱动边界的行类型（row types）。
 * ==================================
 *
 * 背景（docs/CODE-REVIEW.md §M1）：`packages/memory/src/db` 里的 DAO 原先手写
 * snake_case → camelCase 映射，每读一个字段就补一次 `as`，最后再以
 * `as unknown as MemoryItem` 收尾（`dao/memoryItem.ts` 一处就有 22 个字段断言
 * 加一次双重断言）。双重断言意味着**列改名只会得到运行期 `undefined`，
 * 而不是编译错误**。
 *
 * 做法：每张表一个 `XRow`，描述**驱动实际返回的 JS 值**（不是 SQL 列类型 ——
 * 两者在时间列上并不一致，见下），于是：
 * - 标量列（text / integer / real / text[]）在映射里**零断言**；
 * - 只有 jsonb 列需要断言，因为 `parseJson` 的返回类型是 `unknown`；
 * - 断言集中在驱动边界一次：`sql.unsafe<MemoryItemRow>(...)`。
 *
 * **时间列的坑（已实测）**：`timestamptz` 经 postgres.js 默认解析后是
 * **`Date` 对象**，不是字符串。原先的 `row.created_at as string` 是一句谎话 ——
 * `MemoryItem.createdAt` 声明为 `string`，运行期却是 `Date`。所以这里的
 * `created_at: Date` 写的是事实，转换（`.toISOString()`）放在映射里显式做。
 */

/**
 * `memory_items` 的一行。所有列都是 `NOT NULL`（`V003__memory_items.sql`）。
 *
 * 写成 **type alias 而不是 interface** 是有意的：TS 只给对象字面量的 type alias
 * 隐式索引签名，interface 不会。`snapshotFromRow` 需要把整行当作
 * `Record<string, unknown>` 按列名遍历，用 interface 就得再加一次断言 ——
 * 那正是这个模块要消掉的东西。
 */
export type MemoryItemRow = {
  readonly id: string;
  readonly schema_version: number;
  /** 原始列值；`MemoryType` 的窄化在 DAO 里显式做。 */
  readonly type: string;
  readonly subject_key: string;
  readonly subject_key_version: number;
  readonly title: string;
  readonly summary: string;
  /** 原始列值；`MemoryStatus` 的窄化在 DAO 里显式做。 */
  readonly status: string;
  /** jsonb：驱动已解析为对象，但 `parseJson` 仍兼容字符串形态，故为 `unknown`。 */
  readonly scope: unknown;
  readonly confidence: number;
  readonly verification_status: string;
  readonly payload: unknown;
  readonly tags: string[];
  readonly related_files: string[];
  readonly related_symbols: string[];
  readonly related_test_run_ids: string[];
  readonly sensitivity: string;
  readonly version: number;
  readonly created_by: unknown;
  readonly updated_by: unknown;
  /** timestamptz → `Date`（postgres.js 默认解析器），**不是**字符串。 */
  readonly created_at: Date;
  readonly updated_at: Date;
};

/**
 * `memory_candidates` 的一行（`V004__memory_candidates.sql`）。
 *
 * 与 `memory_items` 不同，这张表有**两个可空列**：`proposed_subject_key` 与
 * `expires_at`。可空写成 `| null` —— 驱动给的是 `null`，不是 `undefined`。
 * 原先的映射写 `row.proposed_subject_key as string | undefined`，于是运行期
 * 漏出的是 `null` 而类型声称 `string | undefined`；映射里用 `?? undefined`
 * 把类型兑现（与 `createdAt` 那处同一类修正）。
 */
export type MemoryCandidateRow = {
  readonly id: string;
  readonly schema_version: number;
  readonly status: string;
  readonly proposed_type: string;
  /** 可空列：驱动返回 `null`。 */
  readonly proposed_subject_key: string | null;
  readonly subject_key_version: number;
  readonly proposed_title: string;
  readonly proposed_summary: string;
  readonly proposed_payload: unknown;
  readonly proposed_scope: unknown;
  readonly proposed_confidence: number;
  readonly source_task_ids: string[];
  readonly source_refs: unknown;
  readonly evidence_refs: unknown;
  readonly possible_duplicate_ids: string[];
  readonly possible_conflict_ids: string[];
  readonly risk_level: string;
  readonly review_required: boolean;
  readonly generated_by: unknown;
  readonly generation_reason: string;
  readonly sensitivity: string;
  readonly created_at: Date;
  readonly updated_at: Date;
  /** 可空列：驱动返回 `null`。 */
  readonly expires_at: Date | null;
};

// 注意：`governance_decisions` 的行类型**本轮没有加**，但理由不是"它有问题"。
//
// 我加了它、看到 `bun test packages/memory` 的失败从 5 升到 8（三个 `红队` 用例的
// Governor 结论由 `noop` 变 `degraded`，而 `degraded` 会经 `pipeline.ts:779
// storeDegraded` 真的写入一条降级条目），于是按"可能是安全相关的行为回归"回退了。
//
// **回退之后失败继续涨到 11，且那三个用例照样失败** —— 所以它们与这次改动无关。
// 真正的原因是**测试库跨轮次累积状态**：同一份代码连跑三次得到 5 / 8 / 11，
// 清库重建后回退版本只剩 **3** 个失败。也就是说之前那次"5 → 8"的对照**本身无效**
// （两次运行的库状态不同），我据此回退是**误判**。
//
// 结论：这个 DAO 的行类型值得做，但**必须在每次运行前清库**才有可信的对照。
// 详见 docs/CODE-REVIEW.md §11.26。
