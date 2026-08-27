import path from "node:path";

import { LSP, SYMBOL_SEARCH } from "@paw/harness";

import type { RuntimeToolPluginV1, ToolClassificationV1 } from "./registry.js";
import {
  canonicalRuntimeResourcePathV1,
  createHarnessPluginEntriesV1,
  resolveWorkspaceRuntimePathV1,
} from "./runtime-tool-plugin-support.js";

export const CODE_INTELLIGENCE_TOOL_PLUGIN_ID_V1 =
  "paw.code-intelligence" as const;
export const CODE_INTELLIGENCE_TOOL_PLUGIN_VERSION_V1 =
  "paw.code-intelligence.v1" as const;

/** AST symbol lookup and optional language-server navigation. */
export function createCodeIntelligenceToolPluginV1(): RuntimeToolPluginV1 {
  return Object.freeze({
    schemaVersion: "paw.runtime-tool-plugin.v1",
    pluginId: CODE_INTELLIGENCE_TOOL_PLUGIN_ID_V1,
    pluginVersion: CODE_INTELLIGENCE_TOOL_PLUGIN_VERSION_V1,
    entries: createHarnessPluginEntriesV1(
      [SYMBOL_SEARCH, LSP],
      classifyCodeIntelligenceTool,
    ),
  });
}

function classifyCodeIntelligenceTool(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  workspaceRoot: string,
): ToolClassificationV1 {
  const root = canonicalRuntimeResourcePathV1(workspaceRoot);
  if (tool === SYMBOL_SEARCH) {
    const maxResults = args.max_results;
    if (
      maxResults !== undefined &&
      (typeof maxResults !== "number" || maxResults < 1 || maxResults > 100)
    ) {
      throw new Error("symbol_search max_results must be between 1 and 100");
    }
    return readClassification(root, `${root}${path.sep}*`, "parallel");
  }
  if (tool === LSP) {
    const file = typeof args.file === "string" ? args.file : "";
    resolveWorkspaceRuntimePathV1(workspaceRoot, file);
    const method = args.method ?? "hover";
    if (
      method !== "hover" &&
      method !== "definition" &&
      method !== "references" &&
      method !== "completion"
    ) {
      throw new Error(`unsupported lsp method: ${String(method)}`);
    }
    for (const field of ["line", "character"] as const) {
      const value = args[field] ?? 0;
      if (
        typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < 0
      ) {
        throw new Error(`lsp ${field} must be a non-negative safe integer`);
      }
    }
    // A language server may scan the project. Serialize it against mutations.
    return readClassification(root, `${root}${path.sep}*`, "exclusive");
  }
  throw new Error(`Code intelligence plugin cannot classify ${tool}`);
}

function readClassification(
  lockDomain: string,
  resource: string,
  concurrencyMode: "parallel" | "exclusive",
): ToolClassificationV1 {
  return {
    lockDomain,
    effectClass: "read",
    permissionCategory: "read",
    concurrencyMode,
    resources: [{ key: resource, access: "read" }],
  };
}
