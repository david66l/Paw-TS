import { describe, expect, test } from "bun:test";
import {
  currentPlanItemId,
  extractPathFromArgs,
  mergePlanItems,
  parseLibraryItems,
  parsePlanItem,
  parseSelectedMemories,
  planProgress,
} from "../src/agent/useRightPanelData";

describe("parsePlanItem", () => {
  test("string item", () => {
    const r = parsePlanItem("Install dependencies");
    expect(r).not.toBeNull();
    expect(r!.id).toBe("Install dependencies");
    expect(r!.text).toBe("Install dependencies");
  });

  test("long string truncates id", () => {
    const long = "a".repeat(100);
    const r = parsePlanItem(long);
    expect(r!.id.length).toBe(40);
    expect(r!.text).toBe(long);
  });

  test("object with text field", () => {
    const r = parsePlanItem({ text: "Run tests", status: "pending" });
    expect(r!.id).toBe("Run tests");
    expect(r!.text).toBe("Run tests");
    expect(r!.status).toBe("pending");
  });

  test("object with task_id field", () => {
    const r = parsePlanItem({ task_id: "t1", content: "Do X" });
    expect(r!.id).toBe("t1");
    expect(r!.text).toBe("Do X");
  });

  test("invalid returns null", () => {
    expect(parsePlanItem(42)).toBeNull();
    expect(parsePlanItem(null)).toBeNull();
    expect(parsePlanItem({})).toBeNull();
  });
});

describe("mergePlanItems", () => {
  test("adds new items", () => {
    const result = mergePlanItems([], [{ text: "A" }, { text: "B" }], []);
    expect(result).toHaveLength(2);
    expect(result[0].text).toBe("A");
  });

  test("removes deprecated items", () => {
    const existing = [
      { id: "t1", text: "A" },
      { id: "t2", text: "B" },
    ];
    const result = mergePlanItems(existing, [], ["t1"]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("t2");
  });

  test("upserts existing item by id", () => {
    const existing = [{ id: "t1", text: "A", status: "pending" }];
    const result = mergePlanItems(
      existing,
      [{ id: "t1", text: "A updated", status: "done" }],
      [],
    );
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("A updated");
    expect(result[0].status).toBe("done");
  });
});

describe("extractPathFromArgs", () => {
  test("extracts path", () => {
    expect(extractPathFromArgs({ path: "/foo/bar.ts" })).toBe("/foo/bar.ts");
  });

  test("extracts relPath", () => {
    expect(extractPathFromArgs({ relPath: "src/x.ts" })).toBe("src/x.ts");
  });

  test("extracts file", () => {
    expect(extractPathFromArgs({ file: "x.ts" })).toBe("x.ts");
  });

  test("returns null for non-object", () => {
    expect(extractPathFromArgs(null)).toBeNull();
    expect(extractPathFromArgs("string")).toBeNull();
  });

  test("returns null when no path keys", () => {
    expect(extractPathFromArgs({ tool: "x", content: "y" })).toBeNull();
  });
});

describe("parseSelectedMemories", () => {
  test("parses retrieve payload", () => {
    const hits = parseSelectedMemories([
      {
        id: "m1",
        title: "Prefer vitest",
        summary: "Always use vitest",
        type: "user_preference",
        score: 0.82,
        source: "auto",
        relatedFiles: [],
      },
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.title).toBe("Prefer vitest");
    expect(hits[0]!.type).toBe("user_preference");
    expect(hits[0]!.score).toBe(0.82);
  });

  test("empty / invalid", () => {
    expect(parseSelectedMemories(null)).toEqual([]);
    expect(parseSelectedMemories([42])).toEqual([]);
  });
});

describe("parseLibraryItems", () => {
  test("parses list payload", () => {
    const items = parseLibraryItems([
      {
        id: "m2",
        title: "ioredis",
        summary: "use ioredis",
        type: "decision",
        status: "active",
        confidence: 0.9,
      },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]!.type).toBe("decision");
  });
});

describe("planProgress / currentPlanItemId", () => {
  const items = [
    { id: "1", text: "调研", status: "completed" },
    { id: "2", text: "实现", status: "running" },
    { id: "3", text: "测试", status: "pending" },
    { id: "4", text: "文档", status: "skipped" },
  ];

  test("completed + skipped 计入进度", () => {
    const p = planProgress(items);
    expect(p).toEqual({ done: 2, total: 4, pct: 50 });
    expect(planProgress([])).toEqual({ done: 0, total: 0, pct: 0 });
  });

  test("current：优先第一个 running", () => {
    expect(currentPlanItemId(items)).toBe("2");
  });

  test("无 running 时取第一个未完成项；全部完成返回 null", () => {
    expect(
      currentPlanItemId([
        { id: "1", text: "a", status: "completed" },
        { id: "2", text: "b", status: "pending" },
      ]),
    ).toBe("2");
    expect(
      currentPlanItemId([
        { id: "1", text: "a", status: "completed" },
        { id: "2", text: "b", status: "skipped" },
      ]),
    ).toBeNull();
  });

  test("兼容 done 状态", () => {
    expect(planProgress([{ id: "1", text: "a", status: "done" }]).pct).toBe(
      100,
    );
  });
});
