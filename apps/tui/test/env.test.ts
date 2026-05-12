import { afterEach, describe, expect, test } from "bun:test";

import { tuiStrictToolApprovalFromEnv } from "../src/env.js";

const KEY = "PAW_TUI_STRICT_TOOL_APPROVAL";

describe("tuiStrictToolApprovalFromEnv", () => {
  const snapshot = process.env[KEY];

  afterEach(() => {
    if (snapshot === undefined) {
      delete process.env[KEY];
    } else {
      process.env[KEY] = snapshot;
    }
  });

  test("off when unset", () => {
    delete process.env[KEY];
    expect(tuiStrictToolApprovalFromEnv()).toBe(false);
  });

  test("on for 1 / true / yes / all", () => {
    for (const val of ["1", "true", "yes", "all", "TRUE"]) {
      process.env[KEY] = val;
      expect(tuiStrictToolApprovalFromEnv()).toBe(true);
    }
  });
});
