import { describe, expect, test } from "bun:test";

import { createRunSessionController } from "../src/session.js";

describe("createRunSessionController", () => {
  test("串行化用户提交，避免并发执行", () => {
    const c = createRunSessionController();
    expect(c.tryBeginSubmission()).toBe(true);
    expect(c.isSubmissionBusy()).toBe(true);
    expect(c.tryBeginSubmission()).toBe(false);
    c.endSubmission();
    expect(c.isSubmissionBusy()).toBe(false);
    expect(c.tryBeginSubmission()).toBe(true);
    c.endSubmission();
  });

  test("abortIfRunning 仅在存在活跃 AbortController 时返回 true", () => {
    const c = createRunSessionController();
    expect(c.abortIfRunning()).toBe(false);
    c.runSession.begin();
    expect(c.abortIfRunning()).toBe(true);
    expect(c.abortIfRunning()).toBe(false);
    c.runSession.end();
  });
});
