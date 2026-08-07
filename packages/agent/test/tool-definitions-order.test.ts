import { describe, expect, test } from "bun:test";

import { toolDefinitions } from "@paw/harness";

describe("P5.2 前缀稳定完整版：工具定义固定顺序", () => {
  test("内置工具按名称排序（确定性 schema 顺序，避免迭代抖动破坏缓存）", () => {
    const defs = toolDefinitions();
    const builtin = defs.filter((d) => !d.function.name.startsWith("mcp:"));
    const names = builtin.map((d) => d.function.name);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sorted);
    expect(new Set(names).size).toBe(names.length);
    // context.recall 在列（P3 工具没被排序搞丢）
    expect(names).toContain("context_recall");
  });

  test("两次调用顺序一致（确定性）", () => {
    const a = toolDefinitions().map((d) => d.function.name);
    const b = toolDefinitions().map((d) => d.function.name);
    expect(a).toEqual(b);
  });
});
