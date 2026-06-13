import { describe, expect, test } from "bun:test";

import {
  CircuitBreaker,
  CircuitBreakerOpenError,
} from "../src/resilience/circuit-breaker.js";

describe("CircuitBreaker", () => {
  test("starts in CLOSED state", () => {
    const cb = new CircuitBreaker("test");
    expect(cb.state).toBe("closed");
    expect(cb.snapshot().failures).toBe(0);
  });

  test("guard() passes when CLOSED", () => {
    const cb = new CircuitBreaker("test");
    expect(() => cb.guard()).not.toThrow();
  });

  test("opens after threshold failures", () => {
    const cb = new CircuitBreaker("test", {
      failureThreshold: 3,
      recoveryTimeoutMs: 30_000,
    });
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.state).toBe("closed");
    cb.recordFailure();
    expect(cb.state).toBe("open");
  });

  test("guard() throws when OPEN", () => {
    const cb = new CircuitBreaker("test", { failureThreshold: 1 });
    cb.recordFailure();
    expect(cb.state).toBe("open");
    expect(() => cb.guard()).toThrow(CircuitBreakerOpenError);
    try {
      cb.guard();
    } catch (e) {
      expect(e instanceof CircuitBreakerOpenError).toBe(true);
      const err = e as CircuitBreakerOpenError;
      expect(err.label).toBe("test");
      expect(err.state).toBe("open");
      expect(err.failures).toBe(1);
    }
  });

  test("transitions to HALF_OPEN after recovery timeout", async () => {
    const cb = new CircuitBreaker("test", {
      failureThreshold: 1,
      recoveryTimeoutMs: 50,
    });
    cb.recordFailure();
    expect(cb.state).toBe("open");
    await new Promise((r) => setTimeout(r, 60));
    expect(cb.state).toBe("half_open");
  });

  test("HALF_OPEN guard() allows limited probe calls", () => {
    const cb = new CircuitBreaker("test", {
      failureThreshold: 1,
      recoveryTimeoutMs: 0,
      halfOpenMaxCalls: 2,
    });
    cb.recordFailure();
    // Manually transition to half_open by resetting timeout
    cb["_state"] = "half_open";
    cb["halfOpenCalls"] = 0;

    expect(cb.state).toBe("half_open");
    expect(() => cb.guard()).not.toThrow();
    expect(() => cb.guard()).not.toThrow();
    expect(() => cb.guard()).toThrow(CircuitBreakerOpenError);
  });

  test("probe success closes the circuit", () => {
    const cb = new CircuitBreaker("test", {
      failureThreshold: 1,
      recoveryTimeoutMs: 0,
    });
    cb.recordFailure();
    cb["_state"] = "half_open";
    cb["halfOpenCalls"] = 0;

    expect(cb.state).toBe("half_open");
    cb.recordSuccess();
    expect(cb.state).toBe("closed");
    expect(cb.snapshot().failures).toBe(0);
  });

  test("probe failure reopens the circuit", () => {
    const cb = new CircuitBreaker("test", {
      failureThreshold: 1,
      recoveryTimeoutMs: 60_000, // long timeout so auto-transition doesn't interfere
    });
    cb.recordFailure();
    cb["_state"] = "half_open";
    cb["halfOpenCalls"] = 0;
    cb["openedAt"] = Date.now(); // reset openedAt so HALF_OPEN sticks

    expect(cb.snapshot().state).toBe("half_open");
    cb.recordFailure();
    expect(cb.snapshot().state).toBe("open");
  });

  test("success in CLOSED resets failure count", () => {
    const cb = new CircuitBreaker("test", { failureThreshold: 3 });
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.snapshot().failures).toBe(2);
    cb.recordSuccess();
    expect(cb.snapshot().failures).toBe(0);
    cb.recordFailure();
    expect(cb.state).toBe("closed"); // still below threshold
  });

  test("multiple breakers are isolated", () => {
    const a = new CircuitBreaker("a", { failureThreshold: 1 });
    const b = new CircuitBreaker("b", { failureThreshold: 1 });
    a.recordFailure();
    expect(a.state).toBe("open");
    expect(b.state).toBe("closed");
  });

  test("reset() restores initial state", () => {
    const cb = new CircuitBreaker("test", { failureThreshold: 1 });
    cb.recordFailure();
    expect(cb.state).toBe("open");
    cb.reset();
    expect(cb.state).toBe("closed");
    expect(cb.snapshot().failures).toBe(0);
    expect(cb.snapshot().successes).toBe(0);
  });

  test("snapshot() returns current stats", () => {
    const cb = new CircuitBreaker("test");
    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess();
    const snap = cb.snapshot();
    expect(snap.state).toBe("closed");
    // Success in CLOSED resets failures to 0
    expect(snap.failures).toBe(0);
    expect(snap.successes).toBe(1);
    expect(snap.lastFailureAt).toBeDefined();
    expect(snap.lastSuccessAt).toBeDefined();
  });
});

describe("CircuitBreaker integration with AgentOrchestrator", () => {
  test("orchestrator fast-fails when breaker is OPEN", async () => {
    const { AgentOrchestrator } = await import("../src/orchestrator.js");
    const { FakeLanguageModel } = await import("@paw/models");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");

    const dir = mkdtempSync(path.join(tmpdir(), "paw-cb-"));
    writeFileSync(path.join(dir, "a.txt"), "x");

    const events: { type: string; label?: string; failures?: number }[] = [];
    const model = new FakeLanguageModel({
      responses: [{ error: new Error("fetch failed: ECONNREFUSED") }],
    });
    const o = new AgentOrchestrator({
      model,
      onEvent: (e) => events.push(e.event as never),
      retrySleep: async () => {},
    });

    // Pre-open the breaker by injecting an instance with failures
    const breaker = new (await import("../src/resilience/circuit-breaker.js"))
      .CircuitBreaker("fake", { failureThreshold: 1 });
    breaker.recordFailure();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (o as any).circuitBreakers.set("fake", breaker);

    const r = await o.run({
      runId: "cb-open",
      goal: "read a.txt",
      workspaceRoot: dir,
      maxSteps: 3,
    });
    expect(r.status).toBe("failed");
    expect(r.message).toContain("Circuit breaker");
    expect(r.message).toContain("open");
  });
});
