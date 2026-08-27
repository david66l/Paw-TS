import path from "node:path";

import { MCP_PROXY } from "@paw/harness";

import type { RuntimeToolPluginV1, ToolClassificationV1 } from "./registry.js";
import {
  canonicalRuntimeResourcePathV1,
  createHarnessPluginEntriesV1,
} from "./runtime-tool-plugin-support.js";

export const MCP_PROXY_TOOL_PLUGIN_ID_V1 = "paw.mcp-proxy" as const;
export const MCP_PROXY_TOOL_PLUGIN_VERSION_V1 = "paw.mcp-proxy.v1" as const;

/**
 * Install one provider-stable MCP gateway while binding the frozen registry
 * identity to the local profile's MCP scope hash.
 */
export function createMcpProxyToolPluginV1(
  scopeHash: string,
): RuntimeToolPluginV1 {
  if (!/^[a-f0-9]{64}$/.test(scopeHash)) {
    throw new Error("MCP proxy scopeHash must be a lowercase SHA-256 digest");
  }
  return Object.freeze({
    schemaVersion: "paw.runtime-tool-plugin.v1",
    pluginId: MCP_PROXY_TOOL_PLUGIN_ID_V1,
    pluginVersion: `${MCP_PROXY_TOOL_PLUGIN_VERSION_V1}.${scopeHash}`,
    entries: createHarnessPluginEntriesV1([MCP_PROXY], classifyMcpProxyToolV1),
  });
}

function classifyMcpProxyToolV1(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  workspaceRoot: string,
): ToolClassificationV1 {
  if (tool !== MCP_PROXY) {
    throw new Error(`MCP proxy plugin cannot classify ${tool}`);
  }
  const root = canonicalRuntimeResourcePathV1(workspaceRoot);
  if (args.action === "search") {
    return {
      lockDomain: root,
      effectClass: "read",
      permissionCategory: "read",
      concurrencyMode: "parallel",
      resources: [
        { key: `${root}${path.sep}.paw-mcp-catalog`, access: "read" },
      ],
    };
  }
  if (args.action === "call") {
    return {
      lockDomain: root,
      effectClass: "unknown",
      permissionCategory: "shell",
      concurrencyMode: "exclusive",
      resources: [
        { key: `${root}${path.sep}.paw-mcp-external`, access: "write" },
      ],
    };
  }
  throw new Error("MCP proxy action must be search or call");
}
