import { describe, expect, test } from "bun:test";
import {
  extractFilePatch,
  fileChangesFromPayload,
} from "../src/orchestrator/tool-runner.js";

const ROOT = "/repo";

describe("fileChangesFromPayload", () => {
  test("write_file / edit_file 单对象 payload", () => {
    const fc = fileChangesFromPayload(
      {
        path: "src/a.ts",
        linesAdded: 5,
        linesRemoved: 2,
        diff: "@@ -1 +1 @@\n-x\n+y",
      },
      ROOT,
    );
    expect(fc).toEqual([
      { path: "src/a.ts", added: 5, removed: 2, diff: "@@ -1 +1 @@\n-x\n+y" },
    ]);
  });

  test("edit_file 绝对路径归一化为工作区相对路径", () => {
    const fc = fileChangesFromPayload(
      { path: "/repo/src/b.ts", linesAdded: 1, linesRemoved: 0 },
      ROOT,
    );
    expect(fc?.[0]?.path).toBe("src/b.ts");
  });

  test("apply_patch 多文件 results，过滤失败项", () => {
    const fc = fileChangesFromPayload(
      {
        ok: true,
        results: [
          { path: "a.ts", ok: true, linesAdded: 3, linesRemoved: 1 },
          { path: "b.ts", ok: false, error: "conflict" },
          { path: "c.ts", ok: true, linesAdded: 0, linesRemoved: 4 },
        ],
        summary: "apply_patch: 2/3 file(s) edited (+3/-5)",
      },
      ROOT,
    );
    expect(fc).toEqual([
      { path: "a.ts", added: 3, removed: 1 },
      { path: "c.ts", added: 0, removed: 4 },
    ]);
  });

  test("无统计字段 / 空 payload → undefined", () => {
    expect(fileChangesFromPayload({ bytes_written: 9 }, ROOT)).toBeUndefined();
    expect(fileChangesFromPayload(undefined, ROOT)).toBeUndefined();
    expect(fileChangesFromPayload(null, ROOT)).toBeUndefined();
    expect(fileChangesFromPayload("text", ROOT)).toBeUndefined();
  });

  test("缺 path 兜底 (unknown)；只有 added 或 removed 也可", () => {
    const fc = fileChangesFromPayload({ linesAdded: 2 }, ROOT);
    expect(fc).toEqual([{ path: "(unknown)", added: 2, removed: 0 }]);
  });
});

describe("extractFilePatch", () => {
  const patch = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,2 +1,2 @@",
    " ctx",
    "-oldA",
    "+newA",
    "--- a/src/b.ts",
    "+++ b/src/b.ts",
    "@@ -5,1 +5,1 @@",
    "-oldB",
    "+newB",
    "",
  ].join("\n");

  test("按文件抽取 diff 段", () => {
    const a = extractFilePatch(patch, "src/a.ts");
    expect(a).toContain("-oldA");
    expect(a).toContain("+newA");
    expect(a).not.toContain("oldB");

    const b = extractFilePatch(patch, "src/b.ts");
    expect(b).toContain("-oldB");
    expect(b).not.toContain("oldA");
  });

  test("路径归一：a//b 前缀与后缀匹配", () => {
    expect(extractFilePatch(patch, "a.ts")).toContain("newA");
    expect(extractFilePatch(patch, "src/c.ts")).toBeUndefined();
  });

  test("空输入安全", () => {
    expect(extractFilePatch("", "a.ts")).toBeUndefined();
    expect(extractFilePatch(patch, "")).toBeUndefined();
  });
});
