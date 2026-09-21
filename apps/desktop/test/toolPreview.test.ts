import { describe, expect, test } from "bun:test";
import { alwaysAllowKey, previewToolArgs, summarizeToolArgs } from "../agent-host/tool-preview";

describe("summarizeToolArgs", () => {
  test("优先取 path / command 等定位字段", () => {
    expect(
      summarizeToolArgs("workspace.write_file", {
        path: "src/a.ts",
        content: "x",
      }),
    ).toBe("src/a.ts");
    expect(summarizeToolArgs("workspace.run_shell", { command: "bun test" })).toBe("bun test");
  });

  test("超长摘要截断；无定位字段返回空串", () => {
    const long = "x".repeat(500);
    const s = summarizeToolArgs("workspace.write_file", { path: long });
    expect(s.length).toBeLessThan(260);
    expect(s).toContain("截断");
    expect(summarizeToolArgs("workspace.read_file", { offset: 1 })).toBe("");
  });

  test("只带 pattern 的检索类调用也要显示搜索内容", () => {
    // glob / grep / search 的参数只有 pattern。此前它不在键列表里，审批卡拿到的
    // 是空摘要 —— 审批人看不到模型要搜什么。
    for (const tool of ["workspace.glob", "workspace.grep", "workspace.search"]) {
      expect(summarizeToolArgs(tool, { pattern: "src/**/*.ts" })).not.toBe("");
    }
    expect(summarizeToolArgs("workspace.grep", { pattern: "TODO", path: "src" })).toBe("src");
  });

  test("relPath 被接受只是为了与渲染侧键表对齐", () => {
    // 目前没有工具把 relPath 当参数发出：workspace.apply_patch 的参数是 patch，
    // 其中的 relPath 是 patch-tools.ts 解析 diff 后派生的字段。这条用例钉的是
    // 「两侧键表一致」这一防御性行为，不是某个真实调用形态。
    expect(summarizeToolArgs("workspace.apply_patch", { relPath: "src/x.ts" })).toBe("src/x.ts");
    // path 仍然优先于 relPath，顺序与渲染侧一致
    expect(summarizeToolArgs("workspace.edit_file", { path: "a.ts", relPath: "b.ts" })).toBe(
      "a.ts",
    );
    // 真实形态：apply_patch 只带 patch 文本，没有可提取的定位行
    expect(summarizeToolArgs("workspace.apply_patch", { patch: "--- a/x\n+++ b/x" })).toBe("");
  });
});

describe("previewToolArgs", () => {
  test("pretty JSON + 长字符串截断", () => {
    const out = previewToolArgs({
      path: "src/a.ts",
      content: "y".repeat(5000),
    });
    expect(out).toContain('"path": "src/a.ts"');
    expect(out).toContain("截断");
    expect(out.length).toBeLessThan(5000);
  });

  test("深度嵌套防爆；空值返回空串", () => {
    const deep = { a: { b: { c: { d: { e: 1 } } } } };
    const out = previewToolArgs(deep);
    expect(out).toContain("{…}");
    expect(previewToolArgs(undefined)).toBe("");
    expect(previewToolArgs(null)).toBe("");
  });
});

describe("alwaysAllowKey", () => {
  test("shell 类按整条命令去重", () => {
    expect(alwaysAllowKey("workspace.run_shell", { command: "bun test" })).toBe(
      "workspace.run_shell :: bun test",
    );
    expect(alwaysAllowKey("workspace.run_shell", { command: "rm -rf /tmp/x" })).not.toBe(
      alwaysAllowKey("workspace.run_shell", { command: "ls" }),
    );
  });

  test("其它工具按工具名", () => {
    expect(alwaysAllowKey("workspace.write_file", { path: "a.ts" })).toBe("workspace.write_file");
    expect(alwaysAllowKey("workspace.write_file", null)).toBe("workspace.write_file");
  });
});
