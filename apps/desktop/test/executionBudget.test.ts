import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LanguageModel } from "@paw/models";
import { runDesktopNext } from "../agent-host/paw-next.js";

const roots: string[] = [];
function workspace() { const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-budget-test-")); roots.push(root); return root; }
function model(complete: LanguageModel["complete"]): LanguageModel {
  return { label: "openai:budget-test", capabilities: { contextWindow: 32000, maxOutputTokens: 4096 }, runtimeProfile: { protocol: "openai-compatible", model: "budget-test", baseUrl: "https://invalid.local" }, complete };
}
const common = { settings: {}, memoryEnabled: false, environmentAudit: false, conversationId: "budget", maxSteps: 4, resolveToolApproval: async () => true, onEvent() {} };

test("production desktop puts remaining-time evidence into the first request and keeps simple answers tool-free", async () => {
  const root = workspace();let calls = 0;
  const result = await runDesktopNext("What is a closure?", { ...common, workspaceRoot: root, executionDeadline: { deadlineAtMs: Date.now() + 60_000, reserveMs: 60_000 }, model: model(async messages => {
    calls++;
    const prompt=messages.map(m=>m.content).join("\n");
    expect(prompt).toContain("[Paw incremental verification v1]");
    expect(prompt).toContain("[Paw execution budget v1]");
    expect(prompt).toContain("reserve has been reached");
    return { text: "A closure retains access to its lexical scope.", finishReason: "stop" };
  }) });
  expect(result.ok).toBe(true);expect(calls).toBe(1);
  const files = fs.readdirSync(path.join(root,".paw/desktop-next"));
  const record = JSON.parse(fs.readFileSync(path.join(root,".paw/desktop-next",files.find(f=>f.startsWith("conversation-"))!),"utf8"));
  expect(record.incrementalVerification).toBe(true);expect(record.executionDeadline.reserveMs).toBe(60_000);
});

test("unbounded desktop has no manufactured deadline or extra model turn", async () => {
  const root=workspace();let calls=0;
  const result=await runDesktopNext("Explain closures",{...common,workspaceRoot:root,model:model(async messages=>{
    calls++;expect(messages.map(m=>m.content).join("\n")).not.toContain("[Paw execution budget v1]");
    return {text:"A closure keeps lexical bindings.",finishReason:"stop"};
  })});
  expect(result.ok).toBe(true);expect(calls).toBe(1);
});

test("deadline cancels a live uncooperative request without replay or late tool execution", async () => {
  const root=workspace();let calls=0;let providerSignal:AbortSignal|undefined;
  let settle: ((result: Awaited<ReturnType<LanguageModel["complete"]>>) => void) | undefined;
  const deadline={deadlineAtMs:Date.now()+2000,reserveMs:500};
  const result=await runDesktopNext("Implement the requested change",{...common,workspaceRoot:root,executionDeadline:deadline,model:model(async (_messages,options)=>{
    calls++;providerSignal=options?.signal;return new Promise(resolve=>{settle=resolve;});
  })});
  expect(result.ok).toBe(false);expect(calls).toBe(1);expect(providerSignal?.aborted).toBe(true);
  const args = { path: "late.txt", content: "must not execute" };
  settle!({ text: "", finishReason: "tool_calls", toolCalls: [{ id: "late-write", name: "workspace_write_file", arguments: args, rawArguments: JSON.stringify(args), sourceIndex: 0, argumentsValid: true }] });
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(fs.existsSync(path.join(root, "late.txt"))).toBe(false);
  await expect(runDesktopNext("Continue",{...common,workspaceRoot:root,intent:"recover",model:model(async()=>{throw new Error("must not call");})})).rejects.toThrow("ExecutionDeadlineExceeded");
  await expect(runDesktopNext("Continue",{...common,workspaceRoot:root,intent:"recover",executionDeadline:{...deadline,deadlineAtMs:deadline.deadlineAtMs+60_000},model:model(async()=>{throw new Error("must not call");})})).rejects.toThrow("时间预算已变化");
},15000);

test("completed bounded work recovers its identity and a new user task gets no inherited deadline", async () => {
  const root = workspace();
  let calls = 0;
  const provider = model(async messages => {
    calls++;
    const prompt = messages.map(message => message.content).join("\n");
    expect(prompt).toContain("[Paw incremental verification v1]");
    if (calls === 1) expect(prompt).toContain("[Paw execution budget v1]");
    else expect(prompt).not.toContain("[Paw execution budget v1]");
    return { text: "A closure keeps lexical bindings.", finishReason: "stop" };
  });
  const options = { ...common, workspaceRoot: root, model: provider };
  const first = await runDesktopNext("Explain closures", {
    ...options,
    executionDeadline: { deadlineAtMs: Date.now() + 60_000, reserveMs: 10_000 },
  });
  expect(first.ok).toBe(true);
  const recovered = await runDesktopNext("Explain closures", { ...options, intent: "recover" });
  expect(recovered.ok).toBe(true);
  expect(calls).toBe(1);
  expect(JSON.parse(recovered.text).runId).toBe(JSON.parse(first.text).runId);
  const next = await runDesktopNext("Give a second explanation", options);
  expect(next.ok).toBe(true);
  expect(calls).toBe(2);
  expect(JSON.parse(next.text).runId).toBe(JSON.parse(first.text).runId);
});

test("desktop delivery ledger links actual file readback, survives recovery and resets for new work", async () => {
  const root = workspace();
  let calls = 0;
  let modelError: unknown;
  const invoke = (name: string, args: Record<string, unknown>) => ({
    text: "", finishReason: "tool_calls" as const,
    toolCalls: [{ id: `delivery-${calls}`, name, arguments: args, rawArguments: JSON.stringify(args), sourceIndex: 0, argumentsValid: true }],
  });
  const provider = model(async (messages, options) => {
    try {
    if (messages[0]?.content.includes("completion reviewer"))
      return { text: '{"decision":"allow","reasonCode":"evidence_sufficient","summary":"Readback confirms the fixture"}', finishReason: "stop" };
    calls++;
    const prompt = messages.map(message => message.content).join("\n");
    expect(options?.tools?.some(tool => tool.function.name === "workspace_acceptance_update")).toBe(true);
    if (calls === 1) return invoke("workspace_acceptance_update", { add: [{ text: "README contains Hello", source: "user", ref: "current request" }], updates: [], reason: "Track the requested artifact" });
    if (calls === 2) {
      expect(prompt).toContain('[Paw Delivery State]');
      expect(prompt).toContain('"readiness":"pending"');
      return invoke("workspace_write_file", { path: "README.md", content: "Hello\n" });
    }
    if (calls === 3) return invoke("workspace_read_file", { path: "README.md" });
    if (calls === 4) {
      const marker = prompt.lastIndexOf("[Paw Delivery State]");
      const state = JSON.parse(prompt.slice(prompt.indexOf("\n", marker) + 1).split("\n")[0]!);
      expect(state.references).toHaveLength(1);
      return invoke("workspace_acceptance_update", { add: [], updates: [{ id: "acceptance-1", status: "satisfied", evidence: state.references[0].callId }], reason: "Read back the required bytes" });
    }
    if (calls === 5) expect(prompt).toContain('"readiness":"evidence_linked"');
    else expect(prompt).not.toContain("[Paw Delivery State]");
    return { text: "README contains Hello.", finishReason: "stop" };
    } catch (error) { modelError = error; throw error; }
  });
  const options = { ...common, workspaceRoot: root, maxSteps: 8, model: provider };
  const result = await runDesktopNext("Write README.md containing Hello and verify its content", options);
  if (modelError) throw modelError;
  expect(result.ok, result.text).toBe(true);
  expect(calls).toBe(5);
  expect(fs.readFileSync(path.join(root, "README.md"), "utf8")).toBe("Hello\n");
  expect((await runDesktopNext("Recover", { ...options, intent: "recover" })).ok).toBe(true);
  expect(calls).toBe(5);
  expect((await runDesktopNext("A separate question: say hello", options)).ok).toBe(true);
  expect(calls).toBe(6);
}, 30_000);

test("desktop declines the next model request using measured rounds and reports incomplete", async () => {
  const root = workspace();
  fs.writeFileSync(path.join(root, "input.txt"), "fixture");
  const deadlineAtMs = Date.now() + 60_000;
  let clock = deadlineAtMs - 1000;
  let calls = 0;
  const result = await runDesktopNext("Inspect input.txt", {
    ...common, workspaceRoot: root,
    executionDeadline: { deadlineAtMs, reserveMs: 100 },
    leaseScheduler: { now: () => clock, scheduleAt() { return { cancel() {} }; } },
    model: model(async () => {
      calls++;
      clock += calls === 1 ? 200 : 795;
      const args = { path: "input.txt" };
      return { text: "", finishReason: "tool_calls", toolCalls: [{ id: `inspect-${calls}`, name: "workspace_read_file", arguments: args, rawArguments: JSON.stringify(args), sourceIndex: 0, argumentsValid: true }] };
    }),
  });
  expect(calls).toBe(2);
  expect(result.ok).toBe(false);
  expect(JSON.parse(result.text).status).toBe("incomplete");
  expect(Date.now()).toBeLessThan(deadlineAtMs);
}, 15_000);

afterEach(()=>{for(const root of roots.splice(0)) { const resolved=path.resolve(root);if(path.dirname(resolved)!==path.resolve(os.tmpdir())||!path.basename(resolved).startsWith("paw-budget-test-"))throw new Error("Unsafe fixture");fs.rmSync(resolved,{recursive:true,force:true}); }});
