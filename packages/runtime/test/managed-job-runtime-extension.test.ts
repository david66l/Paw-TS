import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import type { ControlReducer, LoopControlState } from "@paw/agent-loop";
import { OFF_SHELL_SANDBOX } from "@paw/harness";
import type { InputFactV1 } from "@paw/protocol";

import {
  RuntimeManagedJobControllerV1,
  projectRuntimeActivitiesV1,
  withRuntimeActivityControlV1,
} from "../src/index.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("managed Job runtime extension", () => {
  test("commits start before returning and wakes only after terminal fact", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-job-extension-"));
    roots.push(root);
    fs.writeFileSync(
      path.join(root, "job.mjs"),
      "setTimeout(() => process.stdout.write('done'), 30);\n",
    );
    const facts: InputFactV1[] = [];
    let wakes = 0;
    const controller = new RuntimeManagedJobControllerV1({
      runId: "run-1",
      workspaceRoot: root,
      shellSandbox: OFF_SHELL_SANDBOX,
      factRecorder: {
        async record(batch) {
          facts.push(...batch);
        },
      },
      wakeExternal: () => {
        wakes += 1;
      },
    });

    const started = await controller.startShell({
      command: `${JSON.stringify(process.execPath)} job.mjs`,
    });
    expect(started.jobId).toBe("shell-1");
    expect(facts.map((fact) => fact.type)).toEqual([
      "runtime.activity_started",
    ]);

    const waited = await controller.wait(started.jobId, 5_000);
    expect(waited.timedOut).toBe(false);
    await controller.close();
    expect(facts.map((fact) => fact.type)).toEqual([
      "runtime.activity_started",
      "runtime.activity_settled",
    ]);
    expect(projectRuntimeActivitiesV1(facts).active).toHaveLength(0);
    expect(wakes).toBe(1);
  });

  test("recovers a pre-crash active job as unknown without reattaching its PID", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-job-recovery-"));
    roots.push(root);
    const recorded: InputFactV1[] = [];
    const started: InputFactV1 = {
      type: "runtime.activity_started",
      activityId: "shell-7",
      activityKind: "managed_job",
      label: "old command",
      startedAt: 10,
      metadata: { pid: 123 },
    };
    const controller = new RuntimeManagedJobControllerV1({
      runId: "run-1",
      workspaceRoot: root,
      shellSandbox: OFF_SHELL_SANDBOX,
      resumeFacts: [started],
      clock: () => 20,
      factRecorder: {
        async record(batch) {
          recorded.push(...batch);
        },
      },
    });

    await controller.recoverInterrupted();
    expect(recorded).toEqual([
      {
        type: "runtime.activity_settled",
        activityId: "shell-7",
        status: "unknown",
        settledAt: 20,
        summary:
          "Paw restarted before this job's terminal effect was durably committed; the old PID was not reattached.",
      },
    ]);
    expect(controller.read("shell-7").snapshot.status).toBe(
      "interrupted_orphaned",
    );
    await controller.close();
  });

  test("blocks completion while active and forces one turn for a new settlement", () => {
    interface State extends LoopControlState {
      readonly marker: 1;
    }
    const base: ControlReducer<InputFactV1, object, State> = {
      reduce: () => ({
        marker: 1,
        decision: { kind: "completed", reason: "done" },
      }),
    };
    const reducer = withRuntimeActivityControlV1(base);
    const started: InputFactV1 = {
      type: "runtime.activity_started",
      activityId: "shell-1",
      activityKind: "managed_job",
      label: "build",
      startedAt: 1,
    };
    const settled: InputFactV1 = {
      type: "runtime.activity_settled",
      activityId: "shell-1",
      status: "completed",
      settledAt: 2,
      summary: "exit code 0",
    };

    expect(reducer.reduce([started], {}).decision.kind).toBe("await_external");
    expect(reducer.reduce([started, settled], {}).decision.kind).toBe(
      "continue",
    );
    expect(
      reducer.reduce(
        [
          started,
          settled,
          {
            type: "model.dispatch_recorded",
            modelCallId: "model-2",
            turn: 2,
            requestHash: "hash",
          },
        ],
        {},
      ).decision.kind,
    ).toBe("completed");
  });
});
