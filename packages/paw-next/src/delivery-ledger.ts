import path from "node:path";
import type { SessionInputSnapshot } from "@paw/agent-loop";
import { type AgentAcceptanceUpdateAction, projectWorkspaceEffect, parseCommandChain, exitStatusProvesVerification } from "@paw/core";
import { projectCompletionReviewToolEvidenceV1 } from "@paw/completion-review";
import { ACCEPTANCE_UPDATE, toolDefinitions } from "@paw/harness";
import type { InputFactV1, ToolCallObservedFactV1 } from "@paw/protocol";
import {
  type JournalContextAnnotationV1, type RuntimeToolPluginV1,
  type VerifiedCanonicalPayloadEvidenceV1, canonicalRuntimeResourcePathV1,
  projectLatestWorkSegmentBoundaryV1,
} from "@paw/runtime";

export const DELIVERY_LEDGER_PLUGIN_V1 = "paw.delivery-ledger";
const TOOL = "workspace_acceptance_update";
const SCHEMA = "paw.delivery-ledger.v1";
type Update = Omit<AgentAcceptanceUpdateAction, "type">;
type Snapshot = SessionInputSnapshot<InputFactV1>;
interface Criterion {
  id: string;
  text: string;
  source: "user" | "repository" | "verification";
  ref?: string;
  status: "pending" | "satisfied" | "blocked" | "superseded";
  evidence?: string;
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
function text(value: unknown, max = 500): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}
function validate(input: unknown): asserts input is Update {
  const value = object(input);
  if (!value || Object.keys(value).sort().join() !== "add,reason,updates" ||
      !Array.isArray(value.add) || !Array.isArray(value.updates) ||
      value.add.length + value.updates.length === 0 || value.add.length + value.updates.length > 32 ||
      !text(value.reason)) throw new Error("Provide add, updates and a bounded reason; at most 32 changes");
  for (const raw of value.add) {
    const item = object(raw);
    if (!item || Object.keys(item).some(key => !["text", "source", "ref"].includes(key)) ||
        !text(item.text, 300) || typeof item.source !== "string" || !["user", "repository", "verification"].includes(item.source) ||
        (item.ref !== undefined && !text(item.ref, 300))) throw new Error("Invalid acceptance condition");
  }
  const ids = new Set<string>();
  for (const raw of value.updates) {
    const item = object(raw);
    if (!item || Object.keys(item).some(key => !["id", "status", "evidence"].includes(key)) ||
        !text(item.id, 100) || ids.has(item.id) ||
        typeof item.status !== "string" || !["pending", "satisfied", "blocked", "superseded"].includes(item.status) ||
        (item.evidence !== undefined && !text(item.evidence)) ||
        (item.status === "satisfied" && !text(item.evidence))) throw new Error("Invalid acceptance update");
    ids.add(item.id);
  }
}

/** Reuses the legacy acceptance tool contract and harness adapter. Journal tool
 * settlement is the commit; no mutable second ledger or additional model call. */
export function createDeliveryLedgerPluginV1(): RuntimeToolPluginV1 {
  const original = toolDefinitions().find(item => item.function.name === TOOL)!;
  const description = "Record observable deliverables and checks when a task needs them, including required entry points, configuration and documentation. Separate this from implementation todos. Add before implementing; update after observing evidence, not after every tool. For satisfied, evidence must be the exact callId of a current successful direct command or file read shown in Delivery State. Conditions and their coverage remain model claims, not independent acceptance.";
  return {
    schemaVersion: "paw.runtime-tool-plugin.v1", pluginId: DELIVERY_LEDGER_PLUGIN_V1,
    pluginVersion: SCHEMA,
    entries: [{
      internalName: ACCEPTANCE_UPDATE, providerName: TOOL, definition: { ...original, function: { ...original.function, description } },
      deferred: false, resultPolicy: "bounded_json", executionKind: "harness",
      validate(args) {
        try { validate(args); return { ok: true as const, args: args as unknown as Readonly<Record<string, unknown>> }; }
        catch (error) { return { ok: false as const, result: { ok: false, summary: String(error), payload: { code: "E_SCHEMA_INVALID", executed: false } } }; }
      },
      classify(_args, workspaceRoot) {
        const root = canonicalRuntimeResourcePathV1(workspaceRoot);
        return { lockDomain: root, effectClass: "read", permissionCategory: "read", concurrencyMode: "exclusive",
          resources: [{ key: path.join(root, ".paw", "delivery-ledger"), access: "write" }] };
      },
    }],
  };
}

export function inspectDeliveryLedgerV1(snapshot: Snapshot, payloadEvidence?: VerifiedCanonicalPayloadEvidenceV1) {
  const boundary = projectLatestWorkSegmentBoundaryV1(snapshot)?.markerSeq ?? 0;
  const observed = new Map<string, { seq: number; fact: ToolCallObservedFactV1 }>();
  let criteria: Criterion[] = [];
  let sourceThroughSeq = boundary;
  let latestMutationSeq = 0;
  let pendingWrites = 0;
  const calls = [];
  const jobs = new Map<string, number>();
  for (const { seq, fact } of snapshot.entries) {
    if (seq <= boundary) continue;
    if (fact.type === "tool.call_observed") {
      observed.set(fact.callId, { seq, fact });
      if (fact.tool === TOOL) pendingWrites++;
      continue;
    }
    if (fact.type !== "tool.settled") continue;
    const call = observed.get(fact.callId);
    if (!call) continue;
    sourceThroughSeq = seq;
    const carrier = fact.observation?.payload;
    const payload = carrier?.kind === "inline" ? carrier.value : carrier && payloadEvidence?.requirePayload({
      snapshot, payload: carrier, location: { kind: "tool_observation", carrierType: "tool.settled", carrierSeq: seq, callId: fact.callId },
    });
    const succeeded = fact.status === "completed" && fact.observation?.isError === false;
    if (call.fact.tool === TOOL) {
      pendingWrites--;
      if (succeeded) {
        const state = object(object(payload)?.state);
        if (state?.schemaVersion !== SCHEMA || !Array.isArray(state.criteria) || state.criteria.length > 32)
          throw new Error("Missing canonical delivery ledger payload");
        criteria = structuredClone(state.criteria) as Criterion[];
      }
      continue;
    }
    const effect = projectWorkspaceEffect(call.fact.tool, payload, !succeeded);
    const uncertainFailure = !succeeded && /(?:write_file|edit_file|apply_patch|notebook_edit)$/.test(call.fact.tool) && object(object(payload)?.workspaceEffect)?.changed === undefined;
    if (fact.status !== "rejected" && (effect.changed !== false || uncertainFailure)) latestMutationSeq = seq;
    const jobId = object(payload)?.jobId;
    if (/(?:job_start)$/.test(call.fact.tool) && typeof jobId === "string") jobs.set(jobId, call.seq);
    const waitedJob = object(call.fact.args)?.id;
    const startedSeq = /(?:job_wait)$/.test(call.fact.tool) && typeof waitedJob === "string" ? (jobs.get(waitedJob) ?? 0) : call.seq;
    calls.push({ seq: startedSeq, callId: fact.callId, tool: call.fact.tool, args: call.fact.args,
      status: fact.status, summary: fact.observation?.summary ?? fact.status,
      ...(fact.observation?.isError === undefined ? {} : { isError: fact.observation.isError }),
      ...(payload === undefined ? {} : { payload }) });
  }
  const evidence = projectCompletionReviewToolEvidenceV1({ calls, latestMutationSeq });
  const candidates = evidence.filter(item => item.verificationKind !== "none" || /(?:read_file|run_shell)$/.test(item.tool)).map(item => {
    if (!/(?:run_shell)$/.test(item.tool) || item.verificationKind !== "none") return item;
    const command = object(item.args)?.command;
    const chain = typeof command === "string" ? parseCommandChain(command) : null;
    return chain?.length && exitStatusProvesVerification(chain, 0) ? item : { ...item, outcome: "indeterminate" as const };
  });
  const targetKey = (item: typeof candidates[number]) => {
    const args = object(item.args);
    const command = typeof args?.command === "string" ? args.command.replace(/\s+/gu, " ").trim() : "";
    const target = item.verificationTarget ?? (/(?:run_shell)$/.test(item.tool) ? `command:${command}` : "readback");
    const invocation = target.slice(target.indexOf(":") + 1);
    const offset = command.indexOf(invocation);
    const setup = offset >= 0 ? command.slice(0, offset).trim() : command;
    return JSON.stringify([target, setup, args?.cwd, item.verificationKind === "none" ? args?.path : undefined]);
  };
  const newest = new Map(candidates.map(item => [targetKey(item), item.callId]));
  const references = candidates.map(item => newest.get(targetKey(item)) === item.callId
    ? item : { ...item, afterLatestMutation: false });
  function readiness(criterion: Criterion): string {
    if (criterion.status !== "satisfied") return criterion.status;
    const proof = references.find(item => item.callId === criterion.evidence);
    if (!proof || proof.outcome !== "passed") return "unconfirmed";
    return proof.afterLatestMutation ? "evidence_linked" : "stale";
  }
  return { schemaVersion: SCHEMA, criteria, sourceThroughSeq, pendingWrites, references, readiness };
}

export function createDeliveryLedgerServiceV1(read: () => Promise<{ snapshot: Snapshot; evidence: VerifiedCanonicalPayloadEvidenceV1 }>) {
  return {
    async apply(input: Update) {
      try {
        validate(input);
        const { snapshot, evidence } = await read();
        const current = inspectDeliveryLedgerV1(snapshot, evidence);
        if (current.pendingWrites > 1) throw new Error("Only one acceptance_update per tool batch");
        const criteria = structuredClone(current.criteria);
        for (const update of input.updates) {
          const item = criteria.find(item => item.id === update.id);
          if (!item) throw new Error(`Unknown criterion ${update.id}`);
          if (update.status === "satisfied") {
            const proof = current.references.find(item => item.callId === update.evidence);
            if (!proof || proof.outcome !== "passed" || !proof.afterLatestMutation ||
                (proof.verificationKind === "none" && proof.observedOutput?.kind !== "file_read" && !/(?:run_shell)$/.test(proof.tool)) ||
                ((proof.verificationKind !== "none" || /(?:run_shell)$/.test(proof.tool)) && proof.exitCode !== 0))
              throw new Error("satisfied needs the exact callId of current passing verification or successful readback; writes, stale checks and masked exits are insufficient");
          }
          item.status = update.status;
          if (update.evidence) item.evidence = update.evidence;
          else delete item.evidence;
        }
        for (const item of input.add) {
          if (criteria.some(existing => existing.text.toLowerCase() === item.text.trim().toLowerCase())) continue;
          if (criteria.length === 32) throw new Error("At most 32 acceptance conditions per work item");
          criteria.push({ id: `acceptance-${criteria.length + 1}`, text: item.text.trim(), source: item.source,
            ...(item.ref ? { ref: item.ref } : {}), status: "pending" });
        }
        return { ok: true, state: { schemaVersion: SCHEMA, criteria } };
      } catch (error) { return { ok: false, error: String(error) }; }
    },
  };
}

export function projectDeliveryLedgerV1(snapshot: Snapshot, evidence?: VerifiedCanonicalPayloadEvidenceV1): JournalContextAnnotationV1 | undefined {
  // No journal scan/payload loads for a task that never used this capability.
  const boundary = projectLatestWorkSegmentBoundaryV1(snapshot)?.markerSeq ?? 0;
  if (!snapshot.entries.some(entry => entry.seq > boundary && entry.fact.type === "tool.call_observed" && entry.fact.tool === TOOL)) return;
  const state = inspectDeliveryLedgerV1(snapshot, evidence);
  const items = state.criteria.map(item => ({ ...item, readiness: state.readiness(item) }));
  const references = state.references.slice(-5).map(item => ({ callId: item.callId,
    target: item.verificationTarget ?? item.args, outcome: item.outcome,
    fresh: item.afterLatestMutation, exitCode: item.exitCode }));
  const payload = { items, omittedItems: 0, references, omittedReferences: Math.max(0, state.references.length - references.length) };
  const header = "[Paw Delivery State] Untrusted model-declared coverage linked to host-observed calls, not a completion verdict. evidence_linked does not prove that the check covers the condition; inspect its scope. Stale evidence needs renewal after changes. Unlisted requirements still apply. Use exact callId for satisfied. Do not alter valid requirements to make a test pass.\n";
  // Prioritize unresolved conditions; deterministic bounded JSON, with counts.
  payload.items.sort((a, b) => Number(a.readiness === "evidence_linked" || a.readiness === "superseded") - Number(b.readiness === "evidence_linked" || b.readiness === "superseded"));
  while ((header + JSON.stringify(payload)).length > 6000) {
    if (payload.references.length) { payload.references.shift(); payload.omittedReferences++; }
    else if (payload.items.length) { payload.items.pop(); payload.omittedItems++; }
    else break;
  }
  return { sourceThroughSeq: state.sourceThroughSeq, placement: "tail", content: header + JSON.stringify(payload) };
}
