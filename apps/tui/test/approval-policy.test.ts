import { describe, expect, test } from "bun:test";

import { approvalPolicyWhenStrict } from "../src/approval-policy.js";

describe("approvalPolicyWhenStrict", () => {
  test("严格模式关闭时返回 undefined，使用默认审批策略", () => {
    expect(approvalPolicyWhenStrict(false)).toBeUndefined();
  });

  test("严格模式开启时所有工具都需要审批", () => {
    const p = approvalPolicyWhenStrict(true);
    expect(p).toBeDefined();
    expect(p?.("workspace.read_file")).toBe(true);
    expect(p?.("workspace.search")).toBe(true);
  });
});
