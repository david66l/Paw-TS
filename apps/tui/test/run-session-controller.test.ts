import { describe, expect, test } from "bun:test";

import { createRunSessionController } from "../src/run-session-controller.js";

describe("createRunSessionController", () => {
  test("serializes submissions", () => {
    const c = createRunSessionController();
    expect(c.tryBeginSubmission()).toBe(true);
    expect(c.isSubmissionBusy()).toBe(true);
    expect(c.tryBeginSubmission()).toBe(false);
    c.endSubmission();
    expect(c.isSubmissionBusy()).toBe(false);
    expect(c.tryBeginSubmission()).toBe(true);
    c.endSubmission();
  });

  test("abortIfRunning clears controller until next stub-run begin", () => {
    const c = createRunSessionController();
    expect(c.abortIfRunning()).toBe(false);
    c.runSession.begin();
    expect(c.abortIfRunning()).toBe(true);
    expect(c.abortIfRunning()).toBe(false);
    c.runSession.end();
  });
});
