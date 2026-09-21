/**
 * working memory 的 jsonb 列必须是 **jsonb 对象**，不是被双重编码的 jsonb 字符串。
 * ==============================================================================
 *
 * 背景（docs/CODE-REVIEW.md §M7、§11.29）：`workingMemoryDao` 原先用位置参数把
 * `JSON.stringify(wm)` 传给 jsonb 列，postgres.js 认出目标是 jsonb 后又编码一次，
 * 落库成 `jsonb_typeof = 'string'`，内容是 `"{\"id\":…}"` 这样的一层引号字符串。
 *
 * 读路径靠 `parseJson`（字符串与对象都吃）把值再 parse 一次，所以这个 DAO 自己
 * 读写一直是通的 —— 缺陷是**潜伏**的：任何 `state->>'field'`、GIN 索引或外部工具
 * 看到的都是字符串，取字段得到 NULL。
 *
 * 实测对照：
 *   修前  jsonb_typeof(state)=string   state->>'goal'=NULL
 *   修后  jsonb_typeof(state)=object   state->>'goal'=<真实值>
 *
 * 运行：`DATABASE_URL="postgresql://…/paw_memory_test" bun test test/working-memory-jsonb.test.ts`
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { getSql } from "../src/db/connection.js";
import { workingMemoryDao } from "../src/db/dao/workingMemory.js";

process.env.DATABASE_URL ??= "postgresql://postgres@127.0.0.1:54329/paw_memory_test";

const RUN = `wmjsonb-${Date.now()}`;
const sql = getSql();

/** `working_memories.task_id` 有外键指向 `task_sessions`，所以每个用例先建任务。 */
async function withTask<T>(suffix: string, run: (taskId: string) => Promise<T>): Promise<T> {
  const taskId = `${RUN}-${suffix}`;
  await sql`INSERT INTO task_sessions (id, root_task_id, initial_user_request, status)
            VALUES (${taskId}, ${taskId}, 'probe', 'pending')`;
  return run(taskId);
}

function workingMemory(id: string, taskId: string, goal: string) {
  const now = new Date().toISOString();
  return {
    id,
    taskId,
    revision: 1,
    goal,
    constraints: [],
    plan: [],
    todos: [],
    completedSteps: [],
    readFiles: ["a.ts"],
    modifiedFiles: [],
    executedTools: [],
    diffSummary: "",
    testRunIds: [],
    currentTestSummary: null,
    activeHypotheses: [],
    rejectedHypotheses: [],
    openQuestions: [],
    nextAction: null,
    contextPointers: [],
    createdAt: now,
    updatedAt: now,
  };
}

beforeAll(async () => {
  await sql`DELETE FROM task_sessions WHERE id LIKE ${`${RUN}%`}`;
});

afterAll(async () => {
  await sql`DELETE FROM working_memory_snapshots WHERE task_id LIKE ${`${RUN}%`}`;
  await sql`DELETE FROM working_memories WHERE task_id LIKE ${`${RUN}%`}`;
  await sql`DELETE FROM task_sessions WHERE id LIKE ${`${RUN}%`}`;
});

describe("working memory jsonb columns", () => {
  test("create stores state as a jsonb object readable at SQL level", async () => {
    await withTask("create", async (taskId) => {
      const id = `${taskId}-wm`;
      const created = await workingMemoryDao.create(
        workingMemory(id, taskId, "probe-goal") as never,
      );
      // 应用层读回照旧（`readFiles` 是 FileActivity[]，不是 string[]）
      expect(created.goal).toBe("probe-goal");

      const [row] = await sql`SELECT jsonb_typeof(state) AS t, state->>'goal' AS g
                              FROM working_memories WHERE id = ${id}`;
      expect((row as { t: string }).t).toBe("object");
      expect((row as { g: string | null }).g).toBe("probe-goal");
    });
  });

  test("update keeps state a jsonb object", async () => {
    await withTask("update", async (taskId) => {
      const id = `${taskId}-wm`;
      const base = workingMemory(id, taskId, "before");
      await workingMemoryDao.create(base as never);
      await workingMemoryDao.update(id, 1, { ...base, goal: "after", revision: 2 } as never);

      const [row] = await sql`SELECT jsonb_typeof(state) AS t, state->>'goal' AS g
                              FROM working_memories WHERE id = ${id}`;
      expect((row as { t: string }).t).toBe("object");
      expect((row as { g: string | null }).g).toBe("after");
    });
  });

  test("createSnapshot stores snapshot and created_by as jsonb objects", async () => {
    await withTask("snapshot", async (taskId) => {
      const id = `${taskId}-wm`;
      await workingMemoryDao.create(workingMemory(id, taskId, "goal") as never);
      await workingMemoryDao.createSnapshot({
        id: `${id}-snap`,
        taskId,
        workingMemoryId: id,
        workingMemoryRevision: 1,
        reason: "probe",
        snapshot: { goal: "snap-goal" },
        createdBy: { actorType: "system", actorId: "probe" },
        createdAt: new Date().toISOString(),
      } as never);

      const [row] = await sql`SELECT jsonb_typeof(snapshot) AS a, snapshot->>'goal' AS b,
                                     jsonb_typeof(created_by) AS c, created_by->>'actorId' AS d
                              FROM working_memory_snapshots WHERE working_memory_id = ${id}`;
      expect((row as { a: string }).a).toBe("object");
      expect((row as { b: string | null }).b).toBe("snap-goal");
      expect((row as { c: string }).c).toBe("object");
      expect((row as { d: string | null }).d).toBe("probe");
    });
  });
});
