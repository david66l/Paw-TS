import { describe, expect, test } from "bun:test";

import {
  formatTodosForPrompt,
  InMemoryTodoStore,
} from "../src/todo.js";

describe("InMemoryTodoStore", () => {
  test("starts empty", () => {
    const store = new InMemoryTodoStore();
    expect(store.items).toEqual([]);
  });

  test("adds items", () => {
    const store = new InMemoryTodoStore();
    store.add({ id: "1", content: "task a", status: "pending" });
    expect(store.items.length).toBe(1);
    expect(store.items[0]!.content).toBe("task a");
  });

  test("updates existing by id", () => {
    const store = new InMemoryTodoStore();
    store.add({ id: "1", content: "task a", status: "pending" });
    store.add({ id: "1", content: "task a updated", status: "done" });
    expect(store.items.length).toBe(1);
    expect(store.items[0]!.status).toBe("done");
    expect(store.items[0]!.content).toBe("task a updated");
  });

  test("update patches partial fields", () => {
    const store = new InMemoryTodoStore();
    store.add({ id: "1", content: "task a", status: "pending", priority: "high" });
    const ok = store.update("1", { status: "in_progress" });
    expect(ok).toBe(true);
    expect(store.items[0]!.status).toBe("in_progress");
    expect(store.items[0]!.content).toBe("task a");
    expect(store.items[0]!.priority).toBe("high");
  });

  test("update returns false for missing id", () => {
    const store = new InMemoryTodoStore();
    const ok = store.update("x", { status: "done" });
    expect(ok).toBe(false);
  });

  test("remove deletes item", () => {
    const store = new InMemoryTodoStore();
    store.add({ id: "1", content: "task a", status: "pending" });
    const ok = store.remove("1");
    expect(ok).toBe(true);
    expect(store.items).toEqual([]);
  });

  test("remove returns false for missing id", () => {
    const store = new InMemoryTodoStore();
    const ok = store.remove("x");
    expect(ok).toBe(false);
  });

  test("clear removes all", () => {
    const store = new InMemoryTodoStore();
    store.add({ id: "1", content: "a", status: "pending" });
    store.add({ id: "2", content: "b", status: "pending" });
    store.clear();
    expect(store.items).toEqual([]);
  });

  test("set replaces all", () => {
    const store = new InMemoryTodoStore();
    store.add({ id: "1", content: "a", status: "pending" });
    store.set([
      { id: "3", content: "c", status: "done" },
    ]);
    expect(store.items.length).toBe(1);
    expect(store.items[0]!.id).toBe("3");
  });
});

describe("formatTodosForPrompt", () => {
  test("empty list", () => {
    expect(formatTodosForPrompt([])).toBe("Current tasks: none");
  });

  test("formats items", () => {
    const items = [
      { id: "1", content: "fix bug", status: "in_progress" as const, priority: "high" as const },
      { id: "2", content: "write tests", status: "pending" as const },
    ];
    const text = formatTodosForPrompt(items);
    expect(text).toContain("Current tasks:");
    expect(text).toContain("[in_progress] 1: fix bug [high]");
    expect(text).toContain("[pending] 2: write tests");
  });
});
