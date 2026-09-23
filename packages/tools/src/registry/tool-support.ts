import { type ToolErrorCode, makeToolError } from "@paw/core";
/**
 * executeTool 与其处理器共用的参数解析与错误整形辅助。
 *
 * 从 `execution.ts` 抽出：处理器现在分布在 `handlers/` 下，若继续留在 dispatcher 里
 * 就会形成 import 环。`execution.ts` 会把公开的那几个原样再导出。
 */
import { toolDefinitions } from "./definitions.js";

import type { HarnessContext } from "../context.js";
import type { ToolRunResult } from "./definitions.js";

/** 一次工具执行的全部输入；处理器通过它取值，从而不必闭包捕获 executeTool 的局部变量。 */
export interface ToolScope {
  readonly ctx: HarnessContext;
  readonly rec: Record<string, unknown>;
  readonly tool: string;
  readonly args: unknown;
  readonly schemaError?: ToolRunResult;
}

export function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

export function num(v: unknown, d: number | undefined): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) {
    return v;
  }
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  }
  return d;
}

export function schemaForTool(tool: string): JsonObjectSchema | null {
  const sanitized = tool.replace(/\./g, "_");
  const def = toolDefinitions().find((d) => d.function.name === sanitized);
  const schema = def?.function.parameters;
  return schema && typeof schema === "object" ? (schema as JsonObjectSchema) : null;
}

export function matchesJsonType(value: unknown, expected: string): boolean {
  if (expected === "integer") {
    return Number.isInteger(value);
  }
  if (expected === "array") {
    return Array.isArray(value);
  }
  if (expected === "object") {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
  if (expected === "boolean") {
    return typeof value === "boolean";
  }
  if (expected === "number") {
    return typeof value === "number";
  }
  if (expected === "string") {
    return typeof value === "string";
  }
  return true;
}

/**
 * Strictly validate one built-in tool argument object against the canonical
 * schema returned by `toolDefinitions`. A null result means validation passed;
 * failures use the same model-facing ToolRunResult as `executeTool`.
 */
export function validateToolArguments(tool: string, args: unknown): ToolRunResult | null {
  const schema = schemaForTool(tool);
  if (!schema) {
    return null;
  }
  const rec = asRecord(args) ?? (args == null ? {} : null);
  if (!rec) {
    return {
      ok: false,
      payload: makeToolError("E_SCHEMA_INVALID", "arguments must be an object"),
      summary: `${tool}: E_SCHEMA_INVALID arguments must be an object`,
    };
  }
  for (const name of schema.required ?? []) {
    if (!(name in rec)) {
      return {
        ok: false,
        payload: makeToolError("E_SCHEMA_INVALID", `missing required field: ${name}`, {
          field: name,
        }),
        summary: `${tool}: E_SCHEMA_INVALID missing required field: ${name}`,
      };
    }
  }
  for (const [name, prop] of Object.entries(schema.properties ?? {})) {
    if (!(name in rec) || rec[name] === undefined || prop.type === undefined) {
      continue;
    }
    if (!matchesJsonType(rec[name], prop.type)) {
      return {
        ok: false,
        payload: makeToolError("E_SCHEMA_INVALID", `field ${name} must be ${prop.type}`, {
          field: name,
          expected: prop.type,
        }),
        summary: `${tool}: E_SCHEMA_INVALID field ${name} must be ${prop.type}`,
      };
    }
  }
  return null;
}

export function toolErrorResult(
  tool: string,
  code: ToolErrorCode,
  message: string,
  detail?: Parameters<typeof makeToolError>[2],
): ToolRunResult {
  return {
    ok: false,
    payload: makeToolError(code, message, detail),
    summary: `${tool}: ${code} ${message}`,
  };
}

export function diagnosticSummarySuffix(diagnostics: {
  readonly status: string;
  readonly issueCount: number;
}): string {
  return diagnostics.status === "issues"
    ? `; syntax diagnostics: ${diagnostics.issueCount} error(s)`
    : diagnostics.status === "clean"
      ? "; syntax diagnostics: clean"
      : "; syntax diagnostics: unavailable";
}

export function parseAcceptanceUpdate(
  rec: Record<string, unknown>,
): AcceptanceUpdateInput | string {
  const rawAdd = Array.isArray(rec.add) ? rec.add : [];
  const rawUpdates = Array.isArray(rec.updates) ? rec.updates : [];
  const add: Array<AcceptanceUpdateInput["add"][number]> = [];
  const updates: Array<AcceptanceUpdateInput["updates"][number]> = [];
  for (const [index, raw] of rawAdd.entries()) {
    const item = asRecord(raw);
    if (!item || typeof item.text !== "string" || !item.text.trim()) {
      return `add[${index}].text must be a non-empty string`;
    }
    if (item.source !== "user" && item.source !== "repository" && item.source !== "verification") {
      return `add[${index}].source must be user, repository, or verification`;
    }
    if (item.ref !== undefined && typeof item.ref !== "string") {
      return `add[${index}].ref must be a string`;
    }
    add.push({
      text: item.text.trim(),
      source: item.source,
      ...(typeof item.ref === "string" && item.ref.trim() ? { ref: item.ref.trim() } : {}),
    });
  }
  for (const [index, raw] of rawUpdates.entries()) {
    const item = asRecord(raw);
    if (!item || typeof item.id !== "string" || !item.id.trim()) {
      return `updates[${index}].id must be a non-empty string`;
    }
    if (
      item.status !== "pending" &&
      item.status !== "satisfied" &&
      item.status !== "blocked" &&
      item.status !== "superseded"
    ) {
      return `updates[${index}].status is invalid`;
    }
    if (item.evidence !== undefined && typeof item.evidence !== "string") {
      return `updates[${index}].evidence must be a string`;
    }
    const evidence = typeof item.evidence === "string" ? item.evidence.trim() : "";
    if (item.status === "satisfied" && !evidence) {
      return `updates[${index}] satisfied requires non-empty evidence`;
    }
    updates.push({
      id: item.id.trim(),
      status: item.status,
      ...(evidence ? { evidence } : {}),
    });
  }
  if (add.length === 0 && updates.length === 0) {
    return "at least one add or update is required";
  }
  return {
    add,
    updates,
    reason: typeof rec.reason === "string" ? rec.reason.trim() : "",
  };
}

export function errorCodeForToolPayload(payload: unknown): ToolErrorCode {
  const rec = asRecord(payload);
  const error = typeof rec?.error === "string" ? rec.error.toLowerCase() : "";
  const risk = typeof rec?.risk === "string" ? rec.risk : "";
  if (risk === "escaped" || risk === "sensitive") {
    return "E_POLICY_DENIED";
  }
  if (
    error.includes("escapes workspace") ||
    error.includes("sensitive") ||
    error.includes("disallowed") ||
    error.includes("blocked pattern") ||
    error.includes("blocked literal") ||
    error.includes("blocked command") ||
    error.includes("blocked:") ||
    error.includes("requires approval") ||
    error.includes("default action")
  ) {
    return "E_POLICY_DENIED";
  }
  if (
    error.includes("enoent") ||
    error.includes("not found") ||
    error.includes("missing") ||
    error.includes("already exists")
  ) {
    return "E_USER";
  }
  return "E_FATAL";
}

type AcceptanceUpdateInput = Omit<import("@paw/core").AgentAcceptanceUpdateAction, "type">;

interface JsonObjectSchema {
  readonly properties?: Record<string, JsonPropertySchema>;
  readonly required?: string[];
}

interface JsonPropertySchema {
  readonly type?: string;
}
