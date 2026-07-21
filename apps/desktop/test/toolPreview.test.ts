import { describe, expect, test } from "bun:test";
import {
  alwaysAllowKey,
  previewToolArgs,
  summarizeToolArgs,
} from "../agent-host/tool-preview";

describe("summarizeToolArgs", () => {
  test("优先取 path / command 等定位字段", () => {
    expect(
      summarizeToolArgs("workspace.write_file", {
        path: "src/a.ts",
        content: "x",
      }),
    ).toBe("src/a.ts");
    expect(
      summarizeToolArgs("workspace.run_shell", { command: "bun test" }),
    ).toBe("bun test");
  });

  test("超长摘要截断；无定位字段返回空串", () => {
    const long = "x".repeat(500);
    const s = summarizeToolArgs("workspace.write_file", { path: long });
    expect(s.length).toBeLessThan(260);
    expect(s).toContain("截断");
    expect(summarizeToolArgs("workspace.read_file", { offset: 1 })).toBe("");
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
    expect(
      alwaysAllowKey("workspace.run_shell", { command: "rm -rf /tmp/x" }),
    ).not.toBe(alwaysAllowKey("workspace.run_shell", { command: "ls" }));
  });

  test("其它工具按工具名", () => {
    expect(alwaysAllowKey("workspace.write_file", { path: "a.ts" })).toBe(
      "workspace.write_file",
    );
    expect(alwaysAllowKey("workspace.write_file", null)).toBe(
      "workspace.write_file",
    );
  });
});
