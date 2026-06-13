import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { RunEventEnvelope } from "@paw/core";
import { FileSystemAppStateStore } from "@paw/core";
import { FakeLanguageModel } from "@paw/models";

import { AgentOrchestrator } from "../src/orchestrator.js";

function tmpDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

describe("Phase 2 E2E — Retry", () => {
  test("429 with Retry-After header waits correct duration", async () => {
    const dir = tmpDir("paw-e2e-429-");
    writeFileSync(path.join(dir, "a.txt"), "x");
    const events: RunEventEnvelope[] = [];
    const model = new FakeLanguageModel({
      responses: [
        { error: new Error("HTTP 429: Rate limited. Retry-After: 3") },
        { text: '{"action":"final_answer","summary":"Done."}' },
      ],
    });
    const o = new AgentOrchestrator({
      model,
      onEvent: (e) => events.push(e),
      retrySleep: async () => {}, // no real sleep in tests
    });
    const r = await o.run({
      runId: "e2e-429",
      goal: "read a.txt",
      workspaceRoot: dir,
      maxSteps: 3,
    });
    expect(r.status).toBe("completed");
    const waitEvent = events.find((e) => e.event.type === "model.retry.waiting");
    expect(waitEvent).toBeDefined();
    if (waitEvent?.event.type === "model.retry.waiting") {
      expect(waitEvent.event.errorType).toBe("rate_limit");
      // 3s * jitter(0.5–1.0) = 1.5s–3s
      expect(waitEvent.event.delayMs).toBeGreaterThanOrEqual(1400);
      expect(waitEvent.event.delayMs).toBeLessThanOrEqual(3200);
    }
  });

  test("non-retryable 401 fails immediately without retry", async () => {
    const dir = tmpDir("paw-e2e-401-");
    const model = new FakeLanguageModel({
      responses: [{ error: new Error("HTTP 401: Invalid API key") }],
    });
    const o = new AgentOrchestrator({ model, retrySleep: async () => {} });
    const r = await o.run({
      runId: "e2e-401",
      goal: "read a.txt",
      workspaceRoot: dir,
      maxSteps: 3,
    });
    expect(r.status).toBe("failed");
    expect(model.callCount).toBe(1);
  });
});

describe("Phase 2 E2E — Circuit Breaker", () => {
  test("records failures and emits open event after threshold", async () => {
    const dir = tmpDir("paw-e2e-cb-");
    writeFileSync(path.join(dir, "a.txt"), "x");
    const events: RunEventEnvelope[] = [];
    const model = new FakeLanguageModel({
      responses: [
        { error: new Error("fetch failed: ECONNREFUSED") },
        { error: new Error("fetch failed: ECONNREFUSED") },
        { error: new Error("fetch failed: ECONNREFUSED") },
      ],
    });
    const o = new AgentOrchestrator({
      model,
      onEvent: (e) => events.push(e),
      retrySleep: async () => {},
    });

    // Inject a breaker with low threshold so it opens within one run
    const { CircuitBreaker } = await import(
      "../src/resilience/circuit-breaker.js"
    );
    const breaker = new CircuitBreaker("fake", { failureThreshold: 2 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (o as any).circuitBreakers.set("fake", breaker);

    const r = await o.run({
      runId: "e2e-cb",
      goal: "read a.txt",
      workspaceRoot: dir,
      maxSteps: 5,
    });
    expect(r.status).toBe("failed");

    // Should see retry events (3 attempts = 2 retries)
    const retries = events.filter((e) => e.event.type === "model.retry.waiting");
    expect(retries.length).toBe(2);

    // After 2 failures the breaker should have opened
    const cbEvent = events.find(
      (e) => e.event.type === "model.circuit_breaker.open",
    );
    expect(cbEvent).toBeDefined();
    if (cbEvent?.event.type === "model.circuit_breaker.open") {
      expect(cbEvent.event.label).toBe("fake");
      expect(cbEvent.event.failures).toBeGreaterThanOrEqual(2);
    }
  });

  test("subsequent run fast-fails when breaker is already open", async () => {
    const dir = tmpDir("paw-e2e-cb2-");
    writeFileSync(path.join(dir, "a.txt"), "x");
    const model = new FakeLanguageModel({
      responses: [{ text: '{"action":"final_answer","summary":"Done."}' }],
    });
    const o = new AgentOrchestrator({ model, retrySleep: async () => {} });

    // Manually open the breaker
    const { CircuitBreaker } = await import(
      "../src/resilience/circuit-breaker.js"
    );
    const breaker = new CircuitBreaker("fake", { failureThreshold: 1 });
    breaker.recordFailure();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (o as any).circuitBreakers.set("fake", breaker);

    const r = await o.run({
      runId: "e2e-cb2",
      goal: "read a.txt",
      workspaceRoot: dir,
      maxSteps: 3,
    });
    expect(r.status).toBe("failed");
    expect(r.message).toContain("Circuit breaker");
    expect(model.callCount).toBe(0); // never called — breaker blocked it
  });
});

describe("Phase 2 E2E — Checkpoint + Resume", () => {
  test("resumeRun restores conversation from AppState", async () => {
    const dir = tmpDir("paw-e2e-resume-");
    writeFileSync(path.join(dir, "a.txt"), "hello");

    const store = new FileSystemAppStateStore({ statesDir: path.join(dir, ".paw", "states") });
    const model = new FakeLanguageModel({
      responses: [
        { text: '{"action":"final_answer","summary":"First run done."}' },
      ],
    });
    const o = new AgentOrchestrator({
      model,
      appStateStore: store,
      retrySleep: async () => {},
    });

    // First run
    const r1 = await o.run({
      runId: "e2e-resume",
      goal: "read a.txt",
      workspaceRoot: dir,
      maxSteps: 3,
    });
    expect(r1.status).toBe("completed");

    // Verify state was saved
    const saved = store.load("e2e-resume");
    expect(saved).not.toBeNull();
    expect(saved!.goal).toBe("read a.txt");
    expect(saved!.turn).toBeGreaterThan(0);

    // Resume from saved state
    const model2 = new FakeLanguageModel({
      responses: [
        { text: '{"action":"final_answer","summary":"Resumed run done."}' },
      ],
    });
    const o2 = new AgentOrchestrator({
      model: model2,
      appStateStore: store,
      retrySleep: async () => {},
    });
    const r2 = await o2.resumeRun({ runId: "e2e-resume" });
    expect(r2.status).toBe("completed");
    expect(r2.message).toBe("Resumed run done.");
  });

  test("restoreCheckpoint rolls back file changes", async () => {
    const dir = tmpDir("paw-e2e-cp-");
    writeFileSync(path.join(dir, "a.txt"), "original", "utf8");

    const { saveCheckpoint, restoreCheckpoint } = await import(
      "@paw/core"
    );

    saveCheckpoint(dir, "run-cp", 1, "workspace.write_file", {
      path: "a.txt",
      content: "modified",
    });
    writeFileSync(path.join(dir, "a.txt"), "modified", "utf8");

    saveCheckpoint(dir, "run-cp", 2, "workspace.write_file", {
      path: "a.txt",
      content: "modified-again",
    });
    writeFileSync(path.join(dir, "a.txt"), "modified-again", "utf8");

    expect(readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("modified-again");

    // Restore to seq 1
    const restored = restoreCheckpoint(dir, "run-cp", 1);
    expect(restored).not.toBeNull();
    expect(restored!.seq).toBe(1);
    expect(readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("original");

    // Checkpoints 1 and 2 should be removed
    const { listCheckpoints } = await import("@paw/core");
    const remaining = listCheckpoints(dir, "run-cp");
    expect(remaining.length).toBe(0);
  });

  test("run_shell checkpoint saves metadata without file snapshot", async () => {
    const dir = tmpDir("paw-e2e-shell-cp-");

    const { saveCheckpoint } = await import("@paw/core");
    saveCheckpoint(dir, "run-sh", 1, "workspace.run_shell", {
      command: "echo hello > out.txt",
    });

    const metaPath = path.join(
      dir,
      ".paw",
      "checkpoints",
      "run-sh",
      "1",
      ".shell-meta.json",
    );
    expect(existsSync(metaPath)).toBe(true);
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    expect(meta.tool).toBe("workspace.run_shell");
    expect(meta.args.command).toBe("echo hello > out.txt");
    expect(meta.savedAt).toBeDefined();
  });
});
