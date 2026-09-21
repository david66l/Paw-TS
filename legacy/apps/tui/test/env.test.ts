import { afterEach, describe, expect, test } from "bun:test";

import { tuiStrictToolApprovalFromEnv } from "../src/env.js";

const KEY = "PAW_TUI_STRICT_TOOL_APPROVAL";

describe("tuiStrictToolApprovalFromEnv", () => {
  // 保存原始环境变量，测试结束后恢复
  const snapshot = process.env[KEY];

  afterEach(() => {
    if (snapshot === undefined) {
      delete process.env[KEY];
    } else {
      process.env[KEY] = snapshot;
    }
  });

  test("未设置环境变量时返回 false", () => {
    delete process.env[KEY];
    expect(tuiStrictToolApprovalFromEnv()).toBe(false);
  });

  test("值为 1 / true / yes / all / TRUE 时返回 true", () => {
    for (const val of ["1", "true", "yes", "all", "TRUE"]) {
      process.env[KEY] = val;
      expect(tuiStrictToolApprovalFromEnv()).toBe(true);
    }
  });
});
