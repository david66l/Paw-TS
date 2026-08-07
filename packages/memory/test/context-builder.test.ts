/**
 * ContextBuilder 估算口径统一测试（AC-P1-9 补齐）
 *
 * 背景：ContextBuilder 原用 ascii/4 + nonAscii/1.5 启发式做 hot/warm/cold
 * 预算决策，与 memory-runtime 上报口径（TiktokenEstimator）不一致。
 * 现已统一为注入同一 TokenEstimator。
 */

import { describe, expect, test } from "bun:test";
import { TiktokenEstimator } from "@paw/core";
import { ContextBuilder } from "../src/db/modules/index.js";
import type { WorkingMemory } from "../src/db/types.js";

function makeWorkingMemory(
  overrides: Partial<WorkingMemory> = {},
): WorkingMemory {
  return {
    id: "wm-1",
    taskId: "task-1",
    revision: 1,
    goal: "",
    constraints: [],
    plan: [],
    todos: [],
    completedSteps: [],
    readFiles: [],
    modifiedFiles: [],
    executedTools: [],
    testRunIds: [],
    activeHypotheses: [],
    rejectedHypotheses: [],
    openQuestions: [],
    contextPointers: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("ContextBuilder 估算口径统一（AC-P1-9）", () => {
  test("预算决策与上报使用注入的同一估算器", () => {
    const estimator = new TiktokenEstimator();
    const builder = new ContextBuilder(undefined, estimator);

    const goal = "修复 orchestrator.ts 的上下文压缩逻辑，确保约束逐字存活";
    const currentUserRequest = "继续处理压缩门控的边缘情况";
    const result = builder.build({
      workingMemory: makeWorkingMemory({ goal }),
      currentUserRequest,
      tokenBudget: 4000,
    });

    // item 级估算 = 注入估算器对渲染内容的计数（非 ascii/4+nonAscii/1.5）
    const hotGoal = result.items.find((i) => i.sourceId === "goal");
    if (!hotGoal) throw new Error("goal hot item missing");
    expect(hotGoal.estimatedTokens).toBe(
      estimator.count(`[CURRENT GOAL]\n${goal}`),
    );

    // 上报口径 = 注入估算器对渲染结果的计数 + 用户请求
    expect(result.tokenUsage.estimatedUsed).toBe(
      estimator.count(result.renderedPrompt) +
        estimator.count(currentUserRequest),
    );
  });

  test("默认构造回退到 TiktokenEstimator（与主路径同源）", () => {
    const builder = new ContextBuilder();
    const result = builder.build({
      workingMemory: makeWorkingMemory({ goal: "中文目标 mixed with English" }),
      currentUserRequest: "test",
      tokenBudget: 4000,
    });
    const ref = new TiktokenEstimator();
    expect(result.tokenUsage.estimatedUsed).toBe(
      ref.count(result.renderedPrompt) + ref.count("test"),
    );
  });

  test("中文内容的预算占用按 tiktoken 计数（旧启发式会失真）", () => {
    const estimator = new TiktokenEstimator();
    const builder = new ContextBuilder(undefined, estimator);
    // 纯中文 goal：旧启发式 nonAscii/1.5 与 tiktoken 差异显著
    const goal = "确认所有章节的信息都已经完整地保留下来".repeat(10);
    const result = builder.build({
      workingMemory: makeWorkingMemory({ goal }),
      currentUserRequest: "go",
      tokenBudget: 4000,
    });
    const hotGoal = result.items.find((i) => i.sourceId === "goal");
    if (!hotGoal) throw new Error("goal hot item missing");
    expect(hotGoal.estimatedTokens).toBe(
      estimator.count(`[CURRENT GOAL]\n${goal}`),
    );
  });
});
