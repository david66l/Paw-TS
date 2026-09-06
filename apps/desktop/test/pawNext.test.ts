import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RunEventEnvelope } from "@paw/core";
import type {
  ChatMessage,
  LanguageModel,
  ModelCompletionResult,
} from "@paw/models";
import { DesktopNextControls } from "../agent-host/paw-next-controls.js";
import { DesktopNextEvents } from "../agent-host/paw-next-events.js";
import {
  desktopCheckpointNamespace,
  readDesktopMonitor,
  runDesktopNext as runDesktopNextWithAudit,
} from "../agent-host/paw-next.js";

const runDesktopNext: typeof runDesktopNextWithAudit = (goal, options) =>
  runDesktopNextWithAudit(goal, { environmentAudit: false, ...options });

setDefaultTimeout(30_000);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (
      !path
        .resolve(root)
        .startsWith(path.join(os.tmpdir(), "paw-desktop-next-"))
    )
      throw new Error("Unsafe fixture path");
    fs.rmSync(root, { recursive: true, force: true });
  }
});
function root() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paw-desktop-next-"));
  roots.push(dir);
  return dir;
}
function model(
  responses: ModelCompletionResult[],
  requests: string[] = [],
): LanguageModel {
  let index = 0;
  return {
    label: "openai:desktop-test",
    capabilities: { contextWindow: 32_000, maxOutputTokens: 4096 },
    runtimeProfile: {
      protocol: "openai-compatible",
      model: "desktop-test",
      baseUrl: "https://desktop.invalid/v1",
    },
    async complete(messages: readonly ChatMessage[]) {
      requests.push(JSON.stringify(messages));
      return responses[index++] ?? final("Done");
    },
  };
}
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
      id: "call-1",
      name,
      arguments: args,
      rawArguments: JSON.stringify(args),
      sourceIndex: 0,
      argumentsValid: true,
    },
  ],
});

test("desktop runs V3 and continues a durable conversation with prior model context", async () => {
  const workspaceRoot = root();
  const events: RunEventEnvelope[] = [];
  const requests: string[] = [];
  const options = {
    workspaceRoot,
    conversationId: "chat",
    memoryEnabled: false,
    settings: {},
    resolveToolApproval: async () => true,
    onEvent: (event: RunEventEnvelope) => events.push(event),
  };
  const first = await runDesktopNext("Remember the project is named Iris", {
    ...options,
    model: model([final("Iris noted")]),
  });
  const second = await runDesktopNext("What is the project name?", {
    ...options,
    model: model([final("Iris")], requests),
  });
  expect(first.ok).toBe(true);
  expect(second.ok).toBe(true);
  expect(JSON.parse(first.text).runId).toBe(JSON.parse(second.text).runId);
  expect(requests[0]).toContain("Iris noted");
  expect(events.some((e) => e.event.type === "run.completed")).toBe(true);
  expect(
    desktopCheckpointNamespace(workspaceRoot, JSON.parse(first.text).runId),
  ).toStartWith("pawnextv1_");
});

test("denied desktop approval cannot write a file", async () => {
  const workspaceRoot = root();
  const prompts: string[] = [];
  const events: RunEventEnvelope[] = [];
  const result = await runDesktopNext("Create denied.txt", {
    workspaceRoot,
    memoryEnabled: false,
    settings: {},
    model: model([
      tool("workspace_write_file", {
        path: "denied.txt",
        content: "forbidden",
      }),
      final("Write was denied"),
    ]),
    resolveToolApproval: async (input) => {
      prompts.push(input.tool);
      return false;
    },
    onEvent: (event) => events.push(event),
  });
  expect(result.ok).toBe(true);
  expect(prompts).toEqual(["workspace.write_file"]);
  expect(JSON.parse(result.text).status).toBe("await_user");
  expect(fs.existsSync(path.join(workspaceRoot, "denied.txt"))).toBe(false);
  expect(
    events.some((e) => e.event.type === "tool.result" && !e.event.ok),
  ).toBe(true);
  expect(
    events.some((e) => (e.event.type as string) === "workspace.changes"),
  ).toBe(false);
});

test("clearing desktop history starts a new Run without the old conversation", async () => {
  const workspaceRoot = root();
  const options = {
    workspaceRoot,
    conversationId: "clear-chat",
    memoryEnabled: false,
    settings: {},
    resolveToolApproval: async () => true,
    onEvent() {},
  };
  const first = await runDesktopNext("Remember Iris", {
    ...options,
    model: model([final("Iris noted")]),
  });
  const requests: string[] = [];
  const cleared = await runDesktopNext("Hello", {
    ...options,
    conversationHistory: [],
    intent: "reset",
    model: model([final("Hello")], requests),
  });
  expect(cleared.ok).toBe(true);
  expect(JSON.parse(cleared.text).runId).not.toBe(JSON.parse(first.text).runId);
  expect(requests[0]).not.toContain("Iris noted");
});

test("approved write uses the Paw Next checkpoint namespace", async () => {
  const workspaceRoot = root();
  const events: RunEventEnvelope[] = [];
  const result = await runDesktopNext("Create approved.txt", {
    workspaceRoot,
    memoryEnabled: false,
    settings: {},
    model: model([
      tool("workspace_write_file", {
        path: "approved.txt",
        content: "approved",
      }),
      final("Created"),
    ]),
    resolveToolApproval: async () => true,
    onEvent(event) {
      events.push(event);
    },
  });
  expect(
    fs.readFileSync(path.join(workspaceRoot, "approved.txt"), "utf8"),
  ).toBe("approved");
  expect(JSON.parse(result.text).runId).toStartWith("desktop-next-");
  const changes = events
    .map(
      (e) =>
        e.event as unknown as {
          type: string;
          fileChanges?: { path: string; added: number; diff?: string }[];
        },
    )
    .filter((e) => e.type === "workspace.changes");
  expect(
    changes.some((e) =>
      e.fileChanges?.some(
        (c) =>
          c.path === "approved.txt" &&
          c.added > 0 &&
          c.diff?.includes("+approved"),
      ),
    ),
  ).toBe(true);
  expect(
    events.some(
      (e) => (e.event as { type: string }).type === "context.next_budget",
    ),
  ).toBe(true);
});

test("empty history never resets a durable Run; recovery reconciles a stale running index without executing again", async () => {
  for (const history of [
    [],
    [{ role: "user" as const, content: "Earlier request" }],
  ]) {
    const workspaceRoot = root();
    const requests: string[] = [];
    const options = {
      workspaceRoot,
      conversationId: "resume",
      memoryEnabled: false,
      settings: {},
      model: model([final("Hello")], requests),
      resolveToolApproval: async () => true,
      onEvent() {},
    };
    const first = JSON.parse((await runDesktopNext("Say hello", options)).text);
    const dir = path.join(workspaceRoot, ".paw", "desktop-next");
    for (const name of fs
      .readdirSync(dir)
      .filter((name) => !name.endsWith(".monitor.json"))) {
      const file = path.join(dir, name);
      const record = JSON.parse(fs.readFileSync(file, "utf8"));
      fs.writeFileSync(file, JSON.stringify({ ...record, status: "running" }));
    }
    await expect(
      runDesktopNext("Say hello", { ...options, conversationHistory: history }),
    ).rejects.toThrow("恢复");
    const before = requests.length;
    const resumed = JSON.parse(
      (
        await runDesktopNext("Say hello", {
          ...options,
          conversationHistory: history,
          intent: "recover",
        })
      ).text,
    );
    expect(resumed.runId).toBe(first.runId);
    expect(resumed.status).toBe("completed");
    expect(requests.length).toBe(before);
    await expect(
      runDesktopNext("Say hello", {
        ...options,
        maxSteps: 9,
        intent: "recover",
      }),
    ).rejects.toThrow("配置");
  }
});

test("explicitly empty history continues unless reset is requested", async () => {
  const workspaceRoot = root();
  const options = {
    workspaceRoot,
    conversationId: "empty",
    memoryEnabled: false,
    settings: {},
    model: model([final("Iris"), final("Iris again")]),
    resolveToolApproval: async () => true,
    onEvent() {},
  };
  const first = JSON.parse(
    (await runDesktopNext("Remember Iris", options)).text,
  );
  const next = JSON.parse(
    (await runDesktopNext("Recall", { ...options, conversationHistory: [] }))
      .text,
  );
  expect(next.runId).toBe(first.runId);
});

test("later-segment recovery retries the persisted input identity without duplicating model work", async () => {
  const workspaceRoot = root();
  const requests: string[] = [];
  const options = {
    workspaceRoot,
    conversationId: "segments",
    memoryEnabled: false,
    settings: {},
    model: model([final("First"), final("Second")], requests),
    resolveToolApproval: async () => true,
    onEvent() {},
  };
  await runDesktopNext("First request", options);
  const second = JSON.parse(
    (await runDesktopNext("Second request", options)).text,
  );
  const dir = path.join(workspaceRoot, ".paw", "desktop-next");
  for (const name of fs
    .readdirSync(dir)
    .filter((name) => !name.endsWith(".monitor.json"))) {
    const file = path.join(dir, name);
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(record.latestWork.content).toBe("Second request");
    fs.writeFileSync(file, JSON.stringify({ ...record, status: "running" }));
  }
  const before = requests.length;
  const recovered = JSON.parse(
    (await runDesktopNext("Second request", { ...options, intent: "recover" }))
      .text,
  );
  expect(recovered.runId).toBe(second.runId);
  expect(recovered.message).toBe(second.message);
  expect(requests.length).toBe(before);
});

test("a changed child model binding prevents silent model switching during recovery", async () => {
  const workspaceRoot = root();
  const options = {
    workspaceRoot,
    conversationId: "model-binding",
    memoryEnabled: false,
    settings: {},
    model: model([final("Hello")]),
    collaborationModels: { keji: model([final("child")]) },
    resolveToolApproval: async () => true,
    onEvent() {},
  };
  await runDesktopNext("Hello", options);
  await expect(
    runDesktopNext("Hello", {
      ...options,
      intent: "recover",
      collaborationModels: { keji: { ...model([]), label: "openai:other" } },
    }),
  ).rejects.toThrow("配置");
});

test("child stream never contaminates the root assistant bubble", () => {
  const events: RunEventEnvelope[] = [];
  const projection = new DesktopNextEvents("root", (event) =>
    events.push(event),
  );
  projection.stream(
    { type: "text", delta: "child secret" },
    { runId: "child" },
  );
  projection.stream({ type: "text", delta: "Hello" }, { runId: "root" });
  projection.stream({ type: "text", delta: " world" }, { runId: "root" });
  expect(events.map((event) => event.event)).toEqual([
    { type: "model.chunk", text: "Hello" },
    { type: "model.chunk", text: "Hello world" },
  ]);
});

test("real V3 child admission, tool calls and settlement reach the desktop activity card", async () => {
  const workspaceRoot = root();
  const events: RunEventEnvelope[] = [];
  fs.writeFileSync(path.join(workspaceRoot, "evidence.txt"), "evidence");
  const childRequests: string[] = [];
  const childModel = model(
    [
      tool("workspace_read_file", { path: "evidence.txt" }),
      final("Child read evidence"),
    ],
    childRequests,
  );
  const result = await runDesktopNext("Ask a reviewer to read evidence.txt", {
    workspaceRoot,
    memoryEnabled: false,
    settings: {},
    model: model([
      tool("workspace_delegate", {
        goal: "Read evidence.txt",
        kind: "review",
        agent_id: "keji",
        max_steps: 3,
      }),
      final("Review complete"),
    ]),
    collaborationModels: { keji: childModel },
    resolveToolApproval: async () => true,
    onEvent: (event) => events.push(event),
  });
  expect(result.ok).toBe(true);
  expect(childRequests.length).toBeGreaterThanOrEqual(2);
  const types = events.map((event) => event.event.type as string);
  expect(types).toContain("child.started");
  expect(types).toContain("child.tool_call");
  expect(types).toContain("child.tool_result");
  expect(types).toContain("child.completed");
  const childEvents = events.filter((event) =>
    (event.event.type as string).startsWith("child."),
  );
  expect(
    new Set(
      childEvents.map(
        (event) => (event.event as unknown as { callId: string }).callId,
      ),
    ).size,
  ).toBe(1);
});

test("stopping while approval is pending settles as aborted without writing", async () => {
  const workspaceRoot = root();
  const controller = new AbortController();
  const result = await runDesktopNext("Create cancelled.txt", {
    workspaceRoot,
    memoryEnabled: false,
    settings: {},
    abortSignal: controller.signal,
    model: model([
      tool("workspace_write_file", { path: "cancelled.txt", content: "no" }),
    ]),
    resolveToolApproval: async () => {
      controller.abort();
      return new Promise<boolean>(() => {});
    },
    onEvent() {},
  });
  expect(JSON.parse(result.text).status).toBe("aborted");
  expect(fs.existsSync(path.join(workspaceRoot, "cancelled.txt"))).toBe(false);
});

test("a writing child inherits desktop approval instead of auto-allowing writes", async () => {
  const workspaceRoot = root();
  const agents = path.join(workspaceRoot, ".paw", "agents");
  fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(
    path.join(agents, "writer.md"),
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
Implement only the assigned file.
`,
  );
  const prompts: string[] = [];
  await runDesktopNext("Delegate creation of child.txt", {
    workspaceRoot,
    memoryEnabled: false,
    settings: {},
    model: model([
      tool("workspace_delegate", {
        goal: "Create child.txt",
        kind: "implementation",
        agent_id: "writer",
        max_steps: 4,
      }),
      tool("workspace_write_file", { path: "child.txt", content: "forbidden" }),
      final("Child write denied"),
      final("The write was denied"),
    ]),
    resolveToolApproval: async (prompt) => {
      prompts.push(prompt.tool);
      return prompt.tool !== "workspace.write_file";
    },
    onEvent() {},
  });
  expect(prompts).toContain("workspace.write_file");
  expect(fs.existsSync(path.join(workspaceRoot, "child.txt"))).toBe(false);
  const changes: unknown[] = [];
  const allowed = await runDesktopNext("Delegate creation of child.txt", {
    workspaceRoot,
    conversationId: "writer-monitor",
    memoryEnabled: false,
    settings: {},
    model: model([
      tool("workspace_delegate", {
        goal: "Create child.txt",
        kind: "implementation",
        agent_id: "writer",
        max_steps: 4,
      }),
      final("Child finished"),
    ]),
    collaborationModels: {
      writer: model([
        tool("workspace_write_file", { path: "child.txt", content: "allowed" }),
        final("Created child.txt"),
      ]),
    },
    resolveToolApproval: async () => true,
    onEvent(envelope) {
      const event = envelope.event as unknown as {
        type: string;
        childId?: string;
        fileChanges?: unknown[];
      };
      if (event.type === "workspace.changes" && event.childId)
        changes.push(...(event.fileChanges ?? []));
    },
  });
  expect(allowed.ok).toBe(true);
  expect(fs.readFileSync(path.join(workspaceRoot, "child.txt"), "utf8")).toBe(
    "allowed",
  );
  expect(changes).toContainEqual(
    expect.objectContaining({ path: "child.txt", added: 1 }),
  );
  expect(
    readDesktopMonitor(workspaceRoot, "writer-monitor")?.tasks[0]?.files,
  ).toContain("child.txt");
  const controls = new DesktopNextControls();
  let childId = "";
  let approvalCancelled = false;
  const cancelled = await runDesktopNext("Delegate another write", {
    workspaceRoot,
    memoryEnabled: false,
    settings: {},
    controls,
    model: model([
      tool("workspace_delegate", {
        goal: "Create never.txt",
        kind: "implementation",
        agent_id: "writer",
        max_steps: 4,
      }),
      final("Parent handled the cancelled child"),
    ]),
    collaborationModels: {
      writer: model([
        tool("workspace_write_file", {
          path: "never.txt",
          content: "must not write",
        }),
      ]),
    },
    resolveToolApproval: async (prompt, signal) => {
      if (prompt.tool !== "workspace.write_file") return true;
      signal.addEventListener(
        "abort",
        () => {
          approvalCancelled = true;
        },
        { once: true },
      );
      controls.cancel(childId);
      return new Promise<boolean>(() => {});
    },
    onEvent(envelope) {
      const event = envelope.event as unknown as Record<string, unknown>;
      if (event.type === "child.control") childId = String(event.callId);
    },
  });
  expect(cancelled.ok).toBe(true);
  expect(approvalCancelled).toBe(true);
  expect(fs.existsSync(path.join(workspaceRoot, "never.txt"))).toBe(false);
});

test("desktop host JSON protocol streams Paw Next through a local model server", async () => {
  const workspaceRoot = root();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const body = await request.text();
      if (JSON.parse(body).stream === true) {
        requests.push(body);
        if (requests.length === 1) await gate;
      }
      const chunks = [
        {
          choices: [
            {
              index: 0,
              delta: { content: "Desktop V3 connected" },
              finish_reason: null,
            },
          ],
        },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ];
      return new Response(
        `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  });
  fs.mkdirSync(path.join(workspaceRoot, ".paw"));
  fs.writeFileSync(
    path.join(workspaceRoot, ".paw", "settings.local.json"),
    JSON.stringify({
      provider: "desktop-fixture",
      models: {
        "desktop-fixture": {
          model: "desktop-test",
          apiKey: "fixture-key",
          baseUrl: `http://127.0.0.1:${server.port}/v1`,
        },
      },
      paid_memory_extraction: false,
    }),
  );
  const proc = Bun.spawn(
    [process.execPath, path.resolve(import.meta.dir, "../agent-host/run.ts")],
    {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        DATABASE_URL:
          "postgresql://fixture:fixture@127.0.0.1:1/fixture?connect_timeout=1",
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const errors = new Response(proc.stderr).text();
  const timeout = setTimeout(() => proc.kill(), 20_000);
  try {
    proc.stdin.write(
      `${JSON.stringify({ type: "run", requestId: "smoke", goal: "Say hello", workspaceRoot, conversationId: "smoke" })}\n`,
    );
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const messages: {
      type: string;
      result?: { status: string; message: string; runId: string };
      event?: { event: { type: string } };
    }[] = [];
    let done = false;
    let sentControls = false;
    const acknowledgements: {
      operationId: string;
      ok: boolean;
      status?: string;
    }[] = [];
    while (!done) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      while (buffer.includes("\n")) {
        const newline = buffer.indexOf("\n");
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        messages.push(message);
        if (message.event?.event?.type === "model.request" && !sentControls) {
          sentControls = true;
          for (const [operationId, requestId] of [
            ["wrong-run", "stale"],
            ["accept", "smoke"],
            ["retry", "smoke"],
          ])
            proc.stdin.write(
              `${JSON.stringify({ type: "input.submit", requestId, operationId, inputId: "ipc-steer", content: "Also confirm IPC steering", attachments: [{ id: "ipc-file", name: "ipc.txt", type: "file", mimeType: "text/plain", content: "ipc-attachment-evidence" }] })}\n`,
            );
        }
        if (message.type === "control.done") {
          acknowledgements.push(message);
          if (acknowledgements.length === 3) release();
        }
        if (message.type === "run.done" || message.type === "error")
          done = true;
      }
    }
    expect(
      acknowledgements.find((ack) => ack.operationId === "wrong-run")?.ok,
    ).toBe(false);
    expect(
      acknowledgements
        .filter((ack) => ack.ok)
        .map((ack) => ack.status)
        .sort(),
    ).toEqual(["accepted", "already_accepted"]);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toContain("Also confirm IPC steering");
    expect(requests[1]).toContain("ipc-attachment-evidence");
    const result = messages.find((message) => message.type === "run.done");
    expect(messages.some((message) => message.type === "ready")).toBe(true);
    expect(result?.result).toMatchObject({
      status: "completed",
      message: "Desktop V3 connected",
    });
    expect(result?.result?.runId).toStartWith("desktop-next-");
    expect(
      messages.some((message) => message.event?.event?.type === "model.chunk"),
    ).toBe(true);
  } finally {
    release();
    clearTimeout(timeout);
    proc.kill();
    await proc.exited;
    await errors;
    server.stop(true);
  }
});

for (const continuing of [false, true]) {
  test(`desktop durable steering works ${continuing ? "in an existing segment" : "in a fresh run"} and deduplicates retries`, async () => {
    const workspaceRoot = root();
    const options = {
      workspaceRoot,
      conversationId: "steer-chat",
      memoryEnabled: false,
      settings: {},
      resolveToolApproval: async () => true,
      onEvent() {},
    };
    if (continuing)
      await runDesktopNext("First turn", {
        ...options,
        model: model([final("First answer")]),
      });
    const controls = new DesktopNextControls();
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requests: string[] = [];
    const events: Record<string, unknown>[] = [];
    let turns = 0;
    const run = runDesktopNext("Inspect the project", {
      ...options,
      controls,
      model: {
        ...model([]),
        async complete(messages) {
          requests.push(JSON.stringify(messages));
          if (++turns === 1) {
            enter();
            await gate;
          }
          return final(`Answer ${turns}`);
        },
      },
      onEvent: (e) =>
        events.push(e.event as unknown as Record<string, unknown>),
    });
    await entered;
    try {
      expect(
        (
          await controls.submit("steer-1", "Also check accessibility", [
            {
              id: "steer-file",
              name: "spec.txt",
              type: "file",
              mimeType: "text/plain",
              content: "steering-evidence ".repeat(400),
            },
          ])
        ).status,
      ).toBe("accepted");
      expect(
        (
          await controls.submit("steer-1", "Also check accessibility", [
            {
              id: "steer-file",
              name: "spec.txt",
              type: "file",
              mimeType: "text/plain",
              content: "steering-evidence ".repeat(400),
            },
          ])
        ).status,
      ).toBe("already_accepted");
      await expect(
        controls.submit("steer-1", "Different content"),
      ).rejects.toThrow("conflict");
    } finally {
      release();
    }
    const result = await run;
    expect(result.ok).toBe(true);
    expect(requests.length).toBeGreaterThan(1);
    expect(requests[1]).toContain("Also check accessibility");
    expect(events.filter((e) => e.type === "input.accepted")).toHaveLength(1);
    expect(events.filter((e) => e.type === "input.promoted")).toHaveLength(1);
    await expect(controls.submit("steer-after", "Too late")).rejects.toThrow();
  });
}

test("desktop cancels only one child and settles it before root continues", async () => {
  const workspaceRoot = root();
  const controls = new DesktopNextControls();
  let childId = "";
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const events: Record<string, unknown>[] = [];
  const parentRequests: string[] = [];
  let childCalls = 0;
  const childModel: LanguageModel = {
    ...model([]),
    async complete(_messages, options) {
      if (++childCalls > 1) return final("Sibling completed normally");
      enter();
      return await new Promise<ModelCompletionResult>((_resolve, reject) => {
        const signal = options?.signal;
        const abort = () => reject(signal?.reason ?? new Error("cancelled"));
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      });
    },
  };
  const run = runDesktopNext("Delegate investigation", {
    workspaceRoot,
    memoryEnabled: false,
    settings: {},
    controls,
    model: model(
      [
        {
          ...tool("workspace_delegate", {}),
          toolCalls: [
            ...tool("workspace_delegate", {
              goal: "Inspect project A",
              kind: "review",
              agent_id: "keji",
              max_steps: 4,
            }).toolCalls!,
            ...tool("workspace_delegate", {
              goal: "Inspect project B",
              kind: "review",
              agent_id: "keji",
              max_steps: 4,
            }).toolCalls!.map((call) => ({
              ...call,
              id: "call-2",
              sourceIndex: 1,
            })),
          ],
        },
        final("Root still responds"),
      ],
      parentRequests,
    ),
    collaborationModels: { keji: childModel },
    resolveToolApproval: async () => true,
    onEvent(e) {
      const event = e.event as unknown as Record<string, unknown>;
      events.push(event);
      if (event.type === "child.control" && !childId)
        childId = String(event.callId);
    },
  });
  await entered;
  expect(childId).not.toBe("");
  expect(() => controls.cancel("foreign-child")).toThrow();
  controls.cancel(childId);
  const result = await run;
  expect(result.ok).toBe(true);
  expect(parentRequests).toHaveLength(2);
  expect(events.filter((e) => e.type === "child.completed")).toHaveLength(1);
  expect(
    events.find((e) => e.type === "child.failed")?.originalEvent,
  ).toMatchObject({ status: "cancelled" });
  expect(() => controls.cancel(childId)).toThrow();
});

test("desktop attachments survive fresh execution, continuation and history projection", async () => {
  const workspaceRoot = root();
  const requests: string[] = [];
  const attachments = [
    {
      id: "text-file",
      name: "notes.md",
      type: "file",
      mimeType: "text/plain",
      content: "attachment-evidence ".repeat(700),
    },
  ];
  const options = {
    workspaceRoot,
    conversationId: "attachments",
    memoryEnabled: false,
    settings: {},
    resolveToolApproval: async () => true,
    onEvent() {},
  };
  const first = await runDesktopNext("Read the attachment", {
    ...options,
    attachments,
    model: model([final("Read notes")], requests),
  });
  expect(first.ok).toBe(true);
  expect(requests[0]).toContain("attachment-evidence");
  expect(requests[0]).toContain("notes.md");
  const second = await runDesktopNext("Compare with this file", {
    ...options,
    attachments: [
      {
        ...attachments[0],
        id: "second",
        name: "next.txt",
        content: "second-attachment",
      },
    ],
    model: model([final("Compared")], requests),
  });
  expect(second.ok).toBe(true);
  expect(requests[1]).toContain("second-attachment");
  expect(requests[1]).toContain("attachment-evidence");
  const image = {
    id: "image",
    name: "pixel.png",
    type: "image",
    mimeType: "image/png",
    content:
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1cAAAAASUVORK5CYII=",
  };
  const third = await runDesktopNext("Read image", {
    ...options,
    attachments: [image],
    model: model([final("Image read")], requests),
  });
  expect(third.ok).toBe(true);
  expect(requests[2]).toContain(image.content);
});

test("desktop task overview captures dependencies, blocked tasks and completed child evidence", async () => {
  const workspaceRoot = root();
  const result = await runDesktopNext("Run dependent review", {
    workspaceRoot,
    conversationId: "mission",
    memoryEnabled: false,
    settings: {},
    model: model([
      tool("workspace_delegate", {
        goal: "Review mission",
        kind: "review",
        tasks: [
          {
            id: "first",
            goal: "Review input",
            kind: "review",
            agent_id: "keji",
            max_steps: 2,
            scope: ["src"],
            acceptance: ["Cite evidence"],
          },
          {
            id: "second",
            goal: "Review result",
            kind: "review",
            agent_id: "keji",
            max_steps: 2,
            depends_on: ["first"],
          },
        ],
      }),
      final("Handled blocked review"),
    ]),
    collaborationModels: {
      keji: {
        ...model([]),
        complete: async () => {
          throw new Error("fixture child failure");
        },
      },
    },
    resolveToolApproval: async () => true,
    onEvent() {},
  });
  expect(result.ok).toBe(true);
  const monitor = readDesktopMonitor(workspaceRoot, "mission");
  expect(monitor?.tasks).toHaveLength(2);
  expect(monitor?.tasks.find((t) => t.name === "Review result")).toMatchObject({
    status: "blocked",
  });
  expect(monitor?.tasks.find((t) => t.name === "Review input")?.scope).toEqual([
    "src",
  ]);
});

test("desktop monitors and stops a real background job, persisting final output", async () => {
  const workspaceRoot = root();
  const controls = new DesktopNextControls();
  fs.writeFileSync(
    path.join(workspaceRoot, "desktop-job.mjs"),
    "console.log('desktop-job-ready'); setInterval(() => {}, 1000);\n",
  );
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const run = runDesktopNext("Start the background fixture", {
    workspaceRoot,
    conversationId: "job",
    memoryEnabled: false,
    settings: { shell_sandbox: { mode: "off" } },
    controls,
    model: model([
      tool("workspace_job_start", {
        command: `"${process.execPath}" desktop-job.mjs`,
      }),
      final("Waiting for job"),
      final("Job settled"),
    ]),
    resolveToolApproval: async () => true,
    onEvent(envelope) {
      const event = envelope.event as unknown as {
        type: string;
        snapshot?: { jobs: unknown[] };
      };
      if (event.type === "monitor.snapshot" && event.snapshot?.jobs.length)
        ready();
    },
  });
  await started;
  let jobs = controls.refreshJobs();
  for (
    let attempt = 0;
    attempt < 50 && !jobs[0]?.job.text.includes("desktop-job-ready");
    attempt++
  ) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    jobs = controls.refreshJobs();
  }
  expect(jobs[0]?.job.text).toContain("desktop-job-ready");
  expect(() => controls.stopJob("unrelated-run", "shell-1")).toThrow();
  controls.stopJob(jobs[0]!.runId, jobs[0]!.job.snapshot.id);
  const result = await run;
  expect(result.ok).toBe(true);
  const saved = readDesktopMonitor(workspaceRoot, "job");
  expect(saved?.jobs[0]?.status).toBe("killed");
  expect(saved?.jobs[0]?.output).toContain("desktop-job-ready");
  const monitorFile = path.join(
    workspaceRoot,
    ".paw",
    "desktop-next",
    `${saved!.runId}.monitor.json`,
  );
  const interrupted = {
    ...saved!,
    jobs: saved!.jobs.map((job) => ({ ...job, status: "running" })),
  };
  fs.writeFileSync(monitorFile, JSON.stringify(interrupted));
  expect(readDesktopMonitor(workspaceRoot, "job")?.jobs[0]?.status).toBe(
    "interrupted_orphaned",
  );
  // Reading a historical view neither reconnects an old PID nor rewrites its evidence.
  expect(JSON.parse(fs.readFileSync(monitorFile, "utf8")).jobs[0].status).toBe(
    "running",
  );
});
