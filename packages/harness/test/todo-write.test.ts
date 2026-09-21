import { describe, expect, test } from "bun:test";

import type { TodoItem, TodoStore } from "@paw/core";

import type { TaskProgressServiceV1 } from "../src/context.js";
import { executeTool } from "../src/registry/index.js";

/**
 * `workspace.todo_write` 是 §D9 里"无测试的工具 id"之一。
 *
 * 它有两条后端路径（`taskProgress` 优先，其次 `todoStore`）和一层**输入净化**
 * （`handlers/task.ts:37-55`）：缺 `id` 或 `content` 的条目被丢弃、非法 `status`
 * 落回 `"pending"`、非法 `priority` 直接省略。净化规则是那种会静默漂移的东西 ——
 * 漂移了不会报错，只会让模型看到和它写的不一样的一份清单 —— 所以逐条钉住。
 *
 * 桩的风格沿用 `progress-read.test.ts`：用不会走到的那个方法做**哨兵**，
 * 一旦被调用就抛错，从而暴露"走错分支"。
 */

function captureStore(): { store: TodoStore; written: () => readonly TodoItem[] | undefined } {
  let captured: readonly TodoItem[] | undefined;
  const store = {
    set: (items: readonly TodoItem[]) => {
      captured = items;
    },
    get: () => {
      throw new Error("todo_write must never read the store");
    },
  } as unknown as TodoStore;
  return { store, written: () => captured };
}

function serviceWriting(outcome: unknown): TaskProgressServiceV1 {
  return {
    write: async () => outcome,
    read: async () => {
      throw new Error("todo_write must never read progress");
    },
  } as TaskProgressServiceV1;
}

const TODOS = [
  { id: "a", content: "first", status: "done" },
  { id: "b", content: "second", status: "in_progress", priority: "high" },
];

describe("workspace.todo_write", () => {
  test("without either backend it refuses rather than pretending", async () => {
    const r = await executeTool({ workspaceRoot: "/tmp" }, "workspace.todo_write", {
      todos: TODOS,
    });
    expect(r.ok).toBe(false);
    // 这条分支是裸 payload（无 error_code）—— 与文件类工具不同，见 §11.32
    expect((r.payload as Record<string, unknown>).error).toBe("todo store not configured");
    expect(r.summary).toBe("todo_write: todo store not configured");
  });

  test("writes the sanitised list to the store and counts it in the summary", async () => {
    const { store, written } = captureStore();
    const r = await executeTool(
      { workspaceRoot: "/tmp", todoStore: store },
      "workspace.todo_write",
      { todos: TODOS },
    );
    expect(r.ok).toBe(true);
    expect((r.payload as Record<string, unknown>).count).toBe(2);
    expect(r.summary).toBe("todo_write: 2 task(s)");
    expect(written()).toEqual([
      { id: "a", content: "first", status: "done" },
      { id: "b", content: "second", status: "in_progress", priority: "high" },
    ]);
  });

  test("sanitises entries: drops those missing id or content, defaults bad status, omits bad priority", async () => {
    const { store, written } = captureStore();
    const r = await executeTool(
      { workspaceRoot: "/tmp", todoStore: store },
      "workspace.todo_write",
      {
        todos: [
          { id: "ok", content: "keep me", status: "nonsense", priority: "urgent" },
          { id: "", content: "no id" },
          { id: "no-content", content: "" },
          { id: "typed", content: 42 },
          null,
          "not an object",
        ],
      },
    );
    expect(r.ok).toBe(true);
    // 只有 id 与 content 都是非空字符串的那条活下来；status 落回 pending；
    // priority 非法所以整个键被省略（不是 undefined 值 —— 断言的是键不存在）
    expect(written()).toEqual([{ id: "ok", content: "keep me", status: "pending" }]);
    expect(Object.hasOwn(written()![0]!, "priority")).toBe(false);
  });

  /**
   * "todos 不是数组"有两种形态，落点不同（与文件类工具同型）：
   * 键存在但类型不对由声明式 schema 拦下（`definitions.ts` 里 `todos` 是数组、
   * 且 `required: ["todos"]`），报 `E_SCHEMA_INVALID`；
   * 而处理器里那句 `Array.isArray(rec.todos) ? rec.todos : []`
   * 只在**键存在、值为 undefined** 时才可达（类型检查对 undefined 放行）。
   */
  test("a wrongly typed todos is refused by the schema, not the handler", async () => {
    const { store, written } = captureStore();
    const r = await executeTool(
      { workspaceRoot: "/tmp", todoStore: store },
      "workspace.todo_write",
      { todos: "not an array" },
    );
    expect(r.ok).toBe(false);
    expect((r.payload as Record<string, unknown>).error_code).toBe("E_SCHEMA_INVALID");
    expect((r.payload as Record<string, unknown>).field).toBe("todos");
    expect(written()).toBeUndefined();
  });

  test("an explicitly undefined todos reaches the handler as an empty list", async () => {
    const { store, written } = captureStore();
    const r = await executeTool(
      { workspaceRoot: "/tmp", todoStore: store },
      "workspace.todo_write",
      { todos: undefined },
    );
    expect(r.ok).toBe(true);
    expect(written()).toEqual([]);
    expect(r.summary).toBe("todo_write: 0 task(s)");
  });

  test("a failed progress write becomes an E_USER error carrying the reason", async () => {
    const { store, written } = captureStore();
    const r = await executeTool(
      {
        workspaceRoot: "/tmp",
        todoStore: store,
        taskProgress: serviceWriting({ ok: false, reason: "plan rejected" }),
      },
      "workspace.todo_write",
      { todos: TODOS },
    );
    expect(r.ok).toBe(false);
    expect((r.payload as Record<string, unknown>).error_code).toBe("E_USER");
    expect(r.summary).toContain("plan rejected");
    // 进度侧失败时**不能**顺手写进 store：两条后端不该都动
    expect(written()).toBeUndefined();
  });

  test("a successful progress write wins and reports completion percent", async () => {
    const { store, written } = captureStore();
    const r = await executeTool(
      {
        workspaceRoot: "/tmp",
        todoStore: store,
        taskProgress: serviceWriting({ ok: true, value: { percent: 50, items: [] } }),
      },
      "workspace.todo_write",
      { todos: TODOS },
    );
    expect(r.ok).toBe(true);
    expect(r.summary).toBe("todo_write: 2 task(s), 50% complete");
    expect((r.payload as Record<string, unknown>).percent).toBe(50);
    expect(written()).toBeUndefined();
  });
});
