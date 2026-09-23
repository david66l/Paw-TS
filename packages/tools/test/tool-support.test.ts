import { describe, expect, test } from "bun:test";

import { errorCodeForToolPayload } from "../src/registry/tool-support.js";

/**
 * `errorCodeForToolPayload` 是 `errorCode` 的来源，而 `errorCode` 对崩溃恢复是
 * 承重的（journal 用它判断崩溃后能否开启新的 work segment，见批次 B #18）。
 * 它此前没有任何用例 —— §D9 点名了这一点。
 *
 * 分类本身依赖英文子串（那是 §R4 的另一件事），所以这里钉的不是"分类得对不对"，
 * 而是**当前契约**：优先级顺序、大小写、以及未知形态落到哪里。顺序尤其容易在
 * 后续维护中被打乱，而打乱不会报错，只会让失败被归到另一类。
 */
describe("errorCodeForToolPayload", () => {
  const POLICY_DENIED = [
    // risk 字段直接判定
    { risk: "escaped" },
    { risk: "sensitive" },
    // error 文案逐条覆盖（每一条都是实现里列出的关键词）
    { error: "path escapes workspace" },
    { error: "sensitive file" },
    { error: "disallowed by policy" },
    { error: "blocked pattern: *.env" },
    { error: "blocked literal" },
    { error: "blocked command" },
    { error: "blocked: rm -rf /" },
    { error: "requires approval" },
    { error: "default action is ask" },
  ];

  const USER_ERROR = [
    { error: "ENOENT: no such file" },
    { error: "file not found" },
    { error: "missing required field: goal" },
    { error: "destination already exists" },
  ];

  for (const payload of POLICY_DENIED) {
    test(`policy denial: ${JSON.stringify(payload)}`, () => {
      expect(errorCodeForToolPayload(payload)).toBe("E_POLICY_DENIED");
    });
  }

  for (const payload of USER_ERROR) {
    test(`user error: ${JSON.stringify(payload)}`, () => {
      expect(errorCodeForToolPayload(payload)).toBe("E_USER");
    });
  }

  test("matching is case-insensitive on the error text", () => {
    expect(errorCodeForToolPayload({ error: "PATH ESCAPES WORKSPACE" })).toBe("E_POLICY_DENIED");
    expect(errorCodeForToolPayload({ error: "File Not Found" })).toBe("E_USER");
  });

  test("a policy substring wins over a user substring in the same message", () => {
    // 优先级是承重的：同一条文案里既有 "blocked" 又有 "not found" 时必须归到
    // policy，否则一次策略拒绝会被记成用户错误。
    expect(errorCodeForToolPayload({ error: "blocked: target not found" })).toBe("E_POLICY_DENIED");
  });

  test("the risk field wins over the error text", () => {
    expect(errorCodeForToolPayload({ risk: "escaped", error: "not found" })).toBe(
      "E_POLICY_DENIED",
    );
  });

  test("an unrecognised risk value falls through to the error text", () => {
    // risk 只认 escaped / sensitive 两个字面量；其它值不参与判定
    expect(errorCodeForToolPayload({ risk: "unknown", error: "not found" })).toBe("E_USER");
  });

  test("anything unrecognised is E_FATAL", () => {
    for (const payload of [
      undefined,
      null,
      "a string",
      42,
      {},
      { error: 42 },
      { error: null },
      { error: "" },
      { error: "something else entirely" },
    ]) {
      expect(errorCodeForToolPayload(payload)).toBe("E_FATAL");
    }
  });
});
