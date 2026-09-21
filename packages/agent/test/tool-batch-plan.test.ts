import { describe, expect, test } from "bun:test";

import type { AgentToolCallAction } from "@paw/core";

import { createToolCallPlans } from "../src/orchestrator/tool-batch-plan.js";

function call(tool: string): AgentToolCallAction {
  return { type: "tool_call", tool, args: {} };
}

/**
 * `createToolCallPlans` 取代了原先 7 个下标对齐的并行数组
 * （docs/CODE-REVIEW.md §A3）。它存在的意义就是"长度与顺序一致"这件事
 * 不再需要维护，所以这几条测试钉的都是那个不变量本身。
 */
describe("createToolCallPlans", () => {
  test("produces one plan per call, in call order", () => {
    const calls = [call("a"), call("b"), call("c")];
    const plans = createToolCallPlans(
      calls,
      [undefined, undefined, undefined],
      [false, true, false],
    );
    expect(plans).toHaveLength(calls.length);
    expect(plans.map((p) => p.call.tool)).toEqual(["a", "b", "c"]);
    // 逐条记录绑定的是**同一个** call 对象，而不是拷贝
    expect(plans[1]?.call).toBe(calls[1]!);
  });

  test("carries the policy block through, including its absence", () => {
    const block = { reason: "read_only_child", message: "denied" };
    const plans = createToolCallPlans([call("a"), call("b")], [block, undefined], [false, false]);
    expect(plans[0]?.policyBlock).toBe(block);
    expect(plans[1]?.policyBlock).toBeUndefined();
  });

  test("defaults the staged fields to 'not yet decided'", () => {
    const plans = createToolCallPlans([call("a")], [undefined], [true]);
    const plan = plans[0]!;
    expect(plan.approval).toBe(false);
    expect(plan.lockConflict).toBeUndefined();
    expect(plan.checkpointNum).toBeUndefined();
    expect(plan.mutationCapture).toBeUndefined();
    expect(plan.effectPolicyApplies).toBe(true);
  });

  /**
   * 入参偏短时（原先会读到 `undefined` 这个"不该读的格子"）显式兜底为 false，
   * 与"effect policy 不适用"同义 —— 这正是 `?? false` 存在的理由。
   */
  test("treats a missing effectPolicyApplies entry as false, not undefined", () => {
    const plans = createToolCallPlans([call("a"), call("b")], [], [true]);
    expect(plans.map((p) => p.effectPolicyApplies)).toEqual([true, false]);
  });

  test("returns an empty plan list for an empty batch", () => {
    expect(createToolCallPlans([], [], [])).toEqual([]);
  });
});
