import type { ToolDefinition } from "@paw/core";
import type { InputFactV1 } from "@paw/protocol";

import { CONTEXT_COMPACT, type ToolRunResult, toolDefinitions } from "@paw/harness";
import {
  type RuntimeToolPluginEntryV1,
  type RuntimeToolPluginV1,
  canonicalRuntimeResourcePathV1,
} from "@paw/runtime";

/** Provider-visible name of the model-invoked compaction request tool. */
export const CONTEXT_COMPACT_PROVIDER_TOOL_V1 = "context_compact" as const;

export const CONTEXT_COMPACT_TOOL_PLUGIN_ID_V1 = "paw.context-compact" as const;
export const CONTEXT_COMPACT_TOOL_PLUGIN_VERSION_V1 = "paw.context-compact.v1" as const;

/**
 * True when a successfully executed context_compact call sits after the
 * newest recorded checkpoint, i.e. the model's request has not been honored
 * yet. Failed or cancelled requests never count; any later checkpoint
 * (whatever produced it) consumes the request.
 */
export function projectPendingContextCompactRequestV1(facts: readonly InputFactV1[]): boolean {
  const settledOk = new Set<string>();
  for (const fact of facts) {
    if (fact.type === "tool.settled" && fact.status === "completed") {
      settledOk.add(fact.callId);
    }
  }
  for (let index = facts.length - 1; index >= 0; index -= 1) {
    const fact = facts[index];
    if (fact?.type === "context.checkpoint_recorded") return false;
    if (
      fact?.type === "tool.call_observed" &&
      fact.tool === CONTEXT_COMPACT_PROVIDER_TOOL_V1 &&
      settledOk.has(fact.callId)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Model-invoked entry point for context compaction (Context-as-a-Tool). The
 * tool itself only journals a marker; the boundary middleware promotes it to
 * a user_requested distillation decision at the next safe boundary.
 */
export function createContextCompactToolPluginV1(): RuntimeToolPluginV1 {
  const canonical = toolDefinitions().find(
    (item) => item.function.name === CONTEXT_COMPACT_PROVIDER_TOOL_V1,
  );
  if (!canonical) {
    throw new Error("Harness context.compact schema is missing");
  }
  const definition: ToolDefinition = canonical;
  const entry: RuntimeToolPluginEntryV1 = {
    internalName: CONTEXT_COMPACT,
    providerName: CONTEXT_COMPACT_PROVIDER_TOOL_V1,
    definition,
    deferred: false,
    resultPolicy: "bounded_json",
    executionKind: "harness",
    validate(args: unknown) {
      if (
        !args ||
        typeof args !== "object" ||
        Array.isArray(args) ||
        Object.keys(args as Record<string, unknown>).length !== 0
      ) {
        return invalid("arguments must be empty");
      }
      return { ok: true as const, args: Object.freeze({}) };
    },
    classify(_args: unknown, workspaceRoot: string) {
      const root = canonicalRuntimeResourcePathV1(workspaceRoot);
      return {
        lockDomain: root,
        effectClass: "read",
        permissionCategory: "read",
        concurrencyMode: "parallel",
        resources: [],
      };
    },
  };
  return Object.freeze({
    schemaVersion: "paw.runtime-tool-plugin.v1",
    pluginId: CONTEXT_COMPACT_TOOL_PLUGIN_ID_V1,
    pluginVersion: CONTEXT_COMPACT_TOOL_PLUGIN_VERSION_V1,
    entries: Object.freeze([Object.freeze(entry)]),
  });
}

function invalid(message: string): {
  readonly ok: false;
  readonly result: ToolRunResult;
} {
  return {
    ok: false,
    result: {
      ok: false,
      summary: `context_compact: ${message}`,
      payload: { code: "E_SCHEMA_INVALID", message, executed: false },
    },
  };
}
