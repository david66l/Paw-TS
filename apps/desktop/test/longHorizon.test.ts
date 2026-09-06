import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ChatMessage,
  LanguageModel,
  ModelCompletionResult,
} from "@paw/models";
import { DesktopNextControls } from "../agent-host/paw-next-controls.js";
import { readDesktopMonitor, runDesktopNext } from "../agent-host/paw-next.js";

setDefaultTimeout(60_000);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});
let sequence = 0;
const final = (text: string): ModelCompletionResult => ({
  text,
  nativeAssistantContent: text,
  finishReason: "stop",
});
const tool = (
  name: string,
  args: Record<string, unknown>,
): ModelCompletionResult => ({
  text: "",
  nativeAssistantContent: "",
  finishReason: "tool_calls",
  toolCalls: [
    {
      id: `long-call-${++sequence}`,
      name,
      arguments: args,
      rawArguments: JSON.stringify(args),
      sourceIndex: 0,
      argumentsValid: true,
    },
  ],
});
function fixture(block = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-long-task-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, ".paw", "agents"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".paw", "agents", "writer.md"),
    `---
id: writer
name: Writer
role: code implementation
capabilities: implementation
tools: read_file, write_file
childPolicy: read_write
model: inherit
outputFormat: Return changed files and verification evidence.
canSpawn: false
maxSteps: 4
kind: worker
---
Paw stage executor. Implement only the assigned file.
`,
  );
  let managerCalls = 0;
  let auditCalls = 0;
  const executorInputs: string[] = [];
  const executorTurns = new Map<string, number>();
  const stage = (id: string, file: string, depends_on: string[] = []) => ({
    id,
    goal: `Create ${file} containing checked; ${id}`,
    kind: "implementation",
    agent_id: "writer",
    scope: [file],
    acceptance: [`${file} contains checked`],
    max_steps: 4,
    depends_on,
  });
  const model: LanguageModel = {
    label: "openai:long-test",
    capabilities: { contextWindow: 32000, maxOutputTokens: 4096 },
    runtimeProfile: {
      protocol: "openai-compatible",
      model: "long-test",
      baseUrl: "https://desktop.invalid/v1",
    },
    async complete(messages: readonly ChatMessage[]) {
      const text = JSON.stringify(messages);
      if (text.includes("Paw environment auditor")) {
        auditCalls++;
        if (block)
          return final(
            JSON.stringify({
              completion: "complete",
              summary: "Unsupported success",
              evidencePaths: ["one.txt"],
              unmetCriteria: [],
            }),
          );
        const file = text.includes("SECOND_STAGE") ? "two.txt" : "one.txt";
        if (auditCalls % 2 === 1)
          return tool("workspace_read_file", { path: file });
        return final(
          JSON.stringify({
            completion: "complete",
            summary: "Actual file checked",
            evidencePaths: [file],
            unmetCriteria: [],
          }),
        );
      }
      if (text.includes("Paw stage executor")) {
        executorInputs.push(text);
        const stage = text.includes("SECOND_STAGE") ? "second" : "first";
        const turn = (executorTurns.get(stage) ?? 0) + 1;
        executorTurns.set(stage, turn);
        if (turn === 1)
          return tool("workspace_write_file", {
            path: text.includes("SECOND_STAGE") ? "two.txt" : "one.txt",
            content: "checked",
          });
        return final(
          text.includes("SECOND_STAGE")
            ? "Second stage done"
            : "first-executor-trace-secret",
        );
      }
      managerCalls++;
      if (managerCalls === 1)
        return tool("workspace_delegate", {
          goal: "Create two files",
          kind: "implementation",
          tasks: [
            stage("FIRST_STAGE", "one.txt"),
            stage("SECOND_STAGE", "two.txt", ["FIRST_STAGE"]),
          ],
        });
      return final("阶段已执行，等待最终验收。");
    },
  };
  const options = {
    workspaceRoot: root,
    conversationId: "managed",
    taskMode: "long" as const,
    memoryEnabled: false,
    settings: {},
    model,
    resolveToolApproval: async () => true,
    onEvent() {},
  };
  return {
    root,
    options,
    model,
    executorInputs,
    counts: () => ({ managerCalls, auditCalls }),
  };
}

test("long-task manager runs isolated stages, audits dependencies, and recovers without repeating execution", async () => {
  const f = fixture();
  const result = await runDesktopNext(
    "Create one.txt and two.txt containing checked",
    f.options,
  );
  expect(JSON.parse(result.text)).toMatchObject({
    status: "completed",
    acceptance: "verified",
  });
  expect(fs.readFileSync(path.join(f.root, "two.txt"), "utf8")).toBe("checked");
  const second = f.executorInputs.filter((text) =>
    text.includes("SECOND_STAGE"),
  );
  expect(second.length).toBe(2);
  // Only the bounded dependency result is shared; the first executor's tool trace is absent.
  expect(second[0]).not.toContain('"path":"one.txt","content":"checked"');
  expect(f.counts().auditCalls).toBe(6);
  expect(
    readDesktopMonitor(f.root, "managed")?.tasks.filter(
      (task) => task.audit?.status === "verified",
    ).length,
  ).toBe(2);
  const before = f.counts();
  await runDesktopNext("Create one.txt and two.txt containing checked", {
    ...f.options,
    intent: "recover",
    taskMode: "standard",
  });
  expect(f.counts()).toEqual(before);
});

test("unverified stage blocks dependent execution even when the executor claimed success", async () => {
  const f = fixture(true);
  const result = await runDesktopNext(
    "Create one.txt and two.txt containing checked",
    f.options,
  );
  expect(JSON.parse(result.text)).toMatchObject({
    status: "incomplete",
    acceptance: "unverified",
  });
  expect(fs.existsSync(path.join(f.root, "two.txt"))).toBe(false);
  expect(f.executorInputs.some((text) => text.includes("SECOND_STAGE"))).toBe(
    false,
  );
  expect(
    readDesktopMonitor(f.root, "managed")?.tasks.some(
      (task) => task.status === "blocked",
    ),
  ).toBe(true);
});

test("manager cannot execute direct writes even when all executor approvals are allowed", async () => {
  const f = fixture();
  let calls = 0;
  const result = await runDesktopNext("Write forbidden.txt", {
    ...f.options,
    model: {
      ...f.model,
      async complete() {
        if (++calls === 1)
          return tool("workspace_write_file", {
            path: "forbidden.txt",
            content: "bad",
          });
        return final("Cannot perform that direct write");
      },
    },
  });
  expect(result.ok).toBe(false);
  expect(fs.existsSync(path.join(f.root, "forbidden.txt"))).toBe(false);
});

test("accepted live requirements stop the remaining old plan and reach the Manager", async () => {
  const f = fixture();
  const controls = new DesktopNextControls();
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = false;
  const requests: string[] = [];
  const running = runDesktopNext(
    "Create one.txt and two.txt containing checked",
    {
      ...f.options,
      controls,
      model: {
        ...f.model,
        async complete(messages, options) {
          const text = JSON.stringify(messages);
          requests.push(text);
          if (
            !held &&
            text.includes("Paw stage executor") &&
            !text.includes("Paw environment auditor")
          ) {
            held = true;
            enter();
            await gate;
          }
          return f.model.complete(messages, options);
        },
      },
    },
  );
  await entered;
  try {
    expect(
      (
        await controls.submit(
          "changed-goal",
          "只保留 one.txt，不要创建 two.txt",
        )
      ).status,
    ).toBe("accepted");
  } finally {
    release();
  }
  await running;
  expect(fs.existsSync(path.join(f.root, "two.txt"))).toBe(false);
  expect(
    requests.some(
      (text) =>
        text.includes("Paw long-task Manager") &&
        text.includes("只保留 one.txt"),
    ),
  ).toBe(true);
  expect(f.executorInputs.length).toBe(2);
});

test("Manager repairs an unverified stage using a fresh executor before final acceptance", async () => {
  const f = fixture();
  let rootCalls = 0;
  let rejected = false;
  const repairInputs: string[] = [];
  const result = await runDesktopNext(
    "Create one.txt and two.txt containing checked",
    {
      ...f.options,
      model: {
        ...f.model,
        async complete(messages, options) {
          const text = JSON.stringify(messages);
          if (text.includes("Paw environment auditor")) {
            const response = await f.model.complete(messages, options);
            if (!rejected && response.finishReason === "stop") {
              rejected = true;
              return final(
                JSON.stringify({
                  completion: "incomplete",
                  summary: "Needs a separate recheck",
                  evidencePaths: ["one.txt"],
                  unmetCriteria: ["Recheck the first stage before proceeding"],
                }),
              );
            }
            return response;
          }
          if (text.includes("Paw stage executor")) {
            if (text.includes("FRESH_REPAIR") && !text.includes("SECOND_STAGE"))
              repairInputs.push(text);
            return f.model.complete(messages, options);
          }
          if (++rootCalls === 2)
            return tool("workspace_delegate", {
              goal: "Repair and finish",
              kind: "implementation",
              stage_links: [
                {
                  task_id: "repair",
                  requires: [],
                  replaces: readDesktopMonitor(f.root, "managed")?.tasks.find(
                    (task) => task.name.includes("FIRST_STAGE"),
                  )?.stageRef,
                },
              ],
              tasks: [
                {
                  id: "repair",
                  goal: "FRESH_REPAIR: recheck one.txt contains checked",
                  kind: "implementation",
                  agent_id: "writer",
                  scope: ["one.txt"],
                  acceptance: ["one.txt contains checked"],
                  max_steps: 4,
                },
                {
                  id: "next",
                  goal: "SECOND_STAGE: create two.txt containing checked",
                  kind: "implementation",
                  agent_id: "writer",
                  scope: ["two.txt"],
                  acceptance: ["two.txt contains checked"],
                  depends_on: ["repair"],
                  max_steps: 4,
                },
              ],
            });
          return f.model.complete(messages, options);
        },
      },
    },
  );
  expect(JSON.parse(result.text).acceptance).toBe("verified");
  expect(repairInputs.length).toBe(1);
  expect(repairInputs[0]).not.toContain("first-executor-trace-secret");
  expect(fs.readFileSync(path.join(f.root, "two.txt"), "utf8")).toBe("checked");
});

test("process death between verified stages resumes the outstanding mission without rewriting the first stage", async () => {
  const resume = fixture();
  const script = path.join(resume.root, "crash-stages.ts");
  const source = `import fs from "node:fs"; import os from "node:os"; import path from "node:path";
    import { runDesktopNext } from ${JSON.stringify(new URL("../agent-host/paw-next.ts", import.meta.url).href)};
    const roots = []; let sequence = 0;
    const final = ${final.toString()}; const tool = ${tool.toString()}; const fixture = ${fixture.toString()};
    const f = fixture(); fs.writeSync(1, "FIXTURE " + JSON.stringify(f.root) + "\\n");
    await runDesktopNext("Create one.txt and two.txt containing checked", { ...f.options,
      onEvent(envelope) { if (envelope.event.type === "monitor.snapshot" && envelope.event.snapshot.tasks.some(task => task.audit?.status === "verified")) process.exit(91); }
    }); process.exit(92);`;
  fs.writeFileSync(script, source);
  const processHandle = Bun.spawn([process.execPath, script], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(processHandle.stdout).text();
  const stderr = new Response(processHandle.stderr).text();
  const timer = setTimeout(() => processHandle.kill(), 20_000);
  let exitCode: number;
  try {
    exitCode = await processHandle.exited;
  } finally {
    clearTimeout(timer);
  }
  const line = (await stdout)
    .split(/\r?\n/)
    .find((line) => line.startsWith("FIXTURE "));
  if (!line) throw new Error(await stderr);
  const workspace: string = JSON.parse(line.slice(8));
  if (
    path.dirname(workspace) !== fs.realpathSync(os.tmpdir()) ||
    !path.basename(workspace).startsWith("paw-long-task-")
  )
    throw new Error("Unexpected test workspace");
  roots.push(workspace);
  expect(exitCode).toBe(91);
  const originalMtime = fs.statSync(path.join(workspace, "one.txt")).mtimeMs;
  expect(fs.existsSync(path.join(workspace, "two.txt"))).toBe(false);
  const now = () => Date.now() + 100_000;
  const result = await runDesktopNext(
    "Create one.txt and two.txt containing checked",
    {
      ...resume.options,
      workspaceRoot: workspace,
      intent: "recover",
      leaseScheduler: {
        now,
        scheduleAt(deadline, task) {
          const timer = setTimeout(task, Math.max(0, deadline - now()));
          return { cancel: () => clearTimeout(timer) };
        },
      },
      model: {
        ...resume.model,
        async complete(messages, options) {
          const text = JSON.stringify(messages);
          if (
            text.includes("Paw environment auditor") ||
            text.includes("Paw stage executor")
          )
            return resume.model.complete(messages, options);
          return final("Recovered stages complete");
        },
      },
    },
  );
  expect(JSON.parse(result.text)).toMatchObject({
    status: "completed",
    acceptance: "verified",
  });
  expect(fs.statSync(path.join(workspace, "one.txt")).mtimeMs).toBe(
    originalMtime,
  );
  expect(fs.readFileSync(path.join(workspace, "two.txt"), "utf8")).toBe(
    "checked",
  );
  expect(resume.executorInputs.length).toBe(2);
});
