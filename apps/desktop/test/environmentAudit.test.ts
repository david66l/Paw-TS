import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ChatMessage,
  LanguageModel,
  ModelCompletionResult,
} from "@paw/models";
import { readDesktopMonitor, runDesktopNext } from "../agent-host/paw-next.js";

setDefaultTimeout(60_000);
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
let callSequence = 0;
const tool = (
  name: string,
  args: Record<string, unknown>,
): ModelCompletionResult => ({
  text: "",
  nativeAssistantContent: "",
  finishReason: "tool_calls",
  toolCalls: [
    {
      id: `test-call-${++callSequence}`,
      name,
      arguments: args,
      rawArguments: JSON.stringify(args),
      sourceIndex: 0,
      argumentsValid: true,
    },
  ],
});
function fixture(audit: "pass" | "false_claim" | "denied_write" | "repair") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-audit-desktop-"));
  roots.push(root);
  let rootCalls = 0;
  let auditCalls = 0;
  let auditRounds = 0;
  const messagesSeen: string[] = [];
  const model: LanguageModel = {
    label: "openai:audit-test",
    capabilities: { contextWindow: 32_000, maxOutputTokens: 4096 },
    runtimeProfile: {
      protocol: "openai-compatible",
      model: "audit-test",
      baseUrl: "https://desktop.invalid/v1",
    },
    async complete(messages: readonly ChatMessage[]) {
      const text = JSON.stringify(messages);
      messagesSeen.push(text);
      if (text.includes("Paw environment auditor")) {
        auditCalls++;
        const hasTool = auditCalls % 2 === 0;
        if (!hasTool && audit !== "false_claim") {
          auditRounds++;
          return audit === "denied_write"
            ? tool("workspace_write_file", {
                path: "forbidden.txt",
                content: "bad",
              })
            : tool("workspace_read_file", { path: "note.txt" });
        }
        const needsRepair = audit === "repair" && auditRounds === 1;
        return final(
          JSON.stringify({
            completion: needsRepair ? "incomplete" : "complete",
            summary: needsRepair ? "内容需要修复" : "已独立读取并核对文件",
            evidencePaths: ["note.txt"],
            unmetCriteria: needsRepair ? ["将内容改为 checked"] : [],
          }),
        );
      }
      rootCalls++;
      if (rootCalls === 1)
        return tool("workspace_write_file", {
          path: "note.txt",
          content: "hello",
        });
      if (audit === "repair" && rootCalls === 3)
        return tool("workspace_write_file", {
          path: "note.txt",
          content: "checked",
        });
      return final("已完成文件任务。");
    },
  };
  const options = {
    workspaceRoot: root,
    conversationId: "audit",
    memoryEnabled: false,
    environmentAudit: true,
    settings: {},
    model,
    resolveToolApproval: async () => true,
    onEvent() {},
  };
  return {
    root,
    options,
    counts: () => ({ rootCalls, auditCalls }),
    messagesSeen,
  };
}

test("desktop independently inspects actual files, persists evidence and reuses a settled audit on recovery", async () => {
  const f = fixture("pass");
  const result = await runDesktopNext(
    "Create note.txt containing hello",
    f.options,
  );
  expect(JSON.parse(result.text)).toMatchObject({
    status: "completed",
    acceptance: "verified",
  });
  expect(f.counts()).toEqual({ rootCalls: 2, auditCalls: 2 });
  const audit = readDesktopMonitor(f.root, "audit")?.audit;
  expect(audit?.status).toBe("verified");
  expect(audit?.inspected[0]?.path).toBe("note.txt");
  expect(audit?.inspected[0]?.hash).toMatch(/^[a-f0-9]{64}$/);
  const before = f.counts();
  const restored = await runDesktopNext("Create note.txt containing hello", {
    ...f.options,
    intent: "recover",
  });
  expect(JSON.parse(restored.text).acceptance).toBe("verified");
  expect(f.counts()).toEqual(before);
  fs.writeFileSync(path.join(f.root, "note.txt"), "changed after audit");
  await runDesktopNext("Create note.txt containing hello", {
    ...f.options,
    intent: "recover",
  });
  expect(f.counts().auditCalls).toBeGreaterThan(before.auditCalls);
});

test("a claimed success with no actual read stays unverified after bounded repair attempts", async () => {
  const f = fixture("false_claim");
  const result = await runDesktopNext(
    "Create note.txt containing hello",
    f.options,
  );
  expect(JSON.parse(result.text)).toMatchObject({
    status: "incomplete",
    acceptance: "unverified",
  });
  expect(result.ok).toBe(false);
  expect(f.counts().auditCalls).toBe(3);
  expect(readDesktopMonitor(f.root, "audit")?.audit?.status).toBe("unverified");
});

test("auditor cannot write even when the desktop user approves executor tools", async () => {
  const f = fixture("denied_write");
  const result = await runDesktopNext(
    "Create note.txt containing hello",
    f.options,
  );
  expect(result.ok).toBe(false);
  expect(fs.existsSync(path.join(f.root, "forbidden.txt"))).toBe(false);
});

test("a blocking audit feeds a repair work segment and only a new inspection passes it", async () => {
  const f = fixture("repair");
  const result = await runDesktopNext(
    "Create note.txt containing checked",
    f.options,
  );
  expect(JSON.parse(result.text)).toMatchObject({
    status: "completed",
    acceptance: "verified",
  });
  expect(fs.readFileSync(path.join(f.root, "note.txt"), "utf8")).toBe(
    "checked",
  );
  expect(f.counts()).toEqual({ rootCalls: 4, auditCalls: 4 });
});

test("a process crash after a committed audit claim recovers without repeating the write", async () => {
  const f = fixture("pass");
  const source = `import fs from "node:fs";
    import { runDesktopNext } from ${JSON.stringify(new URL("../agent-host/paw-next.ts", import.meta.url).href)};
    let calls = 0;
    const model = { label: "openai:audit-test", capabilities: { contextWindow: 32000, maxOutputTokens: 4096 }, runtimeProfile: { protocol: "openai-compatible", model: "audit-test", baseUrl: "https://desktop.invalid/v1" },
      async complete() { if (++calls === 1) return { text: "", nativeAssistantContent: "", finishReason: "tool_calls", toolCalls: [{ id: "initial-write", name: "workspace_write_file", arguments: { path: "note.txt", content: "hello" }, rawArguments: JSON.stringify({ path: "note.txt", content: "hello" }), sourceIndex: 0, argumentsValid: true }] }; return { text: "Done", nativeAssistantContent: "Done", finishReason: "stop" }; }
    };
    await runDesktopNext("Create note.txt containing hello", { workspaceRoot: ${JSON.stringify(f.root)}, conversationId: "audit", memoryEnabled: false, environmentAudit: true, settings: {}, model, resolveToolApproval: async () => true,
      onEvent(envelope) { if (envelope.event.type === "monitor.snapshot" && envelope.event.snapshot?.audit?.status === "checking") process.exit(91); }
    }); process.exit(92);`;
  const script = path.join(f.root, "crash-harness.ts");
  fs.writeFileSync(script, source);
  const proc = Bun.spawn([process.execPath, script], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = new Response(proc.stderr).text();
  const timer = setTimeout(() => proc.kill(), 20_000);
  try {
    expect(await proc.exited).toBe(91);
    await stderr;
  } finally {
    clearTimeout(timer);
  }
  expect(fs.readFileSync(path.join(f.root, "note.txt"), "utf8")).toBe("hello");
  let resumedRootCalls = 0;
  const resumeModel: LanguageModel = {
    ...f.options.model,
    async complete(messages, options) {
      if (JSON.stringify(messages).includes("Paw environment auditor"))
        return f.options.model.complete(messages, options);
      resumedRootCalls++;
      return final("检查已有文件并完成验收。");
    },
  };
  // Respect the frozen 90s execution lease: simulate time passing after process death.
  const now = () => Date.now() + 100_000;
  const resumed = await runDesktopNext("Create note.txt containing hello", {
    ...f.options,
    model: resumeModel,
    intent: "recover",
    leaseScheduler: {
      now,
      scheduleAt(deadline, task) {
        const timer = setTimeout(task, Math.max(0, deadline - now()));
        return { cancel: () => clearTimeout(timer) };
      },
    },
  });

  expect(JSON.parse(resumed.text).acceptance).toBe("verified");
  expect(resumedRootCalls).toBe(0);
  expect(f.counts().auditCalls).toBe(2);
  expect(fs.readFileSync(path.join(f.root, "note.txt"), "utf8")).toBe("hello");
});

test("ordinary conversation does not start file auditing", async () => {
  const f = fixture("pass");
  const result = await runDesktopNext("Hello", {
    ...f.options,
    model: {
      ...f.options.model,
      async complete() {
        return final("你好！");
      },
    },
  });
  expect(JSON.parse(result.text)).toMatchObject({
    status: "completed",
    acceptance: "not_required",
  });
  expect(readDesktopMonitor(f.root, "audit")?.audit).toBeUndefined();
});

test("historical runs keep their original audit policy during recovery", async () => {
  const f = fixture("pass");
  await runDesktopNext("Create note.txt containing hello", {
    ...f.options,
    environmentAudit: false,
  });
  const before = f.counts();
  const result = await runDesktopNext("Create note.txt containing hello", {
    ...f.options,
    intent: "recover",
  });
  expect(JSON.parse(result.text).status).toBe("completed");
  expect(f.counts()).toEqual(before);
  expect(f.counts().auditCalls).toBe(0);
});

test("audit repair retains the current user task from a continued conversation", async () => {
  const f = fixture("repair");
  await runDesktopNext("你好", {
    ...f.options,
    model: {
      ...f.options.model,
      async complete() {
        return final("你好！");
      },
    },
  });
  const result = await runDesktopNext(
    "Create note.txt containing checked; retain the exact content contract",
    f.options,
  );
  expect(JSON.parse(result.text).acceptance).toBe("verified");
  const lastAudit = [...f.messagesSeen]
    .reverse()
    .find((text) => text.includes("Paw environment auditor"));
  expect(lastAudit).toContain("Current user task:");
  expect(lastAudit).toContain("retain the exact content contract");
  expect(lastAudit).toContain("Repair request:");
  expect(f.counts().auditCalls).toBe(4);
});
