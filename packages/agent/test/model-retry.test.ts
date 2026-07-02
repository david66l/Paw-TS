import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";

import type { RunEventEnvelope } from "@paw/core";
import { FakeLanguageModel } from "@paw/models";

import { AgentOrchestrator } from "../src/orchestrator.js";
import { tmpDir } from "./fixtures.js";

/** Retryable network-like error. */
const RETRYABLE_ERR = new Error("fetch failed: ECONNREFUSED");
/** Non-retryable client error. */
const NON_RETRYABLE_ERR = new Error("Invalid API key");

describe("Model Retry", () => {
  test("transient error retries and eventually succeeds", async () => {
    const dir = tmpDir("paw-retry-ok-");
    writeFileSync(path.join(dir, "a.txt"), "x");
    const events: RunEventEnvelope[] = [];
    const model = new FakeLanguageModel({
      responses: [
        { error: RETRYABLE_ERR },
        { text: '{"action":"final_answer","summary":"Done."}' },
      ],
    });
    const o = new AgentOrchestrator({
      model,
      onEvent: (e) => events.push(e),
      retrySleep: async () => {},
    });
    const r = await o.run({
      runId: "retry-ok",
      goal: "read a.txt",
      workspaceRoot: dir,
      maxSteps: 3,
    });
    expect(r.status).toBe("completed");
    expect(model.callCount).toBe(2);
  });

  test("non-retryable error does not retry", async () => {
    const dir = tmpDir("paw-retry-no-");
    const events: RunEventEnvelope[] = [];
    const model = new FakeLanguageModel({
      responses: [{ error: NON_RETRYABLE_ERR }],
    });
    const o = new AgentOrchestrator({
      model,
      onEvent: (e) => events.push(e),
      retrySleep: async () => {},
    });
    const r = await o.run({
      runId: "retry-no",
      goal: "read a.txt",
      workspaceRoot: dir,
      maxSteps: 3,
    });
    expect(r.status).toBe("failed");
    expect(r.message).toContain("Invalid API key");
    expect(model.callCount).toBe(1);
  });

  test("retry exhausted returns failed", async () => {
    const dir = tmpDir("paw-retry-ex-");
    const events: RunEventEnvelope[] = [];
    const model = new FakeLanguageModel({
      responses: [
        { error: RETRYABLE_ERR },
        { error: RETRYABLE_ERR },
        { error: RETRYABLE_ERR },
      ],
    });
    const o = new AgentOrchestrator({
      model,
      onEvent: (e) => events.push(e),
      retrySleep: async () => {},
    });
    const r = await o.run({
      runId: "retry-ex",
      goal: "read a.txt",
      workspaceRoot: dir,
      maxSteps: 3,
    });
    expect(r.status).toBe("failed");
    expect(model.callCount).toBe(3);
  });

  test("model.retry.waiting event is emitted with increasing delayMs", async () => {
    const dir = tmpDir("paw-retry-wait-");
    const events: RunEventEnvelope[] = [];
    const model = new FakeLanguageModel({
      responses: [
        { error: RETRYABLE_ERR },
        { error: RETRYABLE_ERR },
        { text: '{"action":"final_answer","summary":"Done."}' },
      ],
    });
    const o = new AgentOrchestrator({
      model,
      onEvent: (e) => events.push(e),
      retrySleep: async () => {},
    });
    await o.run({
      runId: "retry-wait",
      goal: "read a.txt",
      workspaceRoot: dir,
      maxSteps: 3,
    });
    const waits = events
      .filter((e) => e.event.type === "model.retry.waiting")
      .map((e) => {
        if (e.event.type === "model.retry.waiting") {
          return { attempt: e.event.attempt, delayMs: e.event.delayMs };
        }
        return null;
      })
      .filter(Boolean);
    expect(waits.length).toBe(2);
    expect(waits[0]?.attempt).toBe(1);
    expect(waits[1]?.attempt).toBe(2);
    expect(waits[1]?.delayMs).toBeGreaterThan(waits[0]?.delayMs ?? 0);
  });

  test("retry tests complete without real sleep", async () => {
    const dir = tmpDir("paw-retry-fast-");
    const model = new FakeLanguageModel({
      responses: [
        { error: RETRYABLE_ERR },
        { error: RETRYABLE_ERR },
        { text: '{"action":"final_answer","summary":"Done."}' },
      ],
    });
    const o = new AgentOrchestrator({
      model,
      retrySleep: async () => {},
    });
    const start = Date.now();
    await o.run({
      runId: "retry-fast",
      goal: "read a.txt",
      workspaceRoot: dir,
      maxSteps: 3,
    });
    expect(Date.now() - start).toBeLessThan(500);
  });

  test("429 rate-limit uses Retry-After when present", async () => {
    const dir = tmpDir("paw-retry-429-");
    const events: RunEventEnvelope[] = [];
    const model = new FakeLanguageModel({
      responses: [
        { error: new Error("HTTP 429: Rate limited. Retry-After: 2") },
        { text: '{"action":"final_answer","summary":"Done."}' },
      ],
    });
    const o = new AgentOrchestrator({
      model,
      onEvent: (e) => events.push(e),
      retrySleep: async () => {},
    });
    await o.run({
      runId: "retry-429",
      goal: "read a.txt",
      workspaceRoot: dir,
      maxSteps: 3,
    });
    const waitEvent = events.find((e) => e.event.type === "model.retry.waiting");
    expect(waitEvent).toBeDefined();
    if (waitEvent?.event.type === "model.retry.waiting") {
      // Should be around 2s * jitter (0.5–1.0) = 1s–2s
      expect(waitEvent.event.delayMs).toBeGreaterThanOrEqual(800);
      expect(waitEvent.event.delayMs).toBeLessThanOrEqual(2500);
      expect(waitEvent.event.errorType).toBe("rate_limit");
    }
  });

  test("401/403 auth errors are not retried", async () => {
    const dir = tmpDir("paw-retry-auth-");
    const model = new FakeLanguageModel({
      responses: [{ error: new Error("HTTP 401: Unauthorized") }],
    });
    const o = new AgentOrchestrator({
      model,
      retrySleep: async () => {},
    });
    const r = await o.run({
      runId: "retry-auth",
      goal: "read a.txt",
      workspaceRoot: dir,
      maxSteps: 3,
    });
    expect(r.status).toBe("failed");
    expect(model.callCount).toBe(1);
  });

  test("jitter produces non-deterministic delays", async () => {
    const dir = tmpDir("paw-retry-jitter-");
    const delays: number[] = [];
    // Run multiple times to collect delay samples
    for (let i = 0; i < 5; i++) {
      const events: RunEventEnvelope[] = [];
      const o = new AgentOrchestrator({
        model: new FakeLanguageModel({
          responses: [
            { error: RETRYABLE_ERR },
            { text: '{"action":"final_answer","summary":"Done."}' },
          ],
        }),
        onEvent: (e) => events.push(e),
        retrySleep: async () => {},
      });
      await o.run({
        runId: `retry-jitter-${i}`,
        goal: "read a.txt",
        workspaceRoot: dir,
        maxSteps: 3,
      });
      const waitEvent = events.find((e) => e.event.type === "model.retry.waiting");
      if (waitEvent?.event.type === "model.retry.waiting") {
        delays.push(waitEvent.event.delayMs);
      }
    }
    // With jitter, not all delays should be identical
    const uniqueDelays = new Set(delays);
    expect(uniqueDelays.size).toBeGreaterThan(1);
    // All delays should be within jitter range of 1s base (0.5–1.0x)
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(400);
      expect(d).toBeLessThanOrEqual(1100);
    }
  });

  test("errorType is included in retry event", async () => {
    const dir = tmpDir("paw-retry-type-");
    const events: RunEventEnvelope[] = [];
    const model = new FakeLanguageModel({
      responses: [
        { error: new Error("HTTP 500: Internal Server Error") },
        { text: '{"action":"final_answer","summary":"Done."}' },
      ],
    });
    const o = new AgentOrchestrator({
      model,
      onEvent: (e) => events.push(e),
      retrySleep: async () => {},
    });
    await o.run({
      runId: "retry-type",
      goal: "read a.txt",
      workspaceRoot: dir,
      maxSteps: 3,
    });
    const waitEvent = events.find((e) => e.event.type === "model.retry.waiting");
    expect(waitEvent).toBeDefined();
    if (waitEvent?.event.type === "model.retry.waiting") {
      expect(waitEvent.event.errorType).toBe("server_error");
    }
  });
});
