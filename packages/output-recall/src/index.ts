import path from "node:path";

import type { ToolDefinition } from "@paw/core";
import {
  CONTEXT_RECALL,
  type PayloadRecallRequestV1,
  type PayloadRecallServiceV1,
  type ToolRunResult,
  toolDefinitions,
  validateToolArguments,
} from "@paw/harness";
import type { JsonValue, RunJournalEnvelopeV1 } from "@paw/protocol";
import {
  type RuntimeToolPluginEntryV1,
  type RuntimeToolPluginV1,
  type ToolObservationProjectorV1,
  type VerifiedCanonicalPayloadEvidenceV1,
  canonicalRuntimeResourcePathV1,
  projectCanonicalDurableJsonPayloadBindingsV1,
  projectCanonicalSessionInputSnapshotV1,
} from "@paw/runtime";

export const OUTPUT_RECALL_TOOL_PLUGIN_ID_V1 = "paw.output-recall" as const;
export const OUTPUT_RECALL_TOOL_PLUGIN_VERSION_V1 =
  "paw.output-recall.v2:t12000:h3000:l2000:dt3000:dh1000:dl500:c8000:u32000:r256000" as const;
export const OUTPUT_RECALL_PROJECTION_SCHEMA_V1 =
  "paw.output-recall-stub.v1" as const;

export interface OutputRecallPolicyV1 {
  readonly previewThresholdChars: number;
  readonly previewHeadChars: number;
  readonly previewTailChars: number;
  readonly maxCharsPerRecall: number;
  readonly maxCharsPerTurn: number;
  readonly maxCharsPerRun: number;
}

export const DEFAULT_OUTPUT_RECALL_POLICY_V1: OutputRecallPolicyV1 =
  Object.freeze({
    previewThresholdChars: 12_000,
    previewHeadChars: 3_000,
    previewTailChars: 2_000,
    maxCharsPerRecall: 8_000,
    maxCharsPerTurn: 32_000,
    maxCharsPerRun: 256_000,
  });

export interface DurableOutputRecallServiceOptionsV1 {
  readonly readCanonicalPrefix: () =>
    | readonly RunJournalEnvelopeV1[]
    | Promise<readonly RunJournalEnvelopeV1[]>;
  readonly loadPayloadEvidence: (
    prefix: readonly RunJournalEnvelopeV1[],
    signal?: AbortSignal,
  ) =>
    | VerifiedCanonicalPayloadEvidenceV1
    | Promise<VerifiedCanonicalPayloadEvidenceV1>;
  readonly policy?: OutputRecallPolicyV1;
}

const ARTIFACT_REF = /^paw-payload:v1:[0-9a-f]{64}$/;
const PROVIDER_TOOL_NAME = CONTEXT_RECALL.replaceAll(".", "_");
const DELEGATED_OUTPUT_TOOLS = new Set([
  "workspace_delegate",
  "workspace_run_agent",
]);
const DELEGATED_PREVIEW_THRESHOLD_CHARS_V1 = 3_000;
const DELEGATED_PREVIEW_HEAD_CHARS_V1 = 1_000;
const DELEGATED_PREVIEW_TAIL_CHARS_V1 = 500;

/** Model-visible plugin only; execution remains in Harness via a neutral port. */
export function createOutputRecallToolPluginV1(input?: {
  readonly policy?: OutputRecallPolicyV1;
}): RuntimeToolPluginV1 {
  const policy = freezeOutputRecallPolicyV1(
    input?.policy ?? DEFAULT_OUTPUT_RECALL_POLICY_V1,
  );
  return Object.freeze({
    schemaVersion: "paw.runtime-tool-plugin.v1",
    pluginId: OUTPUT_RECALL_TOOL_PLUGIN_ID_V1,
    pluginVersion: outputRecallPluginVersion(policy),
    entries: Object.freeze([createRecallEntry(policy)]),
  });
}

/** Replaces only the model view of large durable tool observations. */
export function createOutputRecallProjectorV1(input?: {
  readonly policy?: OutputRecallPolicyV1;
}): ToolObservationProjectorV1 {
  const policy = freezeOutputRecallPolicyV1(
    input?.policy ?? DEFAULT_OUTPUT_RECALL_POLICY_V1,
  );
  const projector: ToolObservationProjectorV1 = {
    project(observation, signal) {
      throwIfAborted(signal);
      const text = canonicalJsonStringify(observation.value);
      const preview = projectionPreviewPolicyV1(observation.tool, policy);
      if (
        observation.tool === PROVIDER_TOOL_NAME ||
        observation.payload.kind !== "artifact_ref" ||
        text.length <= preview.thresholdChars
      ) {
        return observation.value;
      }
      const id = observation.payload.artifactRef;
      return Object.freeze({
        schemaVersion: OUTPUT_RECALL_PROJECTION_SCHEMA_V1,
        kind: "large_tool_output",
        id,
        source: Object.freeze({
          tool: observation.tool,
          callId: observation.callId,
        }),
        totalChars: text.length,
        preview: Object.freeze({
          head: text.slice(0, preview.headChars),
          tail: text.slice(-preview.tailChars),
        }),
        recall: Object.freeze({
          tool: PROVIDER_TOOL_NAME,
          parts: Object.freeze(["head", "tail", "chunk"]),
          maxCharsPerCall: policy.maxCharsPerRecall,
          instruction:
            "Call context_recall with this exact id; use part=chunk and offset to continue.",
        }),
      });
    },
  };
  return Object.freeze(projector);
}

/**
 * Resolves exact Journal-bound artifact references. No path, fuzzy search, or
 * secondary durable index is accepted as authority.
 */
export function createDurableOutputRecallServiceV1(
  options: DurableOutputRecallServiceOptionsV1,
): PayloadRecallServiceV1 {
  const policy = freezeOutputRecallPolicyV1(
    options.policy ?? DEFAULT_OUTPUT_RECALL_POLICY_V1,
  );
  if (typeof options.readCanonicalPrefix !== "function") {
    throw new Error("Output recall canonical-prefix reader is invalid");
  }
  if (typeof options.loadPayloadEvidence !== "function") {
    throw new Error("Output recall payload-evidence loader is invalid");
  }
  const readCanonicalPrefix = options.readCanonicalPrefix.bind(options);
  const loadPayloadEvidence = options.loadPayloadEvidence.bind(options);

  const service: PayloadRecallServiceV1 = {
    async recall(request, signal) {
      throwIfAborted(signal);
      const parsed = parseRecallRequest(request, policy);
      if (!parsed.ok) return parsed;
      const prefix = await readCanonicalPrefix();
      throwIfAborted(signal);
      const authority = projectRecallAuthority(prefix, parsed.request, policy);
      if (!authority.ok) return authority;

      const occurrences = projectCanonicalDurableJsonPayloadBindingsV1(prefix);
      const matches = occurrences.filter(
        (occurrence) =>
          occurrence.location.kind === "tool_observation" &&
          occurrence.payload.kind === "artifact_ref" &&
          occurrence.payload.artifactRef === parsed.request.id,
      );
      if (matches.length !== 1) {
        return failure("unknown or non-unique output id");
      }
      const occurrence = matches[0];
      if (!occurrence || occurrence.location.kind !== "tool_observation") {
        return failure("output id is not a tool observation");
      }
      const producer = findObservedTool(prefix, occurrence.location.callId);
      if (!producer || producer.tool === PROVIDER_TOOL_NAME) {
        return failure("output id is not recallable");
      }

      const evidence = await loadPayloadEvidence(prefix, signal);
      throwIfAborted(signal);
      const value = evidence.requirePayload({
        snapshot: projectCanonicalSessionInputSnapshotV1(prefix),
        location: occurrence.location,
        payload: occurrence.payload,
      });
      const text = canonicalJsonStringify(value);
      const window = selectWindow(text, parsed.request);
      return Object.freeze({
        ok: true as const,
        id: parsed.request.id,
        tool: producer.tool,
        callId: producer.callId,
        content: window.content,
        part: parsed.request.part,
        offset: window.offset,
        length: window.content.length,
        total: text.length,
      });
    },
  };
  return Object.freeze(service);
}

export function freezeOutputRecallPolicyV1(
  input: OutputRecallPolicyV1,
): OutputRecallPolicyV1 {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).sort().join("\0") !==
      "maxCharsPerRecall\0maxCharsPerRun\0maxCharsPerTurn\0previewHeadChars\0previewTailChars\0previewThresholdChars"
  ) {
    throw new Error("Output recall policy is invalid");
  }
  const values = [
    input?.previewThresholdChars,
    input?.previewHeadChars,
    input?.previewTailChars,
    input?.maxCharsPerRecall,
    input?.maxCharsPerTurn,
    input?.maxCharsPerRun,
  ];
  if (
    values.some(
      (value) => !Number.isSafeInteger(value) || (value as number) <= 0,
    ) ||
    input.previewHeadChars + input.previewTailChars >
      input.previewThresholdChars ||
    input.maxCharsPerRecall > input.maxCharsPerTurn ||
    input.maxCharsPerTurn > input.maxCharsPerRun
  ) {
    throw new Error("Output recall policy is invalid");
  }
  return Object.freeze({ ...input });
}

function outputRecallPluginVersion(policy: OutputRecallPolicyV1): string {
  if (policy === DEFAULT_OUTPUT_RECALL_POLICY_V1) {
    return OUTPUT_RECALL_TOOL_PLUGIN_VERSION_V1;
  }
  return [
    "paw.output-recall.v2",
    `t${policy.previewThresholdChars}`,
    `h${policy.previewHeadChars}`,
    `l${policy.previewTailChars}`,
    `dt${DELEGATED_PREVIEW_THRESHOLD_CHARS_V1}`,
    `dh${DELEGATED_PREVIEW_HEAD_CHARS_V1}`,
    `dl${DELEGATED_PREVIEW_TAIL_CHARS_V1}`,
    `c${policy.maxCharsPerRecall}`,
    `u${policy.maxCharsPerTurn}`,
    `r${policy.maxCharsPerRun}`,
  ].join(":");
}

function projectionPreviewPolicyV1(
  tool: string,
  policy: OutputRecallPolicyV1,
): Readonly<{
  thresholdChars: number;
  headChars: number;
  tailChars: number;
}> {
  if (!DELEGATED_OUTPUT_TOOLS.has(tool)) {
    return Object.freeze({
      thresholdChars: policy.previewThresholdChars,
      headChars: policy.previewHeadChars,
      tailChars: policy.previewTailChars,
    });
  }
  return Object.freeze({
    thresholdChars: Math.min(
      policy.previewThresholdChars,
      DELEGATED_PREVIEW_THRESHOLD_CHARS_V1,
    ),
    headChars: Math.min(
      policy.previewHeadChars,
      DELEGATED_PREVIEW_HEAD_CHARS_V1,
    ),
    tailChars: Math.min(
      policy.previewTailChars,
      DELEGATED_PREVIEW_TAIL_CHARS_V1,
    ),
  });
}

function createRecallEntry(
  policy: OutputRecallPolicyV1,
): RuntimeToolPluginEntryV1 {
  const canonical = toolDefinitions().find(
    (item) => item.function.name === PROVIDER_TOOL_NAME,
  );
  if (!canonical) throw new Error("Harness context.recall schema is missing");
  const definition: ToolDefinition = {
    ...canonical,
    function: {
      ...canonical.function,
      description:
        "Read a bounded window from a large durable tool output. Use the exact id shown in a large_tool_output stub. Page with part=chunk and offset.",
    },
  };
  const entry: RuntimeToolPluginEntryV1 = {
    internalName: CONTEXT_RECALL,
    providerName: PROVIDER_TOOL_NAME,
    definition,
    deferred: false,
    resultPolicy: "bounded_json",
    executionKind: "harness",
    validate(args) {
      const schemaError = validateToolArguments(CONTEXT_RECALL, args);
      if (schemaError) return { ok: false, result: schemaError };
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        return invalid("arguments must be an object");
      }
      const record = args as Record<string, unknown>;
      const id = typeof record.id === "string" ? record.id.trim() : "";
      const part = record.part ?? "head";
      const offset = record.offset ?? 0;
      const limit = record.limit ?? policy.maxCharsPerRecall;
      if (!ARTIFACT_REF.test(id))
        return invalid("id must be an exact durable output id");
      if (part !== "head" && part !== "tail" && part !== "chunk") {
        return invalid("part must be head, tail, or chunk");
      }
      if (!Number.isSafeInteger(offset) || (offset as number) < 0) {
        return invalid("offset must be a non-negative safe integer");
      }
      if (
        !Number.isSafeInteger(limit) ||
        (limit as number) < 1 ||
        (limit as number) > policy.maxCharsPerRecall
      ) {
        return invalid(
          `limit must be between 1 and ${policy.maxCharsPerRecall}`,
        );
      }
      return {
        ok: true as const,
        args: Object.freeze({
          id,
          part,
          offset: offset as number,
          limit: limit as number,
        }),
      };
    },
    classify(_args, workspaceRoot) {
      const root = canonicalRuntimeResourcePathV1(workspaceRoot);
      return {
        lockDomain: root,
        effectClass: "read",
        permissionCategory: "read",
        concurrencyMode: "exclusive",
        resources: [
          {
            key: path.join(
              root,
              ".paw",
              "paw-next",
              "durable-json-payloads",
              "*",
            ),
            access: "read",
          },
        ],
      };
    },
  };
  return Object.freeze(entry);
}

function parseRecallRequest(
  request: PayloadRecallRequestV1,
  policy: OutputRecallPolicyV1,
):
  | { readonly ok: true; readonly request: PayloadRecallRequestV1 }
  | { readonly ok: false; readonly reason: string } {
  if (!ARTIFACT_REF.test(request.id)) return failure("invalid output id");
  if (
    request.part !== "head" &&
    request.part !== "tail" &&
    request.part !== "chunk"
  ) {
    return failure("invalid recall part");
  }
  if (!Number.isSafeInteger(request.offset) || request.offset < 0) {
    return failure("invalid recall offset");
  }
  if (
    !Number.isSafeInteger(request.limit) ||
    request.limit < 1 ||
    request.limit > policy.maxCharsPerRecall
  ) {
    return failure("invalid recall limit");
  }
  return { ok: true, request: Object.freeze({ ...request }) };
}

function projectRecallAuthority(
  prefix: readonly RunJournalEnvelopeV1[],
  request: PayloadRecallRequestV1,
  policy: OutputRecallPolicyV1,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  const observed = new Map<
    string,
    { readonly turn: number; readonly request: PayloadRecallRequestV1 }
  >();
  const settledError = new Map<string, boolean>();
  for (const envelope of prefix) {
    if (envelope.record.kind !== "input_fact") continue;
    const fact = envelope.record.fact;
    if (
      fact.type === "tool.call_observed" &&
      fact.tool === PROVIDER_TOOL_NAME
    ) {
      const parsed = parseObservedRecallRequest(fact.args, policy);
      if (parsed)
        observed.set(fact.callId, { turn: fact.turn, request: parsed });
    } else if (fact.type === "tool.settled") {
      settledError.set(fact.callId, fact.observation?.isError ?? false);
    }
  }

  const matchingPending = [...observed.entries()].some(
    ([callId, item]) =>
      !settledError.has(callId) && sameRecallRequest(item.request, request),
  );
  if (!matchingPending)
    return failure("recall request is not canonically pending");

  let runChars = 0;
  const turnChars = new Map<number, number>();
  for (const [callId, item] of observed) {
    if (settledError.get(callId) === true) continue;
    runChars += item.request.limit;
    turnChars.set(
      item.turn,
      (turnChars.get(item.turn) ?? 0) + item.request.limit,
    );
  }
  if (runChars > policy.maxCharsPerRun) {
    return failure("run recall budget exceeded");
  }
  if ([...turnChars.values()].some((chars) => chars > policy.maxCharsPerTurn)) {
    return failure("turn recall budget exceeded");
  }
  return { ok: true };
}

function parseObservedRecallRequest(
  args: JsonValue,
  policy: OutputRecallPolicyV1,
): PayloadRecallRequestV1 | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args))
    return undefined;
  const record = args as Readonly<Record<string, JsonValue>>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const part = record.part ?? "head";
  const offset = record.offset ?? 0;
  const limit = record.limit ?? policy.maxCharsPerRecall;
  if (
    !ARTIFACT_REF.test(id) ||
    (part !== "head" && part !== "tail" && part !== "chunk") ||
    !Number.isSafeInteger(offset) ||
    (offset as number) < 0 ||
    !Number.isSafeInteger(limit) ||
    (limit as number) < 1 ||
    (limit as number) > policy.maxCharsPerRecall
  ) {
    return undefined;
  }
  return Object.freeze({
    id,
    part,
    offset: offset as number,
    limit: limit as number,
  });
}

function findObservedTool(
  prefix: readonly RunJournalEnvelopeV1[],
  callId: string,
): { readonly callId: string; readonly tool: string } | undefined {
  for (const envelope of prefix) {
    if (
      envelope.record.kind === "input_fact" &&
      envelope.record.fact.type === "tool.call_observed" &&
      envelope.record.fact.callId === callId
    ) {
      return {
        callId,
        tool: envelope.record.fact.tool,
      };
    }
  }
  return undefined;
}

function selectWindow(
  text: string,
  request: PayloadRecallRequestV1,
): { readonly content: string; readonly offset: number } {
  const offset =
    request.part === "tail"
      ? Math.max(0, text.length - request.limit)
      : request.part === "chunk"
        ? Math.min(request.offset, text.length)
        : 0;
  return {
    offset,
    content: text.slice(offset, offset + request.limit),
  };
}

function sameRecallRequest(
  left: PayloadRecallRequestV1,
  right: PayloadRecallRequestV1,
): boolean {
  return (
    left.id === right.id &&
    left.part === right.part &&
    left.offset === right.offset &&
    left.limit === right.limit
  );
}

function invalid(message: string): {
  readonly ok: false;
  readonly result: ToolRunResult;
} {
  return {
    ok: false,
    result: {
      ok: false,
      summary: `context.recall: ${message}`,
      payload: { code: "E_SCHEMA_INVALID", message, executed: false },
    },
  };
}

function failure(reason: string): {
  readonly ok: false;
  readonly reason: string;
} {
  return { ok: false, reason };
}

function canonicalJsonStringify(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJsonStringify).join(",")}]`;
  }
  const record = value as Readonly<Record<string, JsonValue>>;
  return `{${Object.keys(record)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJsonStringify(record[key] as JsonValue)}`,
    )
    .join(",")}}`;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Output recall aborted", "AbortError");
}
