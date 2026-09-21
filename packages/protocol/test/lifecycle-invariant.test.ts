import { describe, expect, test } from "bun:test";

import {
  LIFECYCLE_INVARIANT_CODES_V1,
  LifecycleInvariantErrorV1,
  lifecycleInvariant,
} from "../src/journal/lifecycle-invariant.js";

/**
 * §R2 的抱怨是：`validate-lifecycle.ts` 用散文式字符串就地抛错，于是**同一条规则
 * 在两个检测点触发时抛出完全相同的文案**，日志和测试都无法区分是哪一处失败的。
 * 这个模块给每条规则一个稳定 code，并把"现场"单独记下来。
 *
 * 这里钉的是登记表本身的性质（唯一、有命名空间）与错误的形状；至于"每个
 * 抛错点都用对了 code"，由类型系统保证 —— 参数类型是 code 的联合，写错编译不过。
 */
describe("LIFECYCLE_INVARIANT_CODES_V1", () => {
  const entries = Object.entries(LIFECYCLE_INVARIANT_CODES_V1);

  test("every code is unique", () => {
    const codes = entries.map(([, code]) => code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  /**
   * 命名空间前缀让日志检索能把"work segment 启动前必须成立什么"一次问出来 ——
   * 那正是 §R2 说此前没有任何地方能回答的问题。
   */
  test("every code is namespaced by fact family", () => {
    for (const [key, code] of entries) {
      expect(code.startsWith("work_segment.")).toBe(true);
      expect(code).not.toContain(" ");
      expect(key).not.toContain(".");
    }
  });

  test("no code is an empty string", () => {
    for (const [, code] of entries) {
      expect(code.length).toBeGreaterThan("work_segment.".length);
    }
  });
});

describe("LifecycleInvariantErrorV1", () => {
  test("carries the rule code, the detection site and the original message", () => {
    const error = lifecycleInvariant(
      LIFECYCLE_INVARIANT_CODES_V1.terminalPromotionNeedsSegmentMarker,
      "terminal promotion requires a work segment marker",
      "input.promoted",
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(LifecycleInvariantErrorV1);
    expect(error.name).toBe("LifecycleInvariantErrorV1");
    expect(error.code).toBe("work_segment.terminal_promotion_needs_marker");
    expect(error.detectedAt).toBe("input.promoted");
    // 文案与改动前逐字相同 —— code 是新增的区分手段，不替代消息
    expect(error.message).toBe("terminal promotion requires a work segment marker");
  });

  /**
   * `terminalPromotionNeedsSegmentMarker` 是**一个不变量、两个检测点**：
   * promotion 先到就地拒绝（`input.promoted`），工作段后到则拒绝该工作段。
   * 所以两者 code 必须相同（规则只有一条），靠 `detectedAt` 区分现场。
   */
  test("the same rule detected at two sites shares a code but not a site", () => {
    const early = lifecycleInvariant(
      LIFECYCLE_INVARIANT_CODES_V1.terminalPromotionNeedsSegmentMarker,
      "terminal promotion requires a work segment marker",
      "input.promoted",
    );
    const late = lifecycleInvariant(
      LIFECYCLE_INVARIANT_CODES_V1.terminalPromotionNeedsSegmentMarker,
      "terminal promotion requires a work segment marker",
      "work.segment_started",
    );
    expect(early.code).toBe(late.code);
    expect(early.message).toBe(late.message);
    expect(early.detectedAt).not.toBe(late.detectedAt);
  });

  test("the site is optional for single-site rules", () => {
    const error = lifecycleInvariant(
      LIFECYCLE_INVARIANT_CODES_V1.segmentIndexContiguous,
      "work segment indexes must be contiguous from 1",
    );
    expect(error.code).toBe("work_segment.index_contiguous");
    expect(error.detectedAt).toBeUndefined();
  });
});
