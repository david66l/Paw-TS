import path from "node:path";

import type { ToolDefinition } from "@paw/core";
import {
  PROGRESS_READ,
  TODO_WRITE,
  type ToolRunResult,
  toolDefinitions,
} from "@paw/harness";
import {
  type RuntimeToolPluginEntryV1,
  type RuntimeToolPluginV1,
  canonicalRuntimeResourcePathV1,
} from "@paw/runtime";

import {
  DEFAULT_TASK_PROGRESS_POLICY_V1,
  type TaskProgressPolicyV1,
  freezeTaskProgressPolicyV1,
  normalizeTaskProgressItemsV1,
  taskProgressPolicyIdentityV1,
} from "./policy.js";

export const TASK_PROGRESS_TOOL_PLUGIN_ID_V1 = "paw.task-progress" as const;
export const TASK_PROGRESS_TOOL_PLUGIN_VERSION_V1 =
  "paw.task-progress.v1:i100:d100:c500" as const;

export function createTaskProgressToolPluginV1(input?: {
  readonly policy?: TaskProgressPolicyV1;
}): RuntimeToolPluginV1 {
  const policy = freezeTaskProgressPolicyV1(
    input?.policy ?? DEFAULT_TASK_PROGRESS_POLICY_V1,
  );
  return Object.freeze({
    schemaVersion: "paw.runtime-tool-plugin.v1",
    pluginId: TASK_PROGRESS_TOOL_PLUGIN_ID_V1,
    pluginVersion: taskProgressPolicyIdentityV1(policy),
    entries: Object.freeze([
      createTodoWriteEntry(policy),
      createProgressReadEntry(),
    ]),
  });
}

function createTodoWriteEntry(
  policy: TaskProgressPolicyV1,
): RuntimeToolPluginEntryV1 {
  const definition = canonicalDefinition(TODO_WRITE, "workspace_todo_write");
  const entry: RuntimeToolPluginEntryV1 = {
    internalName: TODO_WRITE,
    providerName: "workspace_todo_write",
    definition: Object.freeze({
      ...definition,
      function: Object.freeze({
        ...definition.function,
        description:
          "Replace the durable task-progress list once per tool batch. Keep at most one item in_progress and update completed items immediately.",
      }),
    }),
    deferred: false,
    resultPolicy: "bounded_json",
    executionKind: "harness",
    validate(args) {
      try {
        if (!args || typeof args !== "object" || Array.isArray(args)) {
          throw new Error("arguments must be an object");
        }
        const record = args as Record<string, unknown>;
        if (Object.keys(record).sort().join("\0") !== "todos") {
          throw new Error("arguments must contain only todos");
        }
        return {
          ok: true as const,
          args: Object.freeze({
            todos: normalizeTaskProgressItemsV1(record.todos, policy),
          }),
        };
      } catch (error) {
        return invalid(TODO_WRITE, error);
      }
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
            key: path.join(root, ".paw", "task-progress"),
            access: "write",
          },
        ],
      };
    },
  };
  return Object.freeze(entry);
}

function createProgressReadEntry(): RuntimeToolPluginEntryV1 {
  const definition = canonicalDefinition(
    PROGRESS_READ,
    "workspace_progress_read",
  );
  const entry: RuntimeToolPluginEntryV1 = {
    internalName: PROGRESS_READ,
    providerName: "workspace_progress_read",
    definition,
    deferred: false,
    resultPolicy: "bounded_json",
    executionKind: "harness",
    validate(args) {
      if (
        !args ||
        typeof args !== "object" ||
        Array.isArray(args) ||
        Object.keys(args).length !== 0
      ) {
        return invalid(PROGRESS_READ, new Error("arguments must be empty"));
      }
      return { ok: true as const, args: Object.freeze({}) };
    },
    classify(_args, workspaceRoot) {
      const root = canonicalRuntimeResourcePathV1(workspaceRoot);
      return {
        lockDomain: root,
        effectClass: "read",
        permissionCategory: "read",
        concurrencyMode: "parallel",
        resources: [
          {
            key: path.join(root, ".paw", "task-progress"),
            access: "read",
          },
        ],
      };
    },
  };
  return Object.freeze(entry);
}

function canonicalDefinition(
  internalName: string,
  providerName: string,
): ToolDefinition {
  const matches = toolDefinitions().filter(
    (item) => item.function.name === providerName,
  );
  if (matches.length !== 1) {
    throw new Error(`Harness schema is missing for ${internalName}`);
  }
  return matches[0] as ToolDefinition;
}

function invalid(
  tool: string,
  error: unknown,
): { readonly ok: false; readonly result: ToolRunResult } {
  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    result: {
      ok: false,
      summary: `${tool}: ${message}`,
      payload: { code: "E_SCHEMA_INVALID", message, executed: false },
    },
  };
}
