import { describe, expect, test } from "bun:test";

import type { TaskProgressServiceV1 } from "../src/context.js";
import { executeTool } from "../src/registry/index.js";

/**
 * `workspace.progress_read` 是 §D9 里"无测试的工具 id"之一。实测 36 个工具 id 里
 * 只有两个从未在测试中出现（另一个是 `workspace.create_agent`）。它有三条出口：
 * 没配 service、service 报错、成功——成功那条还分"有任务清单"和"没有任务清单"。
 *
 * `TaskProgressServiceV1` 是 `{ write, read }`，而 progress_read 只走 `read`，
 * 所以这里用一个 helper 一次性收拢桩代码；`write` 保留成会抛错的哨兵，万一它被
 * 调用就会立刻暴露。断言只看**可观测**的 summary 与 payload 文本，不去钉
 * `TaskProgressSnapshotV1` 的完整形状（那条契约属于 write 侧）。
 */
function serviceReturning(outcome: unknown): TaskProgressServiceV1 {
  return {
    write: async () => {
      throw new Error("progress_read must never write");
    },
    read: async () => outcome,
  } as TaskProgressServiceV1;
}

describe("progress_read tool", () => {
  test("errors when the task progress service is not configured", async () => {
    const r = await executeTool({ workspaceRoot: "/tmp" }, "workspace.progress_read", {});
    expect(r.ok).toBe(false);
    // payload 由 makeToolError 组装；这里只确认 code 确实进到了 payload 里，
    // 具体嵌套层级不是这条用例要钉的契约。
    expect(JSON.stringify(r.payload)).toContain("E_FATAL");
    expect(r.summary).toContain("not configured");
  });

  test("maps a failed read to an E_USER error carrying the reason", async () => {
    const r = await executeTool(
      {
        workspaceRoot: "/tmp",
        taskProgress: serviceReturning({ ok: false, reason: "progress journal unreadable" }),
      },
      "workspace.progress_read",
      {},
    );
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("E_USER");
    expect(r.summary).toContain("progress journal unreadable");
    expect(JSON.stringify(r.payload)).toContain("E_USER");
  });

  test("summarises percent and background jobs when a task list exists", async () => {
    const r = await executeTool(
      {
        workspaceRoot: "/tmp",
        taskProgress: serviceReturning({
          ok: true,
          value: { snapshot: { percent: 40 }, activities: [{}, {}] },
        }),
      },
      "workspace.progress_read",
      {},
    );
    expect(r.ok).toBe(true);
    expect(r.summary).toContain("40% complete");
    expect(r.summary).toContain("2 background job(s)");
  });

  test("says so explicitly when there is no task list", async () => {
    const r = await executeTool(
      {
        workspaceRoot: "/tmp",
        taskProgress: serviceReturning({ ok: true, value: { activities: [] } }),
      },
      "workspace.progress_read",
      {},
    );
    expect(r.ok).toBe(true);
    expect(r.summary).toContain("no task list");
    expect(r.summary).toContain("0 background job(s)");
  });
});
