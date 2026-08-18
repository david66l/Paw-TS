import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { InMemoryAppStateStore, type RunEventEnvelope } from "@paw/core";

import { AgentOrchestrator } from "../src/orchestrator.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(name: string, delayMs: number): string {
  const root = mkdtempSync(path.join(tmpdir(), `paw-job-loop-${name}-`));
  roots.push(root);
  writeFileSync(
    path.join(root, "background.mjs"),
    `setTimeout(() => process.stdout.write('background-ready\\n'), ${delayMs});\n`,
    "utf8",
  );
  mkdirSync(path.join(root, ".paw"));
  writeFileSync(
    path.join(root, ".paw", "memory-config.json"),
    '{"enable":false}',
    { encoding: "utf8", flag: "w" },
  );
  return root;
}

function command(): string {
  return `${JSON.stringify(process.execPath)} ${JSON.stringify("background.mjs")}`;
}

describe("managed jobs in the real agent loop", () => {
  test("runs, observes and commits a background command without blocking the model turn", async () => {
    const root = fixture("complete", 150);
    const events: RunEventEnvelope[] = [];
    const approvals: Array<{ tool: string; args: unknown }> = [];
    const policyTools: string[] = [];
    const stateStore = new InMemoryAppStateStore();
    let calls = 0;
    let settlementVisible = false;
    const orchestrator = new AgentOrchestrator({
      appStateStore: stateStore,
      memoryExtraction: "off",
      memoryLlm: "off",
      retrySleep: async () => {},
      resolveToolApproval: async (input) => {
        approvals.push(input);
        return true;
      },
      toolExecutionPolicy: ({ tool }) => {
        policyTools.push(tool);
        return { allowed: true };
      },
      onEvent: (event) => events.push(event),
      model: {
        label: "managed-job-loop-fixture",
        async complete(messages) {
          calls += 1;
          if (calls === 4) {
            settlementVisible = messages.some(
              (message) =>
                message.role === "user" &&
                message.content.includes("managed shell shell-1") &&
                message.content.includes("effect_audit"),
            );
          }
          if (calls === 1) {
            return {
              text: JSON.stringify({
                tool: "workspace.job_start",
                args: { command: command() },
              }),
            };
          }
          if (calls === 2) {
            return { text: '{"tool":"workspace.job_list","args":{}}' };
          }
          if (calls === 3) {
            return {
              text: '{"tool":"workspace.job_wait","args":{"id":"shell-1","timeout_sec":2}}',
            };
          }
          if (calls === 4) {
            return {
              text: '{"tool":"workspace.job_read","args":{"id":"shell-1"}}',
            };
          }
          return {
            text: '{"action":"final_answer","summary":"Background command completed and output was collected."}',
          };
        },
      },
    });

    const result = await orchestrator.run({
      runId: "managed-job-complete",
      goal: "Run the supplied background command, collect its output, and report when it finishes.",
      workspaceRoot: root,
      maxSteps: 7,
    });

    expect(result.status).toBe("completed");
    expect(calls).toBe(5);
    expect(settlementVisible).toBe(true);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.tool).toBe("workspace.job_start");
    expect(policyTools).toContain("workspace.run_shell");
    expect(policyTools).not.toContain("workspace.job_start");
    const settledIndex = events.findIndex(
      (event) => event.event.type === "job.settled",
    );
    const completedIndex = events.findIndex(
      (event) => event.event.type === "run.completed",
    );
    expect(settledIndex).toBeGreaterThan(-1);
    expect(settledIndex).toBeLessThan(completedIndex);
    const saved = stateStore.load("managed-job-complete");
    expect(saved?.executionEnvironment).toMatchObject({
      backgroundJobs: {
        capability: "managed",
        managed: 1,
        running: 0,
        pendingSettlements: 0,
      },
    });
  });

  test("rejects a premature final answer until the live job settles", async () => {
    const root = fixture("premature-final", 700);
    let calls = 0;
    let sawCompletionNudge = false;
    let sawStaleControlAfterSettlement = false;
    const stateStore = new InMemoryAppStateStore();
    const events: RunEventEnvelope[] = [];
    const orchestrator = new AgentOrchestrator({
      appStateStore: stateStore,
      memoryExtraction: "off",
      memoryLlm: "off",
      retrySleep: async () => {},
      onEvent: (event) => events.push(event),
      model: {
        label: "managed-job-completion-gate-fixture",
        async complete(messages) {
          calls += 1;
          if (calls === 3) {
            sawCompletionNudge = messages.some(
              (message) =>
                message.role === "user" &&
                message.content.includes("Managed jobs are unfinished"),
            );
          }
          if (calls === 4) {
            sawStaleControlAfterSettlement = messages.some((message) =>
              message.content.includes("gate: managed_jobs"),
            );
          }
          if (calls === 1) {
            return {
              text: JSON.stringify({
                tool: "workspace.job_start",
                args: { command: command() },
              }),
            };
          }
          if (calls === 2) {
            return {
              text: '{"action":"final_answer","summary":"Done too early."}',
            };
          }
          if (calls === 3) {
            return {
              text: '{"tool":"workspace.job_wait","args":{"id":"shell-1","timeout_sec":2}}',
            };
          }
          return {
            text: '{"action":"final_answer","summary":"The managed job is settled."}',
          };
        },
      },
    });

    const result = await orchestrator.run({
      runId: "managed-job-premature-final",
      goal: "Wait for a managed background command before reporting completion.",
      workspaceRoot: root,
      maxSteps: 6,
    });

    expect(result.status).toBe("completed");
    expect(calls).toBe(4);
    expect(sawCompletionNudge).toBe(true);
    expect(sawStaleControlAfterSettlement).toBe(false);
    expect(result.message).not.toContain("Done too early");
    expect(events.some((event) => event.event.type === "job.settled")).toBe(
      true,
    );
    expect(
      stateStore
        .load("managed-job-premature-final")
        ?.messages.some((message) =>
          message.content.startsWith("[Managed jobs are unfinished:"),
        ),
    ).toBe(false);
  });

  test("persists live jobs and resumes them as interrupted_orphaned instead of reattaching a pid", async () => {
    const root = fixture("resume", 30_000);
    const stateStore = new InMemoryAppStateStore();
    let firstCalls = 0;
    const first = new AgentOrchestrator({
      appStateStore: stateStore,
      memoryExtraction: "off",
      memoryLlm: "off",
      retrySleep: async () => {},
      model: {
        label: "managed-job-before-crash-fixture",
        async complete() {
          firstCalls += 1;
          return firstCalls === 1
            ? {
                text: JSON.stringify({
                  tool: "workspace.job_start",
                  args: { command: command() },
                }),
              }
            : {
                text: '{"action":"final_answer","summary":"Pretend the live job finished."}',
              };
        },
      },
    });
    const firstResult = await first.run({
      runId: "managed-job-resume",
      goal: "Start a long background command and only finish after its trustworthy result is available.",
      workspaceRoot: root,
      maxSteps: 4,
    });
    expect(firstResult).toMatchObject({
      status: "incomplete",
      completionReason: "background_jobs_unsettled",
    });
    const interruptedState = stateStore.load("managed-job-resume");
    expect(interruptedState?.managedJobs).toMatchObject({
      schemaVersion: "paw.managed-job-projection.v1",
      jobs: [{ id: "shell-1", status: "running" }],
    });

    const events: RunEventEnvelope[] = [];
    let resumedCalls = 0;
    let sawRecoveryNotice = false;
    let sawOrphanedList = false;
    const resumed = new AgentOrchestrator({
      appStateStore: stateStore,
      memoryExtraction: "off",
      memoryLlm: "off",
      retrySleep: async () => {},
      onEvent: (event) => events.push(event),
      model: {
        label: "managed-job-after-crash-fixture",
        async complete(messages) {
          resumedCalls += 1;
          sawRecoveryNotice ||= messages.some(
            (message) =>
              message.role === "user" &&
              message.content.includes("Managed job recovery v1") &&
              message.content
                .toLowerCase()
                .includes("old pids were not reattached"),
          );
          sawOrphanedList ||= messages.some(
            (message) =>
              message.role === "user" &&
              message.content.includes("interrupted_orphaned"),
          );
          return resumedCalls === 1
            ? { text: '{"tool":"workspace.job_list","args":{}}' }
            : {
                text: '{"action":"final_answer","summary":"The prior job was interrupted; no result was trusted and verification must be rerun."}',
              };
        },
      },
    });
    const resumedResult = await resumed.run({
      runId: "managed-job-resume",
      goal: interruptedState?.goal ?? "Inspect the interrupted job.",
      workspaceRoot: root,
      maxSteps: 12,
      ...(interruptedState ? { resumeFromState: interruptedState } : {}),
    });

    expect(resumedResult.status).toBe("completed");
    expect(sawRecoveryNotice).toBe(true);
    expect(sawOrphanedList).toBe(true);
    expect(events.some((event) => event.event.type === "job.recovery")).toBe(
      true,
    );
    const saved = stateStore.load("managed-job-resume");
    expect(saved?.executionEnvironment).toMatchObject({
      recovery: {
        compatible: false,
        issues: ["managed_job_interrupted_orphaned"],
      },
      backgroundJobs: { running: 0 },
    });
    expect(saved?.taskState).toMatchObject({
      executionEnvironmentRevision: 1,
      executionEnvironmentIssues: ["managed_job_interrupted_orphaned"],
    });
  });
});
