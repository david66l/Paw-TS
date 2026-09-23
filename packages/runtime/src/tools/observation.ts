import type { ToolSettlement } from "@paw/agent-loop";
import {
  type DurableJsonPayloadV1,
  type JsonValue,
  TOOL_OBSERVATION_SCHEMA_VERSION_V1,
  type ToolSettledFactV1,
} from "@paw/protocol";
import type { ToolRunResult } from "@paw/tools";

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
  const evidence = settlement.status === "success" ? settlement.result : settlement.evidence;
  const summary = evidence?.summary ?? settlementSummary(settlement);
  const payload =
    evidence === undefined
      ? undefined
      : encoder.encode(toJsonValue(evidence.payload, "tool payload", new Set()));
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

/**
 * 执行器自己给出的语义 code（`E_TOOL_EXECUTOR_BOUNDARY` 等）。
 *
 * 它比 `error.name` 精确：`error.name` 对裸 `throw new Error(x)` 就是字符串
 * "Error"，写进 `errorCode` 等于铸出一个看起来合法、实际没有分类信息的 id。
 */
function evidenceErrorCode(evidence: ToolRunResult | undefined): string | undefined {
  const payload: unknown = evidence?.payload;
  if (payload === null || typeof payload !== "object") return undefined;
  const code = (payload as { code?: unknown }).code;
  return typeof code === "string" ? normalizeErrorCode(code, "E_TOOL_UNKNOWN") : undefined;
}

function canonicalErrorCode(settlement: ToolSettlement<ToolRunResult>): string | undefined {
  switch (settlement.status) {
    case "success":
      return undefined;
    case "failed":
      return (
        evidenceErrorCode(settlement.evidence) ??
        normalizeErrorCode(settlement.error.name, "E_TOOL_FAILED")
      );
    case "denied":
      return "E_TOOL_REJECTED";
    case "cancelled":
      return "E_TOOL_CANCELLED";
    case "unknown":
      // 执行器的 code 此前根本到不了 journal：这里对所有 unknown 硬编码，
      // 于是崩溃恢复看到的分类永远是 E_TOOL_UNKNOWN。
      return evidenceErrorCode(settlement.evidence) ?? "E_TOOL_UNKNOWN";
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

/**
 * JS 内建错误类名。它们不携带分类信息，不能当成 error code 用。
 *
 * `errorCode` 对崩溃恢复是承重的（journal 用它判断崩溃后能否开启新的 work
 * segment），所以宁可当场回退到一个明确的兜底值，也不要让每个未分类失败
 * 都塌缩成同一个 `errorCode: "Error"`。
 */
const GENERIC_ERROR_NAMES: ReadonlySet<string> = new Set(["Error"]);

function normalizeErrorCode(value: string, fallback: string): string {
  const normalized = value.trim().replace(/[^A-Za-z0-9._:@/-]/g, "_");
  if (!normalized || !/^[A-Za-z0-9]/.test(normalized)) return fallback;
  if (GENERIC_ERROR_NAMES.has(normalized)) return fallback;
  return normalized.slice(0, 512);
}

function toJsonValue(value: unknown, field: string, seen: Set<object>): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
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
      return value.map((item, index) => toJsonValue(item, `${field}[${index}]`, seen));
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
