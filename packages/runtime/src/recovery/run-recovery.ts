import type {
  SessionInputSnapshot,
  VerifiedModelResponseEvidenceV1,
} from "@paw/agent-loop";
import {
  type InputFactV1,
  type JsonValue,
  type ModelResponseV1,
  type ModelSettledFactV1,
  type RunJournalEnvelopeV1,
  TOOL_OBSERVATION_SCHEMA_VERSION_V1,
  type ToolCallObservedFactV1,
  type ToolDispatchRecordedFactV1,
  type ToolPermissionResolvedFactV1,
  parseModelResponseV1,
  parseRunJournalPrefixV1,
} from "@paw/protocol";
import {
  canonicalJsonStringifyV1,
  immutableCanonicalJsonCloneV1,
} from "../context/canonical-json.js";
import { projectCanonicalSessionInputSnapshotV1 } from "../payload/verified-model-response-evidence.js";

export type RunRecoveryClassificationV1 =
  | Readonly<{
      status: "clean";
      expectedTailSeq: number;
    }>
  | Readonly<{
      status: "repair";
      expectedTailSeq: number;
      facts: readonly InputFactV1[];
    }>;

export interface RunRecoverySessionV1 {
  readCanonicalPrefix(): Promise<readonly RunJournalEnvelopeV1[]>;
  commitInputFacts(
    expectedTailSeq: number,
    facts: readonly InputFactV1[],
  ): Promise<"committed" | "conflict">;
}

export interface RepairRunRecoveryOptionsV1 {
  readonly session: RunRecoverySessionV1;
  readonly signal?: AbortSignal;
  readonly loadModelResponseEvidence?: (
    prefix: readonly RunJournalEnvelopeV1[],
    signal?: AbortSignal,
  ) =>
    | VerifiedModelResponseEvidenceV1
    | Promise<VerifiedModelResponseEvidenceV1>;
}

export interface ClassifyRunRecoveryOptionsV1 {
  readonly modelResponses?: VerifiedModelResponseEvidenceV1;
}

export type RepairRunRecoveryResultV1 = Readonly<{
  status: "clean" | "repaired";
  tailSeq: number;
  repairedFacts: readonly InputFactV1[];
}>;

interface ModelLifecycle {
  readonly modelCallId: string;
  readonly turn: number;
  settlementSeq?: number;
  settlement?: ModelSettledFactV1;
  readonly observed: ToolCallObservedFactV1[];
}

interface ToolLifecycle {
  readonly observed: ToolCallObservedFactV1;
  readonly observedSeq: number;
  dispatch?: ToolDispatchRecordedFactV1;
  permission?: ToolPermissionResolvedFactV1;
  settled: boolean;
}

/**
 * Classify one canonical prefix without I/O or provider/tool execution.
 * Protocol parsing is deliberately first, so damaged identity/order fails
 * closed before any repair facts are proposed.
 */
export function classifyRunRecoveryV1(
  prefix: readonly unknown[],
  options: ClassifyRunRecoveryOptionsV1 = {},
): RunRecoveryClassificationV1 {
  const parsed = parseRunJournalPrefixV1(prefix);
  const snapshot = projectCanonicalSessionInputSnapshotV1(parsed);
  const modelResponses = captureModelResponseEvidence(options.modelResponses);
  modelResponses?.assertSnapshot(snapshot);
  const models = new Map<string, ModelLifecycle>();
  const tools = new Map<string, ToolLifecycle>();

  for (const envelope of parsed) {
    if (envelope.record.kind !== "input_fact") continue;
    const fact = envelope.record.fact;
    switch (fact.type) {
      case "model.dispatch_recorded":
        assertNoLifecycleOverlap(models, tools);
        models.set(fact.modelCallId, {
          modelCallId: fact.modelCallId,
          turn: fact.turn,
          observed: [],
        });
        break;
      case "model.settled": {
        const model = models.get(fact.modelCallId);
        if (!model)
          throw new Error("Protocol parser accepted ghost model settlement");
        model.settlement = fact;
        model.settlementSeq = envelope.seq;
        break;
      }
      case "tool.call_observed": {
        const model = models.get(fact.modelCallId);
        if (!model)
          throw new Error("Protocol parser accepted orphan tool observation");
        model.observed.push(fact);
        tools.set(fact.callId, {
          observed: fact,
          observedSeq: envelope.seq,
          settled: false,
        });
        break;
      }
      case "tool.dispatch_recorded": {
        const tool = requiredTool(tools, fact.callId);
        tool.dispatch = fact;
        break;
      }
      case "tool.permission_resolved": {
        const tool = requiredTool(tools, fact.callId);
        tool.permission = fact;
        break;
      }
      case "tool.settled":
        requiredTool(tools, fact.callId).settled = true;
        break;
      default:
        break;
    }
  }

  const repairs: InputFactV1[] = [];
  for (const model of models.values()) {
    if (model.settlement) continue;
    repairs.push({
      type: "model.settled",
      modelCallId: model.modelCallId,
      turn: model.turn,
      status: "unknown",
      hasToolCalls: false,
      hasVisibleOutput: false,
      errorCode: "RecoveryModelOutcomeUnknown",
    });
  }

  const orderedTools = [...tools.values()].sort(
    (left, right) =>
      left.observedSeq - right.observedSeq ||
      left.observed.order - right.observed.order,
  );
  const repairModelIds = new Set(
    orderedTools
      .filter((tool) => !tool.settled)
      .map((tool) => tool.observed.modelCallId),
  );
  for (const modelCallId of repairModelIds) {
    const model = models.get(modelCallId);
    if (!model) throw new Error("Recovery tool repair has no model lifecycle");
    assertModelObservationEvidence(model, snapshot, modelResponses);
  }
  for (const tool of orderedTools) {
    if (tool.settled) continue;
    repairs.push(recoveryToolSettlement(tool));
  }

  const expectedTailSeq = parsed.at(-1)?.seq ?? 0;
  if (repairs.length === 0) {
    return Object.freeze({ status: "clean", expectedTailSeq });
  }
  const immutableFacts = Object.freeze(repairs.map(immutableInputFact));
  validateRepairedPrefix(parsed, immutableFacts);
  return Object.freeze({
    status: "repair",
    expectedTailSeq,
    facts: immutableFacts,
  });
}

function captureModelResponseEvidence(
  evidence: VerifiedModelResponseEvidenceV1 | undefined,
): VerifiedModelResponseEvidenceV1 | undefined {
  if (evidence === undefined) return undefined;
  if (
    !evidence ||
    typeof evidence.assertSnapshot !== "function" ||
    typeof evidence.requireModelResponse !== "function"
  ) {
    throw new Error("Recovery model response evidence port is invalid");
  }
  return Object.freeze({
    assertSnapshot: evidence.assertSnapshot.bind(evidence),
    requireModelResponse: evidence.requireModelResponse.bind(evidence),
  });
}

/** Fenced repair loop: one CAS per classification, then reread on conflict. */
export async function repairRunRecoveryV1(
  options: RepairRunRecoveryOptionsV1,
): Promise<RepairRunRecoveryResultV1> {
  const signal = options.signal;
  if (
    options.loadModelResponseEvidence !== undefined &&
    typeof options.loadModelResponseEvidence !== "function"
  ) {
    throw new Error("Recovery model response evidence loader is invalid");
  }
  const loadModelResponseEvidence =
    options.loadModelResponseEvidence?.bind(options);
  for (;;) {
    throwIfAborted(signal);
    const prefix = immutableCanonicalJsonCloneV1(
      parseRunJournalPrefixV1(
        await options.session.readCanonicalPrefix(),
      ) as unknown as JsonValue,
    ) as unknown as readonly RunJournalEnvelopeV1[];
    throwIfAborted(signal);
    const modelResponses = loadModelResponseEvidence
      ? await loadModelResponseEvidence(prefix, signal)
      : undefined;
    throwIfAborted(signal);
    const classification = classifyRunRecoveryV1(prefix, { modelResponses });
    if (classification.status === "clean") {
      return Object.freeze({
        status: "clean",
        tailSeq: classification.expectedTailSeq,
        repairedFacts: Object.freeze([]),
      });
    }
    throwIfAborted(signal);
    const committed = await options.session.commitInputFacts(
      classification.expectedTailSeq,
      classification.facts,
    );
    if (committed === "conflict") continue;
    return Object.freeze({
      status: "repaired",
      tailSeq: classification.expectedTailSeq + classification.facts.length,
      repairedFacts: classification.facts,
    });
  }
}

function recoveryToolSettlement(tool: ToolLifecycle): InputFactV1 {
  if (!tool.dispatch) {
    return toolSettlement(
      tool.observed.callId,
      "cancelled",
      "RecoveryToolNotDispatched",
      "Interrupted before durable tool dispatch; execution was not attempted.",
    );
  }
  if (!tool.permission) {
    return toolSettlement(
      tool.observed.callId,
      "cancelled",
      "RecoveryToolPermissionMissing",
      "Interrupted before durable tool permission resolution; execution was not attempted.",
    );
  }
  if (tool.permission.resolution === "deny") {
    return toolSettlement(
      tool.observed.callId,
      "rejected",
      "RecoveryToolPermissionDenied",
      "Tool execution was durably denied before recovery.",
    );
  }
  return toolSettlement(
    tool.observed.callId,
    "unknown",
    "RecoveryToolOutcomeUnknown",
    "Tool dispatch was allowed, but no durable execution outcome exists.",
  );
}

function toolSettlement(
  callId: string,
  status: "cancelled" | "rejected" | "unknown",
  errorCode: string,
  summary: string,
): InputFactV1 {
  return {
    type: "tool.settled",
    callId,
    status,
    errorCode,
    observation: {
      schemaVersion: TOOL_OBSERVATION_SCHEMA_VERSION_V1,
      summary,
      isError: true,
    },
  };
}

function requiredTool(
  tools: ReadonlyMap<string, ToolLifecycle>,
  callId: string,
): ToolLifecycle {
  const tool = tools.get(callId);
  if (!tool) throw new Error("Protocol parser accepted ghost tool lifecycle");
  return tool;
}

function immutableInputFact(fact: InputFactV1): InputFactV1 {
  return immutableCanonicalJsonCloneV1(
    fact as unknown as JsonValue,
  ) as InputFactV1;
}

function assertNoLifecycleOverlap(
  models: ReadonlyMap<string, ModelLifecycle>,
  tools: ReadonlyMap<string, ToolLifecycle>,
): void {
  if ([...models.values()].some((model) => !model.settlement)) {
    throw new Error("Recovery found overlapping model dispatches");
  }
  if ([...tools.values()].some((tool) => !tool.settled)) {
    throw new Error(
      "Recovery found a new model dispatch before the prior tool batch settled",
    );
  }
}

function assertModelObservationEvidence(
  model: ModelLifecycle,
  snapshot: SessionInputSnapshot<InputFactV1>,
  modelResponses?: VerifiedModelResponseEvidenceV1,
): void {
  const settlement = model.settlement;
  if (!settlement) return;
  if (settlement.response === undefined) {
    if (model.observed.length > 0) {
      throw new Error(
        `Recovery found tool observations without an inline model response: ${model.modelCallId}`,
      );
    }
    return;
  }
  const response = modelResponses
    ? modelResponses.requireModelResponse({
        snapshot,
        carrierSeq: requiredSettlementSeq(model),
        modelCallId: model.modelCallId,
        payload: settlement.response,
      })
    : settlement.response.kind === "inline"
      ? parseModelResponseV1(settlement.response.value)
      : undefined;
  if (!response) {
    throw new Error(
      `Recovery cannot verify artifact model response: ${model.modelCallId}`,
    );
  }
  assertModelResponseToolFlag(model, settlement, response);
  if (settlement.status !== "completed") {
    if (model.observed.length > 0) {
      throw new Error(
        `Recovery found executable tool observations on a non-completed model response: ${model.modelCallId}`,
      );
    }
    return;
  }
  if (response.toolCalls.some((call) => !call.argumentsValid)) {
    if (model.observed.length > 0) {
      throw new Error(
        `Recovery found observed tools for an invalid native tool batch: ${model.modelCallId}`,
      );
    }
    return;
  }
  if (response.toolCalls.length !== model.observed.length) {
    throw new Error(
      `Recovery model response/observation call count mismatch: ${model.modelCallId}`,
    );
  }
  for (let index = 0; index < response.toolCalls.length; index += 1) {
    const nativeCall = response.toolCalls[index];
    const observed = model.observed[index];
    if (
      !nativeCall ||
      !observed ||
      nativeCall.callId !== observed.callId ||
      nativeCall.name !== observed.tool ||
      nativeCall.sourceIndex !== observed.order ||
      nativeCall.argumentsValid !== true ||
      canonicalJsonStringifyV1(nativeCall.args) !==
        canonicalJsonStringifyV1(observed.args)
    ) {
      throw new Error(
        `Recovery native tool identity mismatch: ${observed?.callId ?? nativeCall?.callId ?? index}`,
      );
    }
  }
}

function requiredSettlementSeq(model: ModelLifecycle): number {
  if (!model.settlementSeq) {
    throw new Error("Recovery model settlement carrier is missing");
  }
  return model.settlementSeq;
}

function assertModelResponseToolFlag(
  model: ModelLifecycle,
  settlement: ModelSettledFactV1,
  response: ModelResponseV1,
): void {
  if (settlement.hasToolCalls !== response.toolCalls.length > 0) {
    throw new Error(
      `Recovery model response tool-call flag mismatch: ${model.modelCallId}`,
    );
  }
}

function validateRepairedPrefix(
  prefix: readonly RunJournalEnvelopeV1[],
  facts: readonly InputFactV1[],
): void {
  const latest = prefix.at(-1);
  if (!latest) throw new Error("Recovery facts require a non-empty prefix");
  parseRunJournalPrefixV1([
    ...prefix,
    ...facts.map(
      (fact, index): RunJournalEnvelopeV1 => ({
        schemaVersion: latest.schemaVersion,
        sessionId: latest.sessionId,
        runId: latest.runId,
        seq: latest.seq + index + 1,
        ts: latest.ts,
        record: { kind: "input_fact", fact },
      }),
    ),
  ]);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error(
    `Run recovery aborted: ${String(signal.reason ?? "aborted")}`,
  );
}
