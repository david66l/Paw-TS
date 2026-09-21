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

  test("apply_patch 的 relPath 也要显示出来", () => {
    // apply_patch 的参数用 relPath（处理器在 packages/workspace，不在 harness 的
    // handlers 目录里）。它一度被误判为死键，于是审批卡上这类调用同样是空摘要。
    expect(summarizeToolArgs("workspace.apply_patch", { relPath: "src/x.ts", patch: "..." })).toBe(
      "src/x.ts",
    );
    // path 仍然优先于 relPath，顺序与渲染侧保持一致
    expect(summarizeToolArgs("workspace.edit_file", { path: "a.ts", relPath: "b.ts" })).toBe(
      "a.ts",
    );
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
