import { afterEach, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ChatMessage,
  LanguageModel,
  ModelCompletionResult,
} from "@paw/models";
import {
  buildPawNextTaskProfileV3,
  runFreshPawNextTaskV3,
} from "@paw/paw-next";
import { desktopProfile, fingerprint } from "../agent-host/paw-next-profile.js";
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
function greetingResponse(
  messages: readonly ChatMessage[],
): ModelCompletionResult {
  // The executor's greeting and the tool-free delivery review use different
  // output contracts. Do not send greeting prose to the structured reviewer.
  if (
    messages.some(
      (message) =>
        message.role === "system" &&
        message.content.includes("independent, read-only completion reviewer"),
    )
  )
    return final(
      JSON.stringify({
        decision: "allow",
        reasonCode: "evidence_sufficient",
        summary: "The greeting answers the current conversational request.",
      }),
    );
  return final("你好！");
}
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
    environmentAuditSinglePass: false,
    environmentAuditEvidenceRepair: false,
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

test.each(["read_then_pass", "repeat_bad_report", "read_then_defect"] as const)(
  "owned evidence correction stays in one child and is bounded: %s",
  async (outcome) => {
    const f = fixture("pass");
    let auditCalls = 0;
    let correctionsSeen = 0;
    const model: LanguageModel = {
      ...f.options.model,
      async complete(messages, options) {
        const text = JSON.stringify(messages);
        if (!text.includes("Paw environment auditor"))
          return f.options.model.complete(messages, options);
        auditCalls++;
        if (text.includes("Your report was rejected by host validation"))
          correctionsSeen++;
        expect(text).toContain("Auditor-owned file reads");
        if (auditCalls === 2 && outcome !== "repeat_bad_report")
          return tool("workspace_read_file", { path: "note.txt" });
        if (auditCalls === 3) {
          expect(text).toContain("requestedRange");
          expect(text).toContain("test-call-");
        }
        return final(
          JSON.stringify({
            completion:
              outcome === "read_then_defect" && auditCalls >= 3
                ? "incomplete"
                : "complete",
            summary: "检查完成",
            evidencePaths: ["note.txt"],
            unmetCriteria:
              outcome === "read_then_defect" && auditCalls >= 3
                ? ["内容错误，应为 checked"]
                : [],
          }),
        );
      },
    };
    const options = {
      ...f.options,
      model,
      environmentAuditSinglePass: true,
      environmentAuditEvidenceRepair: true,
    };
    const result = await runDesktopNext(
      "Create note.txt containing hello",
      options,
    );
    const body = JSON.parse(result.text);
    if (outcome === "read_then_pass") {
      expect(body.acceptance, result.text).toBe("verified");
      expect(auditCalls).toBe(3);
      expect(f.counts().rootCalls).toBe(2);
      expect(correctionsSeen).toBe(2);
    } else if (outcome === "repeat_bad_report") {
      expect(body.acceptance, result.text).toBe("unverified");
      expect(body.status).toBe("incomplete");
      expect(auditCalls).toBe(2);
      expect(f.counts().rootCalls).toBe(2);
    } else {
      expect(body.acceptance).toBe("unverified");
      expect(f.counts().rootCalls).toBeGreaterThan(2);
    }
    const before = auditCalls;
    await runDesktopNext("Continue", {
      ...options,
      environmentAuditEvidenceRepair: false,
      intent: "recover",
    });
    expect(auditCalls).toBe(before);
  },
);

test.each(["pass", "turn_limit", "timeout"] as const)(
  "audit correction retains prior reads and shares the original budget: %s",
  async (outcome) => {
    const f = fixture("pass");
    fs.writeFileSync(path.join(f.root, "README.md"), "hello contract");
    let calls = 0;
    let timers = 0;
    const nativeTimeout = globalThis.setTimeout;
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
      handler,
      delay,
      ...args
    ) => {
      if (delay === 240_000) timers++;
      return nativeTimeout(
        handler,
        delay === 240_000 && outcome === "timeout" ? 8000 : delay,
        ...args,
      );
    }) as typeof setTimeout);
    try {
      const model: LanguageModel = {
        ...f.options.model,
        async complete(messages, options) {
          const text = JSON.stringify(messages);
          if (!text.includes("Paw environment auditor"))
            return f.options.model.complete(messages, options);
          calls++;
          if (calls === 1)
            return tool("workspace_read_file", { path: "note.txt" });
          if (calls === 3 && outcome === "timeout")
            return new Promise((_resolve, reject) => {
              const signal = options!.signal!;
              if (signal.aborted) reject(signal.reason);
              else
                signal.addEventListener("abort", () => reject(signal.reason), {
                  once: true,
                });
            });
          if (calls === 3 || (calls > 3 && outcome === "turn_limit"))
            return tool("workspace_read_file", { path: "README.md" });
          if (calls === 4) {
            expect(text).toContain(
              "Your report was rejected by host validation",
            );
            const ledger = messages
              .filter(
                (m) =>
                  typeof m.content === "string" &&
                  m.content.includes("[Auditor-owned file reads]"),
              )
              .at(-1)!.content;
            expect(ledger).toContain("note.txt");
            expect(ledger).toContain("README.md");
          }
          return final(
            JSON.stringify({
              completion: "complete",
              summary: "已核对",
              evidencePaths: ["note.txt", "README.md"],
              unmetCriteria: [],
            }),
          );
        },
      };
      const result = await runDesktopNext("Create note.txt containing hello", {
        ...f.options,
        model,
        environmentAuditSinglePass: true,
        environmentAuditEvidenceRepair: true,
      });
      expect(JSON.parse(result.text).acceptance, result.text).toBe(
        outcome === "pass" ? "verified" : "unverified",
      );
      expect(f.counts().rootCalls).toBe(2);
      expect(timers).toBe(1);
      expect(calls).toBe(
        outcome === "pass" ? 4 : outcome === "turn_limit" ? 12 : 3,
      );
      if (outcome === "pass")
        expect(
          readDesktopMonitor(f.root, "audit")
            ?.audit?.inspected.map((i) => i.path)
            .sort(),
        ).toEqual(["README.md", "note.txt"]);
    } finally {
      timer.mockRestore();
    }
  },
);

test.each(["pass", "timeout", "changed"] as const)(
  "audit timeout retries inside review without restarting root: %s",
  async (outcome) => {
    const f = fixture("pass");
    let auditCalls = 0;
    let rootCalls = 0;
    const nativeTimeout = globalThis.setTimeout;
    // Compress only the audit deadline. Production retains its 120s deadline;
    // all real child setup, cancellation, journaling and recovery still execute.
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
      handler,
      delay,
      ...args
    ) =>
      nativeTimeout(
        handler,
        delay === 120_000 ? 3000 : delay,
        ...args,
      )) as typeof setTimeout);
    try {
      const model: LanguageModel = {
        ...f.options.model,
        async complete(messages, options) {
          if (!JSON.stringify(messages).includes("Paw environment auditor")) {
            rootCalls++;
            return f.options.model.complete(messages, options);
          }
          auditCalls++;
          if (auditCalls === 2 || (outcome === "timeout" && auditCalls === 4)) {
            const signal = options?.signal;
            if (!signal) throw new Error("Missing audit cancellation signal");
            return new Promise((_resolve, reject) => {
              const stop = () => {
                if (outcome === "changed")
                  fs.writeFileSync(
                    path.join(f.root, "note.txt"),
                    "external change",
                  );
                reject(signal.reason);
              };
              if (signal.aborted) stop();
              else signal.addEventListener("abort", stop, { once: true });
            });
          }
          if (auditCalls % 2 === 1)
            return tool("workspace_read_file", { path: "note.txt" });
          return final(
            JSON.stringify({
              completion: "complete",
              summary: "Independently checked",
              evidencePaths: ["note.txt"],
              unmetCriteria: [],
            }),
          );
        },
      };
      const result = await runDesktopNext("Create note.txt containing hello", {
        ...f.options,
        model,
      });
      expect(JSON.parse(result.text).acceptance).toBe(
        outcome === "pass" ? "verified" : "unverified",
      );
      expect(JSON.parse(result.text).status).toBe(
        outcome === "pass" ? "completed" : "incomplete",
      );
      expect(result.ok).toBe(outcome === "pass");
      expect(rootCalls).toBe(2);
      expect(auditCalls).toBe(outcome === "changed" ? 2 : 4);
      expect(fs.readFileSync(path.join(f.root, "note.txt"), "utf8")).toBe(
        outcome === "changed" ? "external change" : "hello",
      );
      if (outcome !== "changed") {
        expect(readDesktopMonitor(f.root, "audit")?.audit?.reviewId).toEndWith(
          "-retry-1",
        );
        const before = { rootCalls, auditCalls };
        const recovered = await runDesktopNext(
          "Create note.txt containing hello",
          { ...f.options, model, intent: "recover" },
        );
        expect(JSON.parse(recovered.text).acceptance).toBe(
          outcome === "pass" ? "verified" : "unverified",
        );
        expect({ rootCalls, auditCalls }).toEqual(before);
      }
    } finally {
      timer.mockRestore();
    }
  },
);

test("single-pass audit has one bounded deadline, preserves evidence and cannot display false completion", async () => {
  const f = fixture("pass");
  let rootCalls = 0;
  let auditCalls = 0;
  let auditTimers = 0;
  const nativeTimeout = globalThis.setTimeout;
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
    handler,
    delay,
    ...args
  ) => {
    if (delay === 240_000) auditTimers++;
    return nativeTimeout(handler, delay === 240_000 ? 3000 : delay, ...args);
  }) as typeof setTimeout);
  try {
    const model: LanguageModel = {
      ...f.options.model,
      async complete(messages, options) {
        const prompt = JSON.stringify(messages);
        if (!prompt.includes("Paw environment auditor")) {
          rootCalls++;
          return rootCalls === 1
            ? tool("workspace_write_file", {
                path: "note.txt",
                content: "hello",
              })
            : final("Everything is complete and verified.");
        }
        auditCalls++;
        expect(prompt).toContain("at most 240 seconds total wall time");
        if (auditCalls === 1)
          return tool("workspace_read_file", { path: "note.txt" });
        return new Promise((_resolve, reject) => {
          const signal = options!.signal!;
          if (signal.aborted) reject(signal.reason);
          else
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
        });
      },
    };
    const options = { ...f.options, environmentAuditSinglePass: true, model };
    const result = await runDesktopNext(
      "Create note.txt containing hello",
      options,
    );
    const body = JSON.parse(result.text);
    expect(body.status).toBe("incomplete");
    expect(body.acceptance).toBe("unverified");
    expect(body.message).toContain("独立验收达到时限");
    expect(body.message).not.toContain("Everything is complete");
    expect({ rootCalls, auditCalls, auditTimers }).toEqual({
      rootCalls: 2,
      auditCalls: 2,
      auditTimers: 1,
    });
    expect(fs.readFileSync(path.join(f.root, "note.txt"), "utf8")).toBe(
      "hello",
    );
    expect(readDesktopMonitor(f.root, "audit")?.audit?.reviewId).not.toEndWith(
      "-retry-1",
    );
    const recovered = await runDesktopNext("Continue", {
      ...options,
      environmentAuditSinglePass: false,
      intent: "recover",
    });
    expect(JSON.parse(recovered.text).acceptance).toBe("unverified");
    expect({ rootCalls, auditCalls, auditTimers }).toEqual({
      rootCalls: 2,
      auditCalls: 2,
      auditTimers: 1,
    });
  } finally {
    timer.mockRestore();
  }
});

test("single-pass audit can verify and replay with its frozen identity", async () => {
  const f = fixture("pass");
  const result = await runDesktopNext("Create note.txt containing hello", {
    ...f.options,
    environmentAuditSinglePass: true,
  });
  expect(result.ok, result.text).toBe(true);
  expect(
    f.messagesSeen.some((text) =>
      text.includes("at most 240 seconds total wall time"),
    ),
  ).toBe(true);
  const before = f.counts();
  const recovered = await runDesktopNext("Continue", {
    ...f.options,
    intent: "recover",
  });
  expect(recovered.ok, recovered.text).toBe(true);
  expect(f.counts()).toEqual(before);
});

test("single-pass ungrounded report stops unverified without reopening the executor", async () => {
  const f = fixture("false_claim");
  const options = { ...f.options, environmentAuditSinglePass: true };
  const result = await runDesktopNext(
    "Create note.txt containing hello",
    options,
  );
  const body = JSON.parse(result.text);
  expect(body.status).toBe("incomplete");
  expect(body.acceptance).toBe("unverified");
  expect(f.counts()).toEqual({ rootCalls: 2, auditCalls: 1 });
  expect(body.message).toContain("独立验收尚未通过");
  expect(body.message).not.toContain("已完成文件任务");
  expect(readDesktopMonitor(f.root, "audit")?.audit?.summary).toContain(
    "未成功读取",
  );
  const before = f.counts();
  const recovered = await runDesktopNext("Continue", {
    ...options,
    intent: "recover",
  });
  expect(JSON.parse(recovered.text).acceptance).toBe("unverified");
  expect(f.counts()).toEqual(before);
});

test("pre-retry audited desktop sessions recover with their original identity and zero model calls", async () => {
  const f = fixture("pass");
  const identity = {
    workspaceRoot: f.root,
    sessionId: "desktop-session-old-audit",
    runId: "desktop-next-old-audit",
    inputId: "desktop-input-old-audit",
    goal: "Create note.txt containing hello",
  };
  const profile = {
    ...desktopProfile(f.root, f.options.model, {}, undefined, false),
    auditedMemory: true as const,
    browserAudit: true as const,
  };
  const requestApproval = async () => ({ decision: "allow_once" as const });
  const args = {
    identity,
    profile,
    model: f.options.model,
    apiKey: fingerprint({}),
    requestApproval,
  };
  const first = buildPawNextTaskProfileV3(args);
  const resolution = buildPawNextTaskProfileV3({
    ...args,
    profile: { ...profile, configHash: first.configHash },
  });
  await runFreshPawNextTaskV3({ resolution, requestApproval });
  const record = {
    version: 1,
    ...identity,
    liveSteering: true,
    environmentAudit: true,
    auditedMemory: true,
    browserAudit: true,
    configHash: resolution.configHash,
    status: "completed",
    segments: 1,
  };
  const dir = path.join(f.root, ".paw", "desktop-next");
  fs.mkdirSync(dir, { recursive: true });
  for (const name of [`conversation-${fingerprint("audit")}`, identity.runId])
    fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(record));
  const before = f.counts();
  const result = await runDesktopNext(identity.goal, {
    ...f.options,
    intent: "recover",
  });
  expect(JSON.parse(result.text)).toMatchObject({
    runId: identity.runId,
    acceptance: "verified",
  });
  expect(f.counts()).toEqual(before);
});

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

test("read-only auditor recalls a truncated file and accepts its final report after prose", async () => {
  const f = fixture("pass");
  let executorCalls = 0;
  let auditorCalls = 0;
  const auditTrace: string[] = [];
  const model: LanguageModel = {
    ...f.options.model,
    async complete(messages) {
      if (JSON.stringify(messages).includes("Paw environment auditor")) {
        auditorCalls++;
        if (auditorCalls === 1)
          return tool("workspace_read_file", { path: "note.txt" });
        const turn = messages.findLast(
          (message) => message.nativeToolTurn,
        )?.nativeToolTurn;
        const lastResult = turn?.results.at(-1);
        const lastTool = lastResult?.content ?? "";
        auditTrace.push(lastTool.slice(0, 1200));
        if (auditorCalls === 2) {
          expect(lastTool).toContain("large_tool_output");
          const id = lastTool.match(/paw-payload:v1:[a-f0-9]{64}/)?.[0];
          expect(id).toBeDefined();
          return tool("context_recall", {
            id,
            part: "chunk",
            offset: 8000,
            limit: 1000,
          });
        }
        expect(turn?.calls.at(-1)?.providerName).toBe("context_recall");
        expect(lastResult).toMatchObject({
          status: "completed",
          isError: false,
        });
        expect(lastTool).not.toContain("denied");
        expect(lastTool).toContain("abcd");
        return final(
          "Audit complete. I independently inspected the file.\n" +
            JSON.stringify({
              completion: "complete",
              summary: "已读取并回看文件内容",
              evidencePaths: ["note.txt"],
              unmetCriteria: [],
            }),
        );
      }
      if (++executorCalls === 1)
        return tool("workspace_write_file", {
          path: "note.txt",
          content: ("abcd".repeat(10) + "\n").repeat(500),
        });
      return final("已完成文件任务。");
    },
  };
  const result = await runDesktopNext(
    "Create note.txt containing 500 lines, each with abcd repeated 10 times",
    { ...f.options, model },
  );
  expect(
    result.ok,
    JSON.stringify({
      result: result.text,
      executorCalls,
      auditorCalls,
      auditTrace,
    }),
  ).toBe(true);
  expect(JSON.parse(result.text)).toMatchObject({
    status: "completed",
    acceptance: "verified",
  });
  expect({ executorCalls, auditorCalls }).toEqual({
    executorCalls: 2,
    auditorCalls: 3,
  });
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

test.each([false, true])(
  "a process crash after a committed audit claim recovers without repeating the write (retry=%s)",
  async (retryClaim) => {
    const f = fixture("pass");
    const source = `import fs from "node:fs";
    import { runDesktopNext } from ${JSON.stringify(new URL("../agent-host/paw-next.ts", import.meta.url).href)};
    const nativeTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, delay, ...args) => nativeTimeout(fn, delay === 120000 ? 3000 : delay, ...args);
    let calls = 0;
    const model = { label: "openai:audit-test", capabilities: { contextWindow: 32000, maxOutputTokens: 4096 }, runtimeProfile: { protocol: "openai-compatible", model: "audit-test", baseUrl: "https://desktop.invalid/v1" },
      async complete(messages, options) {
        if (JSON.stringify(messages).includes("Paw environment auditor")) return new Promise((_resolve, reject) => {
          if (options.signal.aborted) reject(options.signal.reason);
          else options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
        });
        if (++calls === 1) return { text: "", nativeAssistantContent: "", finishReason: "tool_calls", toolCalls: [{ id: "initial-write", name: "workspace_write_file", arguments: { path: "note.txt", content: "hello" }, rawArguments: JSON.stringify({ path: "note.txt", content: "hello" }), sourceIndex: 0, argumentsValid: true }] }; return { text: "Done", nativeAssistantContent: "Done", finishReason: "stop" }; }
    };
    await runDesktopNext("Create note.txt containing hello", { workspaceRoot: ${JSON.stringify(f.root)}, conversationId: "audit", memoryEnabled: false, environmentAudit: true, environmentAuditSinglePass: false, settings: {}, model, resolveToolApproval: async () => true,
      onEvent(envelope) { if (envelope.event.type === "monitor.snapshot" && envelope.event.snapshot?.audit?.status === "checking" && (${!retryClaim} || envelope.event.snapshot.audit.reviewId.endsWith("-retry-1"))) process.exit(91); }
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
    expect(fs.readFileSync(path.join(f.root, "note.txt"), "utf8")).toBe(
      "hello",
    );
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
    if (retryClaim)
      expect(readDesktopMonitor(f.root, "audit")?.audit?.reviewId).toEndWith(
        "-retry-1",
      );
    expect(fs.readFileSync(path.join(f.root, "note.txt"), "utf8")).toBe(
      "hello",
    );
  },
);

test("ordinary conversation does not start file auditing", async () => {
  const f = fixture("pass");
  const result = await runDesktopNext("Hello", {
    ...f.options,
    model: {
      ...f.options.model,
      async complete(messages) {
        return greetingResponse(messages);
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
      async complete(messages) {
        return greetingResponse(messages);
      },
    },
  });
  const result = await runDesktopNext(
    "Create note.txt containing checked; retain the exact content contract",
    f.options,
  );
  expect(result.ok, result.text).toBe(true);
  expect(JSON.parse(result.text).acceptance).toBe("verified");
  const lastAudit = [...f.messagesSeen]
    .reverse()
    .find((text) => text.includes("Paw environment auditor"));
  expect(lastAudit).toContain("Current user task:");
  expect(lastAudit).toContain("retain the exact content contract");
  expect(lastAudit).toContain("Repair request:");
  expect(f.counts().auditCalls).toBe(4);
});
