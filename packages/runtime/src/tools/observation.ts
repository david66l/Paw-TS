import type { ToolSettlement } from "@paw/agent-loop";
import type { ToolRunResult } from "@paw/harness";
import {
  type DurableJsonPayloadV1,
  type JsonValue,
  TOOL_OBSERVATION_SCHEMA_VERSION_V1,
  type ToolSettledFactV1,
} from "@paw/protocol";

/** The storage layer decides whether JSON remains inline or becomes an artifact. */
export interface DurableJsonEncoderV1 {
  encode(value: JsonValue): DurableJsonPayloadV1;
}

/**
 * Convert one proven in-process result into the durable facts needed by Context.
 * `newMessages` is intentionally ignored: tool data cannot create chat roles.
 */
export function toDurableToolSettlementV1(
  settlement: ToolSettlement<ToolRunResult>,
  encoder: DurableJsonEncoderV1,
): Omit<ToolSettledFactV1, "type"> {
  const evidence =
    settlement.status === "success" ? settlement.result : settlement.evidence;
  const summary = evidence?.summary ?? settlementSummary(settlement);
  const payload =
    evidence === undefined
      ? undefined
      : encoder.encode(
          toJsonValue(evidence.payload, "tool payload", new Set()),
        );
  const status = canonicalStatus(settlement.status);
  const errorCode = canonicalErrorCode(settlement);
  return {
    callId: settlement.callId,
    status,
    ...(errorCode === undefined ? {} : { errorCode }),
    observation: {
      schemaVersion: TOOL_OBSERVATION_SCHEMA_VERSION_V1,
      summary,
      isError: settlement.status !== "success" || evidence?.ok === false,
      ...(payload === undefined ? {} : { payload }),
    },
  };
}

function canonicalStatus(
  status: ToolSettlement<ToolRunResult>["status"],
): ToolSettledFactV1["status"] {
  switch (status) {
    case "success":
      return "completed";
    case "denied":
      return "rejected";
    case "failed":
    case "cancelled":
    case "unknown":
      return status;
  }
}

function canonicalErrorCode(
  settlement: ToolSettlement<ToolRunResult>,
): string | undefined {
  switch (settlement.status) {
    case "success":
      return undefined;
    case "failed":
      return normalizeErrorCode(settlement.error.name, "E_TOOL_FAILED");
    case "denied":
      return "E_TOOL_REJECTED";
    case "cancelled":
      return "E_TOOL_CANCELLED";
    case "unknown":
      return "E_TOOL_UNKNOWN";
  }
}

function settlementSummary(settlement: ToolSettlement<ToolRunResult>): string {
  switch (settlement.status) {
    case "success":
      return settlement.result.summary;
    case "failed":
      return `${settlement.error.name}: ${settlement.error.message}`;
    case "denied":
    case "cancelled":
    case "unknown":
      return settlement.reason;
  }
}

function normalizeErrorCode(value: string, fallback: string): string {
  const normalized = value.trim().replace(/[^A-Za-z0-9._:@/-]/g, "_");
  return normalized && /^[A-Za-z0-9]/.test(normalized)
    ? normalized.slice(0, 512)
    : fallback;
}

function toJsonValue(
  value: unknown,
  field: string,
  seen: Set<object>,
): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${field} must be valid JSON`);
    return value;
  }
  if (typeof value !== "object") {
    throw new Error(`${field} must be JSON-serializable`);
  }
  if (seen.has(value)) throw new Error(`${field} contains a cycle`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) =>
        toJsonValue(item, `${field}[${index}]`, seen),
      );
    }
    const out: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = toJsonValue(item, `${field}.${key}`, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}
