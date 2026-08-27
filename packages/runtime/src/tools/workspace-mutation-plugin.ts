import { extractCheckpointTargets } from "@paw/core";
import { APPLY_PATCH } from "@paw/harness";

import type { RuntimeToolPluginV1, ToolClassificationV1 } from "./registry.js";
import {
  canonicalRuntimeResourcePathV1,
  createHarnessPluginEntriesV1,
  resolveWorkspaceRuntimePathV1,
} from "./runtime-tool-plugin-support.js";

export const WORKSPACE_MUTATION_TOOL_PLUGIN_ID_V1 =
  "paw.workspace-mutation" as const;
export const WORKSPACE_MUTATION_TOOL_PLUGIN_VERSION_V1 =
  "paw.workspace-mutation.v1" as const;

const MAX_PATCH_BYTES_V1 = 512 * 1024;
const MAX_PATCH_TARGETS_V1 = 100;

/** Bounded multi-file mutation installed explicitly by Paw Next. */
export function createWorkspaceMutationToolPluginV1(): RuntimeToolPluginV1 {
  return Object.freeze({
    schemaVersion: "paw.runtime-tool-plugin.v1",
    pluginId: WORKSPACE_MUTATION_TOOL_PLUGIN_ID_V1,
    pluginVersion: WORKSPACE_MUTATION_TOOL_PLUGIN_VERSION_V1,
    entries: createHarnessPluginEntriesV1([APPLY_PATCH], classifyPatchTool),
  });
}

function classifyPatchTool(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  workspaceRoot: string,
): ToolClassificationV1 {
  if (tool !== APPLY_PATCH) {
    throw new Error(`Workspace mutation plugin cannot classify ${tool}`);
  }
  const patchText = typeof args.patch === "string" ? args.patch : "";
  if (Buffer.byteLength(patchText, "utf8") > MAX_PATCH_BYTES_V1) {
    throw new Error(`apply_patch exceeds ${MAX_PATCH_BYTES_V1} bytes`);
  }
  const targets = [...new Set(extractCheckpointTargets(tool, args))];
  if (targets.length === 0) {
    throw new Error("apply_patch has no writable file targets");
  }
  if (targets.length > MAX_PATCH_TARGETS_V1) {
    throw new Error(`apply_patch exceeds ${MAX_PATCH_TARGETS_V1} file targets`);
  }
  const root = canonicalRuntimeResourcePathV1(workspaceRoot);
  const resources = targets
    .map((target) => resolveWorkspaceRuntimePathV1(workspaceRoot, target))
    .sort()
    .map((key) => ({ key, access: "write" as const }));
  return {
    lockDomain: root,
    effectClass: "write",
    permissionCategory: "write",
    concurrencyMode: "exclusive",
    resources,
  };
}
