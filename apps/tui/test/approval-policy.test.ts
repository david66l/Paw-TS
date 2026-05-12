import { describe, expect, test } from "bun:test";

import { approvalPolicyWhenStrict } from "../src/approval-policy.js";

describe("approvalPolicyWhenStrict", () => {
  test("returns undefined when strict is off", () => {
    expect(approvalPolicyWhenStrict(false)).toBeUndefined();
  });

  test("returns policy that requires approval for any tool id when strict is on", () => {
    const p = approvalPolicyWhenStrict(true);
    expect(p).toBeDefined();
    expect(p?.("workspace.read_file")).toBe(true);
    expect(p?.("workspace.search")).toBe(true);
  });
});
