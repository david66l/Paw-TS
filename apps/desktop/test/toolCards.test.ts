import { describe, expect, test } from "bun:test";
import {
  appendAgentTool,
  mergeFileChanges,
  resolveAgentTool,
  shortToolName,
  summarizeToolCallArgs,
  toolBatchSummaryLine,
  toolRowStatusFromResult,
  totalChangeStats,
} from "../src/agent/toolCards";
import type { ToolRunRow } from "../src/agent/types";

describe("summarizeToolCallArgs", () => {
  test("提取 path / command，超长截断", () => {
    expect(summarizeToolCallArgs({ path: "src/a.ts" })).toBe("src/a.ts");
    expect(summarizeToolCallArgs({ command: "bun test" })).toBe("bun test");
    const long = "x".repeat(200);
    expect(summarizeToolCallArgs({ path: long }).length).toBeLessThan(130);
  });

  test("空 args / 无定位字段 → 空串", () => {
    expect(summarizeToolCallArgs(null)).toBe("");
    expect(summarizeToolCallArgs({ offset: 1 })).toBe("");
  });
});

describe("toolRowStatusFromResult", () => {
  test("denied 摘要识别", () => {
    expect(
      toolRowStatusFromResult(false, "tool execution denied by user"),
    ).toBe("denied");
    expect(toolRowStatusFromResult(false, "exit code 1")).toBe("fail");
    expect(toolRowStatusFromResult(true, "write_file: a.ts (9 bytes)")).toBe(
      "ok",
    );
  });
});

describe("mergeFileChanges", () => {
  test("新路径追加；同路径累加 +/− 且 diff 拼接保留全部 hunk", () => {
    const first = mergeFileChanges(
      [],
      [{ path: "a.ts", added: 3, removed: 1, diff: "d1" }],
    );
    expect(first).toEqual([{ path: "a.ts", added: 3, removed: 1, diff: "d1" }]);
    const second = mergeFileChanges(first, [
      { path: "a.ts", added: 2, removed: 2, diff: "d2" },
      { path: "b.ts", added: 5, removed: 0 },
    ]);
    expect(second).toEqual([
      { path: "a.ts", added: 5, removed: 3, diff: "d1\nd2" },
      { path: "b.ts", added: 5, removed: 0 },
    ]);
  });

  test("空 path 被忽略；无 diff 时保留旧 diff", () => {
    const merged = mergeFileChanges(
      [{ path: "a.ts", added: 1, removed: 0, diff: "keep" }],
      [
        { path: "", added: 9, removed: 9 },
        { path: "a.ts", added: 1, removed: 1 },
      ],
    );
    expect(merged).toEqual([
      { path: "a.ts", added: 2, removed: 1, diff: "keep" },
    ]);
  });
});

describe("totalChangeStats / toolBatchSummaryLine", () => {
  test("合计统计", () => {
    expect(
      totalChangeStats([
        { path: "a", added: 3, removed: 1 },
        { path: "b", added: 2, removed: 4 },
      ]),
    ).toEqual({ added: 5, removed: 5 });
  });

  test("工具卡摘要行", () => {
    const rows: ToolRunRow[] = [
      { id: "1", tool: "t", summary: "", status: "ok", at: 1 },
      { id: "2", tool: "t", summary: "", status: "denied", at: 1 },
    ];
    expect(toolBatchSummaryLine(rows)).toBe(
      "调用 2 个工具 · 1 成功 · 1 失败/拒绝",
    );
    expect(toolBatchSummaryLine([rows[0]!])).toBe("调用 1 个工具 · 全部成功");
  });
});


describe("子 Agent 实时工具流", () => {
  test("appendAgentTool 追加并保留最近 N 条", () => {
    let list = appendAgentTool([], {
      id: "1",
      tool: "workspace.read_file",
      summary: "a.ts",
      at: 1,
    });
    expect(list).toHaveLength(1);
    expect(list[0]?.ok).toBeUndefined();
    for (let i = 0; i < 20; i++) {
      list = appendAgentTool(list, {
        id: `x${i}`,
        tool: "workspace.run_shell",
        summary: "ls",
        at: i + 2,
      });
    }
    expect(list).toHaveLength(12);
    expect(list[0]?.id).toBe("x8");
  });

  test("resolveAgentTool 回填最后一个同工具未完成项", () => {
    const list = [
      { id: "1", tool: "workspace.read_file", summary: "a.ts", at: 1 },
      { id: "2", tool: "workspace.read_file", summary: "b.ts", at: 2 },
      { id: "3", tool: "workspace.run_shell", summary: "ls", at: 3 },
    ];
    const resolved = resolveAgentTool(
      list,
      "workspace.read_file",
      true,
      "read_file: b.ts (10 lines)",
    );
    expect(resolved[0]?.ok).toBeUndefined();
    expect(resolved[1]?.ok).toBe(true);
    expect(resolved[1]?.result).toContain("10 lines");
    expect(resolved[2]?.ok).toBeUndefined();
  });

  test("resolveAgentTool 无匹配原样返回；shortToolName 去前缀", () => {
    const list = resolveAgentTool([], "workspace.x", true, "s");
    expect(list).toEqual([]);
    expect(shortToolName("workspace.write_file")).toBe("write_file");
    expect(shortToolName("mcp.web")).toBe("mcp.web");
  });
});
