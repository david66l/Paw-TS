import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ExecutionEnvironmentRegistryV1 } from "../src/execution-environment.js";
import type { ToolEffectPolicy } from "../src/execution-policy.js";
import { ManagedJobControllerV1 } from "../src/managed-job-controller.js";
import { TaskStateManager } from "../src/task-state.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function runGit(root: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
}

function gitFixture(name: string): string {
  const root = mkdtempSync(path.join(tmpdir(), `paw-job-controller-${name}-`));
  roots.push(root);
  runGit(root, "init");
  runGit(root, "config", "user.email", "paw@example.invalid");
  runGit(root, "config", "user.name", "Paw Test");
  writeFileSync(path.join(root, "tracked.txt"), "before\n", "utf8");
  runGit(root, "add", "tracked.txt");
  runGit(root, "commit", "-m", "fixture");
  return root;
}

function runtimeCommand(script: string): string {
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;
}

function environment(root: string, runId: string) {
  return new ExecutionEnvironmentRegistryV1({
    runId,
    workspaceRoot: root,
    shellSandbox: {
      mode: "off",
      network: "deny",
      image: "debian:bookworm-slim",
    },
  });
}

describe("ManagedJobControllerV1", () => {
  test("commits asynchronous workspace effects only after settlement and exactly once", async () => {
    const root = gitFixture("settle");
    writeFileSync(
      path.join(root, "mutate.mjs"),
      "import { writeFileSync } from 'node:fs'; setTimeout(() => writeFileSync('generated.txt', 'done\\n'), 120);\n",
      "utf8",
    );
    // The fixture script is infrastructure, not part of the job's observed delta.
    runGit(root, "add", "mutate.mjs");
    runGit(root, "commit", "-m", "add runner");

    const controller = new ManagedJobControllerV1({
      ownerId: "run-settle",
      workspaceRoot: root,
    });
    const taskState = new TaskStateManager("run background mutation");
    const executionEnvironment = environment(root, "run-settle");
    const before = taskState.snapshot();

    const started = await controller.startShell({
      turn: 3,
      command: runtimeCommand("mutate.mjs"),
    });
    expect(controller.list()[0]).toMatchObject({
      id: started.jobId,
      status: "running",
    });
    expect(taskState.snapshot()).toEqual(before);
    expect(executionEnvironment.snapshot().events).toEqual([]);

    const waited = await controller.wait(started.jobId, 5_000);
    expect(waited.snapshot.status).toBe("completed");
    expect(existsSync(path.join(root, "generated.txt"))).toBe(true);
    // Process completion alone does not mutate loop state at an arbitrary point.
    expect(taskState.snapshot()).toEqual(before);

    const drained = controller.drainSettlements({
      taskState,
      executionEnvironment,
    });
    expect(drained).toHaveLength(1);
    expect(drained[0]?.result.payload).toMatchObject({
      effect_audit: "complete",
      workspaceEffect: { changed: true, paths: ["generated.txt"] },
    });
    expect(taskState.snapshot()).toMatchObject({
      mutationRevision: 1,
      filesChanged: ["generated.txt"],
    });
    expect(executionEnvironment.snapshot().events[0]).toMatchObject({
      type: "shell.completed",
      turn: 3,
      ok: true,
    });
    expect(
      controller.drainSettlements({ taskState, executionEnvironment }),
    ).toEqual([]);
    expect(taskState.snapshot().mutationRevision).toBe(1);
    await controller.close();
  });

  test("settles effect policy after the process and exposes recovery as failure", async () => {
    const root = gitFixture("effect-policy");
    writeFileSync(
      path.join(root, "mutate.mjs"),
      "import { writeFileSync } from 'node:fs'; writeFileSync('tracked.txt', 'after\\n');\n",
      "utf8",
    );
    runGit(root, "add", "mutate.mjs");
    runGit(root, "commit", "-m", "add runner");
    let settleSawMutation = false;
    const effectPolicy: ToolEffectPolicy = {
      appliesTo: ({ tool }) => tool === "workspace.run_shell",
      prepare: () => readFileSync(path.join(root, "tracked.txt"), "utf8"),
      settle: (_input, prepared) => {
        settleSawMutation =
          readFileSync(path.join(root, "tracked.txt"), "utf8") === "after\n";
        writeFileSync(path.join(root, "tracked.txt"), String(prepared), "utf8");
        return {
          allowed: false,
          reason: "fixture_rejected",
          message: "restored prohibited effect",
          recovered: true,
        };
      },
    };
    const controller = new ManagedJobControllerV1({
      ownerId: "run-effect-policy",
      workspaceRoot: root,
      toolEffectPolicy: effectPolicy,
    });
    const taskState = new TaskStateManager("reject background mutation");
    const executionEnvironment = environment(root, "run-effect-policy");

    const started = await controller.startShell({
      turn: 4,
      command: runtimeCommand("mutate.mjs"),
    });
    const waited = await controller.wait(started.jobId, 5_000);
    expect(waited.snapshot).toMatchObject({
      status: "failed",
      detail: "[ToolEffectPolicy:fixture_rejected] restored prohibited effect",
    });
    expect(settleSawMutation).toBe(true);
    expect(readFileSync(path.join(root, "tracked.txt"), "utf8")).toBe(
      "before\n",
    );

    const [settled] = controller.drainSettlements({
      taskState,
      executionEnvironment,
    });
    expect(settled?.result).toMatchObject({
      ok: false,
      payload: { recovered: true },
    });
    expect(taskState.snapshot().mutationRevision).toBe(0);
    expect(executionEnvironment.snapshot().events[0]).toMatchObject({
      ok: false,
      failureKind: "infrastructure",
    });
    await controller.close();
  });

  test("execution-policy rejection starts neither process nor registry entry", async () => {
    const root = gitFixture("execution-policy");
    writeFileSync(
      path.join(root, "mutate.mjs"),
      "import { writeFileSync } from 'node:fs'; writeFileSync('forbidden.txt', 'x');\n",
      "utf8",
    );
    const controller = new ManagedJobControllerV1({
      ownerId: "run-denied",
      workspaceRoot: root,
      toolExecutionPolicy: () => ({
        allowed: false,
        reason: "fixture_denied",
        message: "do not start",
      }),
    });

    await expect(
      controller.startShell({
        turn: 0,
        command: runtimeCommand("mutate.mjs"),
      }),
    ).rejects.toThrow("[ToolExecutionPolicy:fixture_denied] do not start");
    expect(controller.list()).toEqual([]);
    expect(existsSync(path.join(root, "forbidden.txt"))).toBe(false);
    await controller.close();
  });

  test("restores unresolved jobs as orphaned metadata and never reuses their ids", async () => {
    const root = gitFixture("recovery");
    writeFileSync(
      path.join(root, "quick.mjs"),
      "process.stdout.write('ok\\n');\n",
      "utf8",
    );
    const controller = new ManagedJobControllerV1({
      ownerId: "run-recovery",
      workspaceRoot: root,
      resumeProjection: {
        schemaVersion: "paw.managed-job-projection.v1",
        runId: "run-recovery",
        jobs: [
          {
            id: "shell-3",
            kind: "shell",
            label: "old verification",
            status: "running",
            startedAt: 10,
            reported: false,
          },
        ],
        savedAt: 20,
      },
    });

    expect(controller.list()[0]).toMatchObject({
      id: "shell-3",
      status: "interrupted_orphaned",
      reported: false,
    });
    expect(controller.read("shell-3")).toMatchObject({
      text: expect.stringContaining("old PID was not reattached"),
      snapshot: { status: "interrupted_orphaned", reported: true },
    });
    expect(controller.kill("shell-3")).toBe("already_finished");
    expect(controller.readiness().blocksCompletion).toBe(false);
    expect(controller.recoveryIssues()).toEqual([
      "managed_job_interrupted_orphaned",
    ]);

    const started = await controller.startShell({
      turn: 1,
      command: runtimeCommand("quick.mjs"),
    });
    expect(started.jobId).toBe("shell-4");
    await controller.wait(started.jobId, 5_000);
    const projection = controller.projection();
    expect(projection.jobs.find((job) => job.id === "shell-3")).toMatchObject({
      status: "interrupted_orphaned",
      settlementState: "pending",
    });
    expect(projection.jobs.find((job) => job.id === "shell-4")).toMatchObject({
      status: "completed",
      settlementState: "pending",
    });
    await controller.close();
  });
});
