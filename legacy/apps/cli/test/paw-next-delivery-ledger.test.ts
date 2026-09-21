import { expect, test } from "bun:test";
import type { InputFactV1, JsonValue } from "@paw/protocol";
import type { VerifiedCanonicalPayloadEvidenceV1 } from "@paw/runtime";
import { createDeliveryLedgerServiceV1, createDeliveryLedgerPluginV1, inspectDeliveryLedgerV1, projectDeliveryLedgerV1 } from "../../../../packages/paw-next/src/delivery-ledger.js";

const snapshot = (facts: InputFactV1[]) => ({ entries: facts.map((fact, i) => ({ seq: i + 1, fact })), tailSeq: facts.length, latestInputSeq: facts.length });
const clean = { workspaceEffect: { changed: false, paths: [] } };
const evidence = {} as VerifiedCanonicalPayloadEvidenceV1;
function tool(facts: InputFactV1[], name: string, args: JsonValue, payload: JsonValue, isError = false) {
  const callId = `call-${facts.length}`;
  facts.push({ type: "tool.call_observed", modelCallId: "model", callId, turn: 1, order: 0, tool: name, args });
  facts.push({ type: "tool.settled", callId, status: "completed", observation: { schemaVersion: "paw.tool-observation.v1", isError, summary: "fixture", payload: { kind: "inline", value: payload, hash: "fixture" } } });
  return callId;
}
async function fixture() {
  const facts: InputFactV1[] = [];
  const service = createDeliveryLedgerServiceV1(async () => ({ snapshot: snapshot(facts), evidence }));
  const add = { add: [{ text: "CLI round-trip works", source: "user" as const, ref: "user request" }], updates: [], reason: "User requirement" };
  const result = await service.apply(add);
  expect(result.ok).toBe(true);
  tool(facts, "workspace_acceptance_update", add, { updated: true, state: result.state! } as unknown as JsonValue);
  return { facts, service, update: (id: string) => ({ add: [], updates: [{ id: "acceptance-1", status: "satisfied" as const, evidence: id }], reason: "Observed result" }) };
}

test("links a real check, replays identically, invalidates after edits, and isolates the next work item", async () => {
  const { facts, service, update } = await fixture();
  const callId = tool(facts, "workspace_run_shell", { command: "npm test" }, { ...clean, exit_code: 0 });
  const result = await service.apply(update(callId));
  expect(result.ok).toBe(true);
  tool(facts, "workspace_acceptance_update", update(callId), { updated: true, state: result.state! } as unknown as JsonValue);
  const view = projectDeliveryLedgerV1(snapshot(facts))!;
  expect(view.content).toContain('"readiness":"evidence_linked"');
  expect(projectDeliveryLedgerV1(snapshot(structuredClone(facts)))).toEqual(view);
  tool(facts, "workspace_write_file", { path: "src/cli.js" }, { workspaceEffect: { changed: true, paths: ["src/cli.js"] } });
  expect(projectDeliveryLedgerV1(snapshot(facts))!.content).toContain('"readiness":"stale"');
  expect((await service.apply(update(callId))).ok).toBe(false);
  facts.push({ type: "work.segment_started", inputId: "next", segmentIndex: 1, reducerVersion: "v2", previousDecisionStateHash: "hash", previousAction: { kind: "complete", reasonCode: "done" }, policyVersion: "paw.work-segment.v1" });
  facts.push({ type: "input.promoted", inputId: "next", delivery: "queue", content: "new work", contentHash: "new" });
  expect(projectDeliveryLedgerV1(snapshot(facts))).toBeUndefined();
});

test("rejects fabricated, failed and masked checks; invalid updates are atomic", async () => {
  const { facts, service, update } = await fixture();
  for (const [command, exit] of [["npm test", 1], ["npm test | tail -20", 0], ["npm test; echo done", 0]] as const) {
    const id = tool(facts, "workspace_run_shell", { command }, { ...clean, exit_code: exit }, exit !== 0);
    expect((await service.apply(update(id))).ok).toBe(false);
  }
  expect((await service.apply(update("invented-call"))).ok).toBe(false);
  const before = projectDeliveryLedgerV1(snapshot(facts));
  expect((await service.apply({ add: [{ text: "Do not partially add", source: "user" }], updates: [{ id: "missing", status: "blocked" }], reason: "invalid" })).ok).toBe(false);
  expect(projectDeliveryLedgerV1(snapshot(facts))).toEqual(before);
});

test("successful writes cannot satisfy a condition, readback can, uncertain failed edits invalidate it", async () => {
  const { facts, service, update } = await fixture();
  const write = tool(facts, "workspace_write_file", { path: "README.md" }, { workspaceEffect: { changed: true, paths: ["README.md"] } });
  expect((await service.apply(update(write))).ok).toBe(false);
  const read = tool(facts, "workspace_read_file", { path: "README.md" }, { content: "Usage", line_count: 1, total_lines: 1 });
  expect((await service.apply(update(read))).ok).toBe(true);
  tool(facts, "workspace_edit_file", { path: "README.md" }, { error: "partial write failed" }, true);
  expect((await service.apply(update(read))).ok).toBe(false);
});

test("a newer failure for the same target supersedes an older pass without conflating directories", async () => {
  const { facts, service, update } = await fixture();
  const a = tool(facts, "workspace_run_shell", { command: "cd a && npm test" }, { ...clean, exit_code: 0 });
  tool(facts, "workspace_run_shell", { command: "cd b && npm test" }, { ...clean, exit_code: 1 }, true);
  expect((await service.apply(update(a))).ok).toBe(true);
  tool(facts, "workspace_run_shell", { command: "cd a && npm test" }, { ...clean, exit_code: 1 }, true);
  expect((await service.apply(update(a))).ok).toBe(false);
});

test("direct user entry commands provide scoped evidence without accepting masked pipeline status", async () => {
  const { facts, service, update } = await fixture();
  const direct = tool(facts, "workspace_run_shell", { command: "node src/cli.js list" }, { ...clean, exit_code: 0, stdout: "[]" });
  expect((await service.apply(update(direct))).ok).toBe(true);
  const masked = tool(facts, "workspace_run_shell", { command: "node src/cli.js list | tail -5" }, { ...clean, exit_code: 0, stdout: "[]" });
  expect((await service.apply(update(masked))).ok).toBe(false);
});

test("parallel overlap cannot count as fresh verification, including delayed job settlement", async () => {
  const { facts, service, update } = await fixture();
  const id = "parallel-check";
  facts.push({ type: "tool.call_observed", modelCallId: "model", callId: id, turn: 1, order: 0, tool: "workspace_run_shell", args: { command: "npm test" } });
  tool(facts, "workspace_write_file", { path: "code.js" }, { workspaceEffect: { changed: true, paths: ["code.js"] } });
  facts.push({ type: "tool.settled", callId: id, status: "completed", observation: { schemaVersion: "paw.tool-observation.v1", isError: false, summary: "passed", payload: { kind: "inline", hash: "fixture", value: { ...clean, exit_code: 0 } } } });
  expect((await service.apply(update(id))).ok).toBe(false);
  tool(facts, "workspace_job_start", { command: "npm test" }, { ...clean, jobId: "job-1" });
  tool(facts, "workspace_write_file", { path: "code.js" }, { workspaceEffect: { changed: true, paths: ["code.js"] } });
  const waited = tool(facts, "workspace_job_wait", { id: "job-1" }, { ...clean, jobId: "job-1", exit_code: 0 });
  expect((await service.apply(update(waited))).ok).toBe(false);
});

test("schema is bounded, ledger batches are serialized, and empty tasks add no context", async () => {
  const entry = createDeliveryLedgerPluginV1().entries[0]!;
  expect(entry.validate({ add: [], updates: [], reason: "empty" }).ok).toBe(false);
  expect(entry.validate({ add: [{ text: "x".repeat(301), source: "user" }], updates: [], reason: "long" }).ok).toBe(false);
  expect(projectDeliveryLedgerV1(snapshot([]))).toBeUndefined();
  const { facts, service } = await fixture();
  for (let i = 0; i < 2; i++) facts.push({ type: "tool.call_observed", modelCallId: "m", callId: `pending-${i}`, turn: 1, order: i, tool: "workspace_acceptance_update", args: {} });
  expect(inspectDeliveryLedgerV1(snapshot(facts)).pendingWrites).toBe(2);
  expect((await service.apply({ add: [{ text: "new", source: "user" }], updates: [], reason: "overlap" })).ok).toBe(false);
});

test("untrusted JSON enum values cannot bypass validation through string coercion", async () => {
  const entry = createDeliveryLedgerPluginV1().entries[0]!;
  const { facts, service } = await fixture();
  const before = projectDeliveryLedgerV1(snapshot(facts));
  const invalid = [
    { add: [{ text: "Array source", source: ["user"] }], updates: [], reason: "invalid source" },
    { add: [], updates: [{ id: "acceptance-1", status: ["satisfied"] }], reason: "invalid status" },
    { add: [], updates: [{ id: "acceptance-1", status: ["blocked"] }], reason: "invalid status" },
  ];
  for (const input of invalid) {
    expect(entry.validate(input).ok).toBe(false);
    // The service is also an input boundary, independent of the provider adapter.
    expect((await service.apply(input as unknown as Parameters<typeof service.apply>[0])).ok).toBe(false);
    expect(projectDeliveryLedgerV1(snapshot(facts))).toEqual(before);
  }
});

test("archived ledger uses verified payload evidence and bounded projection retains valid JSON", async () => {
  const { facts, service } = await fixture();
  const added = await service.apply({
    add: Array.from({ length: 31 }, (_, i) => ({ text: `${i}: ${"observable ".repeat(23)}`, source: "user" as const })),
    updates: [], reason: "Many distinct user requirements",
  });
  expect(added.ok).toBe(true);
  const payload = { updated: true, state: added.state! } as unknown as JsonValue;
  tool(facts, "workspace_acceptance_update", {}, payload);
  const last = facts.at(-1)!;
  if (last.type !== "tool.settled") throw new Error("fixture");
  // The evidence seam must be used rather than reading a payload path directly.
  facts[facts.length - 1] = { ...last, observation: { ...last.observation!, payload: { kind: "artifact_ref", hash: "verified", artifactRef: "archive.json" } } };
  let loads = 0;
  const verified = { requirePayload() { loads++; return payload; } } as unknown as VerifiedCanonicalPayloadEvidenceV1;
  const projected = projectDeliveryLedgerV1(snapshot(facts), verified)!;
  expect(loads).toBe(1);
  expect(projected.content.length).toBeLessThanOrEqual(6000);
  const data = JSON.parse(projected.content.split("\n").at(-1)!);
  expect(data.items.length + data.omittedItems).toBe(32);
  expect(data.omittedItems).toBeGreaterThan(0);
  expect(() => projectDeliveryLedgerV1(snapshot(facts))).toThrow("Missing canonical");
});
