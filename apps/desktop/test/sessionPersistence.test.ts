import { describe, expect, test } from "bun:test";
import type { ConversationTurn } from "../src/agent/conversationHistory";
import { type ChatSession, createEmptySession } from "../src/agent/sessionTypes";
import type { UiMessage } from "../src/agent/types";
import { persistActiveSession, syncActiveSessionMessages } from "../src/agent/useAgentRun";

/**
 * 会话落盘的两个纯 reducer。
 *
 * 它们原先内联在 `setSessions((prev) => …)` 的 updater 里，而 `main.tsx` 开着
 * `<StrictMode>` —— React 在开发模式下会故意重复调用 updater 来暴露不纯。
 * 抽成纯函数后可以在这里直接断言「同一输入 → 同一输出」，也可以断言
 * `updatedAt` 由调用方传入而不是在求值过程中读时钟。
 */

const NOW = 1_700_000_000_000;

function session(id: string, overrides: Partial<ChatSession> = {}): ChatSession {
  return { ...createEmptySession(), id, title: `标题-${id}`, ...overrides };
}

function msg(id: string, content: string, streaming = false): UiMessage {
  return { id, role: "assistant", content, streaming };
}

function turn(text: string): ConversationTurn {
  return { role: "assistant", content: text };
}

describe("persistActiveSession", () => {
  test("把消息与历史写进目标会话，并 touch updatedAt", () => {
    const before = [session("a", { updatedAt: 1 })];
    const messages = [msg("m1", "你好")];
    const history = [turn("你好")];

    const next = persistActiveSession(before, "a", messages, history, NOW);

    expect(next).toHaveLength(1);
    expect(next[0]!.messages).toEqual([
      { id: "m1", role: "assistant", content: "你好", streaming: false },
    ]);
    expect(next[0]!.history).toEqual(history);
    expect(next[0]!.updatedAt).toBe(NOW);
  });

  test("内容没变就不 touch updatedAt", () => {
    const messages = [msg("m1", "你好")];
    const before = [
      session("a", {
        updatedAt: 42,
        title: "标题-a",
        messages: messages.map((m) => ({ ...m, streaming: false })),
      }),
    ];

    const next = persistActiveSession(before, "a", messages, [], NOW);

    expect(next[0]!.updatedAt).toBe(42);
  });

  test("会话不在列表里时补一条并置顶", () => {
    const before = [session("a"), session("b")];
    const next = persistActiveSession(before, "new", [msg("m1", "x")], [], NOW);

    expect(next.map((s) => s.id)).toEqual(["new", "a", "b"]);
    expect(next[0]!.updatedAt).toBe(NOW);
  });

  test("有变化的会话被置顶，其余顺序不变", () => {
    const before = [session("a"), session("b", { updatedAt: 7 })];
    const next = persistActiveSession(before, "b", [msg("m1", "x")], [], NOW);

    expect(next.map((s) => s.id)).toEqual(["b", "a"]);
    expect(next[1]!.id).toBe("a");
  });

  test("同一输入重复求值得到同一结果（StrictMode 安全性）", () => {
    const before = [session("a"), session("b", { updatedAt: 7 })];
    const messages = [msg("m1", "x")];

    const first = persistActiveSession(before, "b", messages, [], NOW);
    const second = persistActiveSession(before, "b", messages, [], NOW);

    expect(second).toEqual(first);
    // 输入不被修改
    expect(before.map((s) => s.id)).toEqual(["a", "b"]);
    expect(before[1]!.updatedAt).toBe(7);
  });

  test("流式标记在落盘时被清掉", () => {
    const next = persistActiveSession([session("a")], "a", [msg("m1", "x", true)], [], NOW);
    expect(next[0]!.messages[0]!.streaming).toBe(false);
  });
});

describe("syncActiveSessionMessages", () => {
  test("同步消息与历史，保留原始 streaming 标记", () => {
    const next = syncActiveSessionMessages(
      [session("a")],
      "a",
      [msg("m1", "x", true)],
      [turn("x")],
      NOW,
    );

    expect(next[0]!.messages[0]!.streaming).toBe(true);
    expect(next[0]!.history).toEqual([turn("x")]);
    expect(next[0]!.updatedAt).toBe(NOW);
  });

  test("不新建会话（id 必然已存在）", () => {
    const before = [session("a")];
    const next = syncActiveSessionMessages(before, "missing", [], [], NOW);
    expect(next.map((s) => s.id)).toEqual(["a"]);
  });

  test("无变化时不 touch updatedAt，也不重排", () => {
    const messages = [msg("m1", "x")];
    const before = [
      session("a"),
      session("b", { updatedAt: 5, messages: [...messages], history: [] }),
    ];

    const next = syncActiveSessionMessages(before, "b", messages, [], NOW);

    expect(next.map((s) => s.id)).toEqual(["a", "b"]);
    expect(next[1]!.updatedAt).toBe(5);
  });

  test("有变化时置顶", () => {
    const before = [session("a"), session("b", { updatedAt: 5 })];
    const next = syncActiveSessionMessages(before, "b", [msg("m1", "新的")], [], NOW);

    expect(next.map((s) => s.id)).toEqual(["b", "a"]);
    expect(next[0]!.updatedAt).toBe(NOW);
  });

  test("标题随首条消息更新", () => {
    const next = syncActiveSessionMessages(
      [session("a", { title: "新对话" })],
      "a",
      [{ id: "u1", role: "user", content: "帮我重构登录模块" }],
      [],
      NOW,
    );

    expect(next[0]!.title).not.toBe("新对话");
    expect(next[0]!.title).toContain("登录");
  });

  test("同一输入重复求值得到同一结果", () => {
    const before = [session("a"), session("b", { updatedAt: 5 })];
    const messages = [msg("m1", "x")];

    expect(syncActiveSessionMessages(before, "b", messages, [], NOW)).toEqual(
      syncActiveSessionMessages(before, "b", messages, [], NOW),
    );
  });
});
