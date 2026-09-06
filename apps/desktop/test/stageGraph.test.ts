import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LanguageModel, ModelCompletionResult } from "@paw/models";
import { readDesktopMonitor, runDesktopNext } from "../agent-host/paw-next.js";
import type { DesktopMonitorSnapshot } from "../src/agent/monitorTypes.js";

setDefaultTimeout(90_000);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});
const final = (text: string): ModelCompletionResult => ({
  text,
  nativeAssistantContent: text,
  finishReason: "stop",
});
let sequence = 0;
const tool = (
  name: string,
  args: Record<string, unknown>,
): ModelCompletionResult => ({
  text: "",
  nativeAssistantContent: "",
  finishReason: "tool_calls",
  toolCalls: [
    {
      id: `graph-call-${++sequence}`,
      name,
      arguments: args,
      rawArguments: JSON.stringify(args),
      sourceIndex: 0,
      argumentsValid: true,
    },
  ],
});
function fixture(repairConsumers: boolean) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "paw-stage-graph-desktop-"),
  );
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
Paw graph executor. Implement the assigned contract only.
`,
  );
  let managerCalls = 0;
  let auditCalls = 0;
  const executorTurns = new Map<string, number>();
  const snapshots: DesktopMonitorSnapshot[] = [];
  const managerInputs: string[] = [];
  const ref = (tag: string) => {
    const value = snapshots
      .at(-1)
      ?.tasks.find((task) => task.name.startsWith(tag))?.stageRef;
    if (!value) throw new Error(`Missing durable stage reference: ${tag}`);
    return value;
  };
  const plan = (tag: string, requires: string[] = [], replaces?: string) => {
    const file = tag.includes("_A") ? "a.txt" : "b.txt";
    return tool("workspace_delegate", {
      goal: `${tag}: create ${file} using the current interface version`,
      kind: "implementation",
      agent_id: "writer",
      scope: [file],
      acceptance: [`${file} is nonempty and matches the current interface`],
      max_steps: 4,
      stage_links: [
        { task_id: "task", requires, ...(replaces ? { replaces } : {}) },
      ],
    });
  };
  const model: LanguageModel = {
    label: "openai:stage-graph-test",
    capabilities: { contextWindow: 32000, maxOutputTokens: 4096 },
    runtimeProfile: {
      protocol: "openai-compatible",
      model: "stage-graph-test",
      baseUrl: "https://desktop.invalid/v1",
    },
    async complete(messages) {
      const text = JSON.stringify(messages);
      if (text.includes("Paw environment auditor")) {
        auditCalls++;
        const round = Math.ceil(auditCalls / 2);
        const file = round === 1 || round === 3 ? "a.txt" : "b.txt";
        if (auditCalls % 2) return tool("workspace_read_file", { path: file });
        return final(
          JSON.stringify({
            completion: "complete",
            summary: "Read and verified current file",
            evidencePaths: [file],
            unmetCriteria: [],
          }),
        );
      }
      if (text.includes("Paw graph executor")) {
        const goal = messages.find((m) => m.role === "user")?.content ?? "";
        const tag = goal.match(/EXEC_[AB][12]/)?.[0];
        if (!tag) throw new Error("Missing executor contract tag");
        const count = (executorTurns.get(tag) ?? 0) + 1;
        executorTurns.set(tag, count);
        if (count === 1)
          return tool("workspace_write_file", {
            path: tag.includes("_A") ? "a.txt" : "b.txt",
            content: tag.endsWith("2") ? "version-two" : "version-one",
          });
        return final(`Finished ${tag}`);
      }
      managerInputs.push(text);
      managerCalls++;
      if (managerCalls === 1) return plan("EXEC_A1");
      if (managerCalls === 2) return plan("EXEC_B1", [ref("EXEC_A1")]);
      if (managerCalls === 3) return plan("EXEC_A2", [], ref("EXEC_A1"));
      if (managerCalls === 4 && repairConsumers)
        return plan("EXEC_B2", [ref("EXEC_A2")], ref("EXEC_B1"));
      return final("All stages complete; please perform final acceptance.");
    },
  };
  const options = {
    workspaceRoot: root,
    conversationId: "graph",
    taskMode: "long" as const,
    memoryEnabled: false,
    model,
    settings: {},
    resolveToolApproval: async () => true,
    onEvent(envelope: {
      event: { type: string; snapshot?: DesktopMonitorSnapshot };
    }) {
      if (envelope.event.type === "monitor.snapshot" && envelope.event.snapshot)
        snapshots.push(structuredClone(envelope.event.snapshot));
    },
  };
  return {
    root,
    options,
    snapshots,
    managerInputs,
    executorTurns,
    counts: () => ({ managerCalls, auditCalls }),
  };
}

test("desktop invalidates consumers across plans and requires explicit replacement revalidation", async () => {
  const f = fixture(true);
  const result = await runDesktopNext(
    "Build an interface and its consumer, then update both to version two",
    f.options,
  );
  expect(JSON.parse(result.text).acceptance).toBe("verified");
  expect(
    f.snapshots.some((snapshot) =>
      snapshot.tasks.some(
        (task) =>
          task.name.startsWith("EXEC_B1") && task.freshness?.status === "stale",
      ),
    ),
  ).toBeTrue();
  const tasks = readDesktopMonitor(f.root, "graph")?.tasks ?? [];
  expect(tasks.map((task) => task.freshness?.status)).toEqual([
    "superseded",
    "superseded",
    "verified",
    "verified",
  ]);
  expect(tasks[3]?.dependencies).toEqual([tasks[2]?.id as string]);
  expect(
    f.managerInputs.some(
      (text) => text.includes("Stage ledger") && text.includes("stale"),
    ),
  ).toBeTrue();
  expect(fs.readFileSync(path.join(f.root, "b.txt"), "utf8")).toBe(
    "version-two",
  );
  const counts = f.counts();
  await runDesktopNext("", { ...f.options, intent: "recover" });
  expect(f.counts()).toEqual(counts);
  expect(
    readDesktopMonitor(f.root, "graph")?.tasks.map(
      (task) => task.freshness?.status,
    ),
  ).toEqual(tasks.map((task) => task.freshness?.status));
});

test("a successful latest plan cannot hide a stale consumer at final acceptance", async () => {
  const f = fixture(false);
  const result = await runDesktopNext(
    "Build an interface and consumer, then update their version",
    f.options,
  );
  expect(JSON.parse(result.text).acceptance).toBe("unverified");
  expect(f.executorTurns.get("EXEC_B1")).toBe(2);
  expect(f.executorTurns.has("EXEC_B2")).toBeFalse();
  expect(
    readDesktopMonitor(f.root, "graph")?.tasks.find((task) =>
      task.name.startsWith("EXEC_B1"),
    )?.status,
  ).toBe("blocked");
});

test("recovery rechecks external file changes and does not replay completed executors", async () => {
  const f = fixture(true);
  await runDesktopNext(
    "Build an interface and its consumer, then update both",
    f.options,
  );
  fs.writeFileSync(path.join(f.root, "a.txt"), "external edit");
  const turns = [...f.executorTurns];
  const result = await runDesktopNext("", { ...f.options, intent: "recover" });
  expect(JSON.parse(result.text).acceptance).toBe("unverified");
  expect([...f.executorTurns]).toEqual(turns);
  expect(
    readDesktopMonitor(f.root, "graph")?.tasks.filter(
      (task) => task.freshness?.status === "stale",
    ),
  ).toHaveLength(2);
});
