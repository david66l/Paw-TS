import path from "node:path";

import {
  GIT_DIFF,
  GIT_LOG,
  GIT_STATUS,
  GLOB,
  LIST,
  SEARCH,
} from "@paw/harness";

import type { RuntimeToolPluginV1, ToolClassificationV1 } from "./registry.js";
import {
  canonicalRuntimeResourcePathV1,
  createHarnessPluginEntriesV1,
  resolveWorkspaceRuntimePathV1,
} from "./runtime-tool-plugin-support.js";

export const WORKSPACE_INSPECTION_TOOL_PLUGIN_ID_V1 =
  "paw.workspace-inspection" as const;
export const WORKSPACE_INSPECTION_TOOL_PLUGIN_VERSION_V1 =
  "paw.workspace-inspection.v1" as const;
export const WORKSPACE_INSPECTION_TOOL_PLUGIN_VERSION_V2 =
  "paw.workspace-inspection.v2" as const;

const WORKSPACE_INSPECTION_TOOLS_V1 = [
  LIST,
  SEARCH,
  GLOB,
  GIT_STATUS,
  GIT_DIFF,
] as const;
const WORKSPACE_INSPECTION_TOOLS_V2 = [
  ...WORKSPACE_INSPECTION_TOOLS_V1,
  GIT_LOG,
] as const;

/** Read-only coding tools installed explicitly by the Paw Next composition. */
export function createWorkspaceInspectionToolPluginV1(): RuntimeToolPluginV1 {
  return Object.freeze({
    schemaVersion: "paw.runtime-tool-plugin.v1",
    pluginId: WORKSPACE_INSPECTION_TOOL_PLUGIN_ID_V1,
    pluginVersion: WORKSPACE_INSPECTION_TOOL_PLUGIN_VERSION_V1,
    entries: createHarnessPluginEntriesV1(
      WORKSPACE_INSPECTION_TOOLS_V1,
      classifyInspectionTool,
    ),
  });
}

/** V2 adds bounded git history without changing the V1 identity. */
export function createWorkspaceInspectionToolPluginV2(): RuntimeToolPluginV1 {
  return Object.freeze({
    schemaVersion: "paw.runtime-tool-plugin.v1",
    pluginId: WORKSPACE_INSPECTION_TOOL_PLUGIN_ID_V1,
    pluginVersion: WORKSPACE_INSPECTION_TOOL_PLUGIN_VERSION_V2,
    entries: createHarnessPluginEntriesV1(
      WORKSPACE_INSPECTION_TOOLS_V2,
      classifyInspectionTool,
    ),
  });
}

function classifyInspectionTool(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  workspaceRoot: string,
): ToolClassificationV1 {
  const root = canonicalRuntimeResourcePathV1(workspaceRoot);
  if (tool === GIT_STATUS || tool === GIT_DIFF || tool === GIT_LOG) {
    if (tool === GIT_LOG) {
      const maxCount = args.max_count;
      if (
        maxCount !== undefined &&
        (typeof maxCount !== "number" || maxCount < 1 || maxCount > 100)
      ) {
        throw new Error("git_log max_count must be between 1 and 100");
      }
    }
    return readClassification(root, `${root}${path.sep}*`);
  }
  if (tool === LIST || tool === SEARCH || tool === GLOB) {
    const candidate = typeof args.path === "string" ? args.path : "";
    const target = resolveWorkspaceRuntimePathV1(workspaceRoot, candidate);
    return readClassification(root, `${target}${path.sep}*`);
  }
  throw new Error(`Workspace inspection plugin cannot classify ${tool}`);
}

function readClassification(
  lockDomain: string,
  resource: string,
): ToolClassificationV1 {
  return {
    lockDomain,
    effectClass: "read",
    permissionCategory: "read",
    concurrencyMode: "parallel",
    resources: [{ key: resource, access: "read" }],
  };
}
