import fs from "node:fs";
import path from "node:path";

import {
  type ToolRunResult,
  toolDefinitions,
  validateToolArguments,
} from "@paw/harness";
import { checkWorkspacePath } from "@paw/workspace";

import type {
  RuntimeToolPluginEntryV1,
  ToolClassificationV1,
} from "./registry.js";

export function createHarnessPluginEntriesV1(
  internalNames: readonly string[],
  classify: (
    tool: string,
    args: Readonly<Record<string, unknown>>,
    workspaceRoot: string,
  ) => ToolClassificationV1,
): readonly RuntimeToolPluginEntryV1[] {
  const definitions = new Map(
    toolDefinitions().map((definition) => [
      definition.function.name,
      definition,
    ]),
  );
  return Object.freeze(
    internalNames.map((internalName) => {
      const providerName = internalName.replace(/\./g, "_");
      const definition = definitions.get(providerName);
      if (!definition) {
        throw new Error(
          `Harness schema is missing for plugin tool ${internalName}`,
        );
      }
      return Object.freeze({
        internalName,
        providerName,
        definition,
        deferred: false,
        resultPolicy: "bounded_json",
        executionKind: "harness",
        validate: (args: unknown) => validateHarnessArgs(internalName, args),
        classify: (
          args: Readonly<Record<string, unknown>>,
          workspaceRoot: string,
        ) => classify(internalName, args, workspaceRoot),
      } satisfies RuntimeToolPluginEntryV1);
    }),
  );
}

export function canonicalRuntimeResourcePathV1(input: string): string {
  const absolute = path.resolve(input);
  let canonical = absolute;
  try {
    canonical = fs.realpathSync.native?.(absolute) ?? fs.realpathSync(absolute);
  } catch {
    const parent = path.dirname(absolute);
    try {
      const realParent =
        fs.realpathSync.native?.(parent) ?? fs.realpathSync(parent);
      canonical = path.join(realParent, path.basename(absolute));
    } catch {
      canonical = absolute;
    }
  }
  const normalized = path.normalize(canonical);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function resolveWorkspaceRuntimePathV1(
  workspaceRoot: string,
  candidate: string,
): string {
  const decision = checkWorkspacePath(workspaceRoot, candidate);
  if (!decision.allowed) throw new Error(decision.reason);
  return canonicalRuntimeResourcePathV1(decision.resolvedPath);
}

function validateHarnessArgs(
  internalName: string,
  args: unknown,
):
  | { readonly ok: true; readonly args: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly result: ToolRunResult } {
  const error = validateToolArguments(internalName, args);
  if (error) return { ok: false, result: error };
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return {
      ok: false,
      result: {
        ok: false,
        summary: `${internalName}: arguments must be an object`,
        payload: {
          code: "E_SCHEMA_INVALID",
          message: "Tool arguments must be an object",
          executed: false,
        },
      },
    };
  }
  return {
    ok: true,
    args: Object.freeze({ ...(args as Record<string, unknown>) }),
  };
}
