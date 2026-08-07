import { describe, expect, test } from "bun:test";

import type { LanguageModel } from "@paw/models";

import {
  buildConstraintReconcilePrompt,
  runConstraintReconcile,
} from "../src/constraint-reconcile.js";
import { TaskStateManager, type ConstraintRecord } from "../src/task-state.js";

function modelResponding(text: string): LanguageModel {
  return {
    label: "mock-reconcile",
    async complete() {
      return { text };
    },
    async *completeStream() {
      yield { type: "done" as const };
    },
  };
}

function failingModel(): LanguageModel {
  return {
    label: "mock-fail",
    async complete() {
      throw new Error("boom");
    },
    async *completeStream() {
      yield { type: "done" as const };
    },
  };
}

const existing: ConstraintRecord[] = [
  { text: "不要修改 src/legacy.js", sourceTurn: 2, status: "active" },
  { text: "只能用 Redis 做缓存", sourceTurn: 5, status: "active" },
];

describe("constraint-reconcile", () => {
  test("prompt 包含现有约束与新增用户消息", () => {
    const prompt = buildConstraintReconcilePrompt({
      existing,
      newUserMessages: ["算了，legacy.js 可以改了", "缓存换成 Memcached"],
      currentTurn: 12,
    });
    expect(prompt).toContain("[0] (turn 2) 不要修改 src/legacy.js");
    expect(prompt).toContain("[1] (turn 5) 只能用 Redis 做缓存");
    expect(prompt).toContain("算了，legacy.js 可以改了");
  });

  test("解析成功：keep/add/drop 生效", async () => {
    const result = await runConstraintReconcile({
      model: modelResponding(
        '{"keep":[0],"add":[{"text":"缓存换成 Memcached 吧"}],"drop":[1]}',
      ),
      existing,
      newUserMessages: ["缓存换成 Memcached 吧"],
      currentTurn: 12,
    });
    expect(result.ok).toBe(true);
    expect(result.keep).toEqual([0]);
    expect(result.drop).toEqual([1]);
    expect(result.add).toEqual([{ text: "缓存换成 Memcached 吧" }]);
  });

  test("宽松解析：容忍 markdown 围栏", async () => {
    const result = await runConstraintReconcile({
      model: modelResponding(
        '```json\n{"keep":[],"add":[],"drop":[0,1]}\n```',
      ),
      existing,
      newUserMessages: ["撤销之前的所有限制"],
      currentTurn: 13,
    });
    expect(result.ok).toBe(true);
    expect(result.drop).toEqual([0, 1]);
  });

  test("越界下标过滤；drop 优先于 keep", async () => {
    const result = await runConstraintReconcile({
      model: modelResponding(
        '{"keep":[0,1,99],"drop":[1],"add":[]}',
      ),
      existing,
      newUserMessages: [],
      currentTurn: 13,
    });
    expect(result.keep).toEqual([0]);
    expect(result.drop).toEqual([1]);
  });

  test("解析失败 → 降级：keep 全部 + 规则追加（不丢约束）", async () => {
    const result = await runConstraintReconcile({
      model: modelResponding("I don't understand the format"),
      existing,
      newUserMessages: ["记住：不要用 Postgres"],
      currentTurn: 14,
    });
    expect(result.ok).toBe(false);
    expect(result.keep).toEqual([0, 1]);
    expect(result.drop).toEqual([]);
    // 规则兜底：字面约束（整行）追加（只增不删，安全方向）
    expect(result.add.map((a) => a.text)).toContain("记住：不要用 Postgres");
  });

  test("LLM 故障 → 降级（绝不因故障丢约束）", async () => {
    const result = await runConstraintReconcile({
      model: failingModel(),
      existing,
      newUserMessages: ["换个思路做"],
      currentTurn: 15,
    });
    expect(result.ok).toBe(false);
    expect(result.keep).toEqual([0, 1]);
  });
});

describe("TaskStateManager 约束生命周期", () => {
  test("反转场景：用户说改用 Y → drop 旧约束，add 新约束", () => {
    const state = new TaskStateManager("不要用 X 方案");
    // 初始：goal 提取 1 条约束
    expect(state.activeConstraints().map((c) => c.text)).toContain(
      "不要用 X 方案",
    );
    // LLM 调和：反转（drop [0] + add 改用 Y）
    state.updateConstraints(
      { keep: [], drop: [0], add: [{ text: "改用 Y 方案" }] },
      8,
    );
    const active = state.activeConstraints();
    expect(active.map((c) => c.text)).toEqual(["改用 Y 方案"]);
    expect(active[0]?.sourceTurn).toBe(8);
    // 旧约束标记 superseded（可追溯）
    const superseded = state
      .snapshot()
      .constraints.filter((c) => c.status === "superseded");
    expect(superseded.map((c) => c.text)).toContain("不要用 X 方案");
  });

  test("撤销场景：drop 全部 → 红线区清空", () => {
    const state = new TaskStateManager("必须使用 Redis 缓存");
    state.updateConstraints({ keep: [], drop: [0], add: [] }, 10);
    expect(state.activeConstraints()).toHaveLength(0);
  });

  test("keep 后原有约束保持 active 且来源轮次不变", () => {
    const state = new TaskStateManager("不要修改 src/legacy.js");
    state.updateConstraints({ keep: [0], drop: [], add: [] }, 20);
    const active = state.activeConstraints();
    expect(active).toHaveLength(1);
    expect(active[0]?.sourceTurn).toBe(0);
  });

  test("旧格式 resume 兼容：string[] 升级为记录", () => {
    const legacy = {
      goal: "g",
      constraints: ["不要动 a.ts", "只用 bun"],
      plan: [],
      filesRead: [],
      filesChanged: [],
      commandsRun: [],
      testResults: [],
      rejectedHypotheses: [],
      pinnedFacts: [],
      knownNonGoals: [],
      updatedAt: 1,
    };
    const state = new TaskStateManager("ignored", legacy);
    const active = state.activeConstraints();
    expect(active.map((c) => c.text)).toEqual(["不要动 a.ts", "只用 bun"]);
    expect(active.every((c) => c.status === "active")).toBe(true);
  });
});
