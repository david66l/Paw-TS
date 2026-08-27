import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { LoopToolCall } from "@paw/agent-loop";
import type { ToolDefinition } from "@paw/core";
import {
  EDIT,
  JOB_KILL,
  JOB_LIST,
  JOB_READ,
  JOB_START,
  JOB_WAIT,
  READ,
  SHELL,
  type ShellSandboxConfig,
  type ToolRunResult,
  WRITE,
  classifyShellCommand,
  toolDefinitions,
  validateToolArguments,
} from "@paw/harness";
import { type WorkspacePathPolicyV1, checkWorkspacePath } from "@paw/workspace";

export const PAW_NEXT_INITIAL_TOOLS_V1 = [
  READ,
  EDIT,
  WRITE,
  SHELL,
  JOB_START,
  JOB_LIST,
  JOB_READ,
  JOB_WAIT,
  JOB_KILL,
] as const;

export interface RuntimeToolCallV1 extends LoopToolCall {
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly rawArguments?: string;
  readonly sourceIndex?: number;
}

export type ToolPermissionCategoryV1 = "read" | "write" | "shell";
export type ToolConcurrencyModeV1 = "parallel" | "exclusive";
export type RuntimeShellBoundaryV1 =
  | "deny"
  | "read_only"
  | "verification"
  | "allow";

export interface ToolResourceV1 {
  readonly key: string;
  readonly access: "read" | "write";
}

export interface ToolClassificationV1 {
  /** Canonical workspace identity shared by every executor instance. */
  readonly lockDomain: string;
  readonly effectClass: "read" | "write" | "unknown";
  readonly permissionCategory: ToolPermissionCategoryV1;
  readonly concurrencyMode: ToolConcurrencyModeV1;
  readonly resources: readonly ToolResourceV1[];
}

type HarnessToolDefinition = ReturnType<typeof toolDefinitions>[number];

export interface ToolRegistryEntryV1 {
  readonly internalName: string;
  readonly providerName: string;
  readonly definition: HarnessToolDefinition;
  readonly deferred: boolean;
  readonly resultPolicy: "bounded_json";
  readonly pluginId?: string;
  readonly pluginVersion?: string;
  validate(args: unknown):
    | { readonly ok: true; readonly args: Readonly<Record<string, unknown>> }
    | {
        readonly ok: false;
        readonly result: ToolRunResult;
      };
  classify(
    validatedArgs: Readonly<Record<string, unknown>>,
    workspaceRoot: string,
  ): ToolClassificationV1;
}

export interface RuntimeToolPluginEntryV1 {
  readonly internalName: string;
  readonly providerName: string;
  readonly definition: ToolDefinition;
  /** V1 plugins are model-visible at run start; deferred loading is not supported. */
  readonly deferred: false;
  readonly resultPolicy: "bounded_json";
  /** The current executor routes this entry through Harness transactions. */
  readonly executionKind: "harness";
  validate(
    args: unknown,
  ):
    | { readonly ok: true; readonly args: Readonly<Record<string, unknown>> }
    | { readonly ok: false; readonly result: ToolRunResult };
  classify(
    validatedArgs: Readonly<Record<string, unknown>>,
    workspaceRoot: string,
  ): ToolClassificationV1;
}

export interface RuntimeToolPluginV1 {
  readonly schemaVersion: "paw.runtime-tool-plugin.v1";
  readonly pluginId: string;
  readonly pluginVersion: string;
  readonly entries: readonly RuntimeToolPluginEntryV1[];
}

export interface FrozenRuntimeToolPluginIdentityV1 {
  readonly pluginId: string;
  readonly pluginVersion: string;
}

export interface ValidatedRuntimeToolCallV1 {
  readonly call: RuntimeToolCallV1;
  readonly entry: ToolRegistryEntryV1;
  readonly internalName: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly classification: ToolClassificationV1;
}

export interface FrozenToolRegistryV1 {
  readonly schemaVersion: "paw.runtime-tool-registry.v1";
  readonly registryHash: string;
  readonly entries: readonly ToolRegistryEntryV1[];
  readonly definitions: readonly HarnessToolDefinition[];
  readonly plugins: readonly FrozenRuntimeToolPluginIdentityV1[];
  readonly shellSandbox?: ShellSandboxConfig;
  readonly shellSandboxHash: string;
  assertCompatibleShellSandbox(value: ShellSandboxConfig | undefined): void;
  resolveProviderName(name: string): ToolRegistryEntryV1 | undefined;
  validateAndClassify(
    call: RuntimeToolCallV1,
    workspaceRoot: string,
  ):
    | { readonly ok: true; readonly value: ValidatedRuntimeToolCallV1 }
    | { readonly ok: false; readonly result: ToolRunResult };
}

/**
 * 冻结本次 run 可见的第一批工具。名称、schema、校验和参数级分类来自同一
 * entry；不能由模型适配器、权限层和执行层各维护一份。
 */
export function createFrozenToolRegistryV1(input?: {
  readonly tools?: readonly (typeof PAW_NEXT_INITIAL_TOOLS_V1)[number][];
  readonly plugins?: readonly RuntimeToolPluginV1[];
  readonly shellSandbox?: ShellSandboxConfig;
  readonly pathPolicy?: WorkspacePathPolicyV1;
  readonly shellBoundary?: RuntimeShellBoundaryV1;
}): FrozenToolRegistryV1 {
  const shellSandbox = input?.shellSandbox
    ? cloneAndDeepFreeze(input.shellSandbox)
    : undefined;
  const shellSandboxHash = hashCanonical(shellSandbox ?? null);
  const pathPolicy = input?.pathPolicy
    ? cloneAndDeepFreeze(input.pathPolicy)
    : undefined;
  const shellBoundary = input?.shellBoundary ?? "allow";
  const requested = [...(input?.tools ?? PAW_NEXT_INITIAL_TOOLS_V1)].sort();
  if (new Set(requested).size !== requested.length) {
    throw new Error("Runtime tool registry contains duplicate tool names");
  }
  const allDefinitions = toolDefinitions(undefined, {
    ...(shellSandbox ? { shellSandbox } : {}),
  });
  const definitionsByProvider = new Map<string, HarnessToolDefinition[]>();
  for (const definition of allDefinitions) {
    const providerName = definition.function.name;
    const matches = definitionsByProvider.get(providerName) ?? [];
    matches.push(definition);
    definitionsByProvider.set(providerName, matches);
  }

  const providerNames = new Set<string>();
  const internalNames = new Set<string>();
  const entries: ToolRegistryEntryV1[] = requested.map((internalName) => {
    const providerName = internalName.replace(/\./g, "_");
    if (providerNames.has(providerName)) {
      throw new Error(`Runtime provider tool-name collision: ${providerName}`);
    }
    providerNames.add(providerName);
    internalNames.add(internalName);
    const definitions = definitionsByProvider.get(providerName) ?? [];
    if (definitions.length !== 1) {
      throw new Error(
        `Runtime tool ${internalName} must have exactly one harness schema`,
      );
    }
    const [definition] = definitions;
    if (!definition) {
      throw new Error(`Runtime tool ${internalName} has no harness schema`);
    }
    return createRegistryEntry(
      internalName,
      providerName,
      cloneAndDeepFreeze(definition),
    );
  });
  const pluginIdentities: FrozenRuntimeToolPluginIdentityV1[] = [];
  const pluginIds = new Set<string>();
  for (const plugin of input?.plugins ?? []) {
    assertToolPlugin(plugin, pluginIds);
    pluginIds.add(plugin.pluginId);
    pluginIdentities.push(
      Object.freeze({
        pluginId: plugin.pluginId,
        pluginVersion: plugin.pluginVersion,
      }),
    );
    for (const pluginEntry of plugin.entries) {
      if (internalNames.has(pluginEntry.internalName)) {
        throw new Error(
          `Runtime tool internal-name collision: ${pluginEntry.internalName}`,
        );
      }
      if (providerNames.has(pluginEntry.providerName)) {
        throw new Error(
          `Runtime provider tool-name collision: ${pluginEntry.providerName}`,
        );
      }
      assertPluginEntry(plugin, pluginEntry);
      internalNames.add(pluginEntry.internalName);
      providerNames.add(pluginEntry.providerName);
      entries.push(createPluginRegistryEntry(plugin, pluginEntry));
    }
  }
  entries.sort((left, right) =>
    left.internalName.localeCompare(right.internalName),
  );
  pluginIdentities.sort((left, right) =>
    left.pluginId.localeCompare(right.pluginId),
  );
  const byProviderName = new Map(
    entries.map((entry) => [entry.providerName, entry]),
  );
  const registryHash = hashCanonical({
    schemaVersion: "paw.runtime-tool-registry.v1",
    shellSandboxHash,
    pathPolicy: pathPolicy ?? null,
    shellBoundary,
    entries: entries.map((entry) => ({
      internalName: entry.internalName,
      providerName: entry.providerName,
      definition: entry.definition,
      deferred: entry.deferred,
      resultPolicy: entry.resultPolicy,
      ...(entry.pluginId === undefined
        ? {}
        : {
            pluginId: entry.pluginId,
            pluginVersion: entry.pluginVersion,
          }),
    })),
    plugins: pluginIdentities,
  });

  return Object.freeze({
    schemaVersion: "paw.runtime-tool-registry.v1" as const,
    registryHash,
    entries: Object.freeze(entries),
    definitions: Object.freeze(entries.map((entry) => entry.definition)),
    plugins: Object.freeze(pluginIdentities),
    ...(shellSandbox ? { shellSandbox } : {}),
    shellSandboxHash,
    assertCompatibleShellSandbox(value: ShellSandboxConfig | undefined) {
      if (hashCanonical(value ?? null) !== shellSandboxHash) {
        throw new Error(
          "Runtime registry shell sandbox does not match execution context",
        );
      }
    },
    resolveProviderName: (name: string) => byProviderName.get(name),
    validateAndClassify(call: RuntimeToolCallV1, workspaceRoot: string) {
      const entry = byProviderName.get(call.name);
      if (!entry) {
        return {
          ok: false as const,
          result: toolFailure(
            "E_TOOL_UNKNOWN",
            `Unknown runtime tool: ${call.name}`,
          ),
        };
      }
      const validation = entry.validate(call.arguments);
      if (!validation.ok) return validation;
      try {
        return {
          ok: true as const,
          value: {
            call,
            entry,
            internalName: entry.internalName,
            args: validation.args,
            classification: classifyWithinPathPolicyV1(
              entry.classify(validation.args, workspaceRoot),
              workspaceRoot,
              pathPolicy,
              shellBoundary,
              validation.args,
            ),
          },
        };
      } catch (error) {
        return {
          ok: false as const,
          result: toolFailure(
            "E_TOOL_CLASSIFICATION",
            error instanceof Error ? error.message : String(error),
          ),
        };
      }
    },
  });
}

function classifyWithinPathPolicyV1(
  classification: ToolClassificationV1,
  workspaceRoot: string,
  policy: WorkspacePathPolicyV1 | undefined,
  shellBoundary: RuntimeShellBoundaryV1,
  args: Readonly<Record<string, unknown>>,
): ToolClassificationV1 {
  if (classification.permissionCategory === "shell") {
    if (shellBoundary === "deny") {
      throw new Error("Shell is denied by the active child boundary");
    }
    if (
      shellBoundary === "read_only" &&
      classification.effectClass !== "read"
    ) {
      throw new Error(
        "Command is not proven read-only by the active child boundary",
      );
    }
    if (
      shellBoundary === "verification" &&
      classification.effectClass !== "read" &&
      !isVerificationShellCommandV1(args.command)
    ) {
      throw new Error(
        "Command is neither read-only nor an approved verification command",
      );
    }
    return classification;
  }
  if (!policy) {
    return classification;
  }
  for (const resource of classification.resources) {
    const suffix = `${path.sep}*`;
    const candidate = resource.key.endsWith(suffix)
      ? resource.key.slice(0, -suffix.length)
      : resource.key;
    const decision = checkWorkspacePath(workspaceRoot, candidate, {
      operation: resource.access,
      policy,
    });
    if (!decision.allowed) throw new Error(decision.reason);
  }
  return classification;
}

function isVerificationShellCommandV1(command: unknown): boolean {
  if (typeof command !== "string") return false;
  const normalized = command.trim();
  if (!normalized || /[<>;&|`$\r\n]/.test(normalized)) return false;
  return /^(?:(?:[A-Za-z_][A-Za-z0-9_]*=\S+)\s+)*(?:(?:bun|bun\.exe|npm|npm\.cmd|pnpm|pnpm\.cmd|yarn|yarn\.cmd)\s+(?:test|check|build|lint|typecheck|run\s+(?:test|check|build|lint|typecheck))(?:\s|$)|node(?:\.exe)?\s+--test(?:\s|$)|(?:python|python3|py)(?:\.exe)?\s+-m\s+pytest(?:\s|$)|pytest(?:\.exe)?(?:\s|$)|cargo(?:\.exe)?\s+(?:test|check|clippy)(?:\s|$)|go(?:\.exe)?\s+test(?:\s|$)|dotnet(?:\.exe)?\s+test(?:\s|$)|mvn(?:\.cmd)?\s+(?:test|verify)(?:\s|$)|gradle(?:\.bat)?\s+(?:test|check|build)(?:\s|$)|tsc(?:\.cmd)?\s+--noEmit(?:\s|$)|eslint(?:\.cmd)?(?:\s|$)|biome(?:\.exe)?\s+check(?:\s|$))/i.test(
    normalized,
  );
}

function createPluginRegistryEntry(
  plugin: RuntimeToolPluginV1,
  entry: RuntimeToolPluginEntryV1,
): ToolRegistryEntryV1 {
  return Object.freeze({
    internalName: entry.internalName,
    providerName: entry.providerName,
    definition: cloneAndDeepFreeze(entry.definition),
    deferred: entry.deferred,
    resultPolicy: entry.resultPolicy,
    pluginId: plugin.pluginId,
    pluginVersion: plugin.pluginVersion,
    validate: entry.validate.bind(entry),
    classify: entry.classify.bind(entry),
  });
}

function assertToolPlugin(
  plugin: RuntimeToolPluginV1,
  pluginIds: ReadonlySet<string>,
): void {
  if (
    plugin.schemaVersion !== "paw.runtime-tool-plugin.v1" ||
    !isStableToken(plugin.pluginId) ||
    !isStableToken(plugin.pluginVersion) ||
    !Array.isArray(plugin.entries) ||
    plugin.entries.length === 0
  ) {
    throw new Error("Runtime tool plugin is invalid");
  }
  if (pluginIds.has(plugin.pluginId)) {
    throw new Error(`Duplicate runtime tool plugin: ${plugin.pluginId}`);
  }
}

function assertPluginEntry(
  plugin: RuntimeToolPluginV1,
  entry: RuntimeToolPluginEntryV1,
): void {
  if (
    !isStableToken(entry.internalName) ||
    !isStableToken(entry.providerName) ||
    entry.definition.type !== "function" ||
    entry.definition.function.name !== entry.providerName ||
    typeof entry.definition.function.description !== "string" ||
    !entry.definition.function.description.trim() ||
    !entry.definition.function.parameters ||
    typeof entry.definition.function.parameters !== "object" ||
    entry.deferred !== false ||
    entry.resultPolicy !== "bounded_json" ||
    entry.executionKind !== "harness" ||
    typeof entry.validate !== "function" ||
    typeof entry.classify !== "function"
  ) {
    throw new Error(
      `Runtime tool plugin entry is invalid: ${plugin.pluginId}/${entry.internalName}`,
    );
  }
}

function isStableToken(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(value);
}

function createRegistryEntry(
  internalName: string,
  providerName: string,
  definition: HarnessToolDefinition,
): ToolRegistryEntryV1 {
  return Object.freeze({
    internalName,
    providerName,
    definition,
    deferred: false,
    resultPolicy: "bounded_json" as const,
    validate(args: unknown) {
      const error = validateToolArguments(internalName, args);
      if (error) return { ok: false as const, result: error };
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        return {
          ok: false as const,
          result: toolFailure(
            "E_SCHEMA_INVALID",
            "Tool arguments must be an object",
          ),
        };
      }
      return {
        ok: true as const,
        args: Object.freeze({ ...(args as Record<string, unknown>) }),
      };
    },
    classify(args: Readonly<Record<string, unknown>>, workspaceRoot: string) {
      return classifyInitialToolV1(internalName, args, workspaceRoot);
    },
  });
}

function classifyInitialToolV1(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  workspaceRoot: string,
): ToolClassificationV1 {
  if (tool === READ || tool === EDIT || tool === WRITE) {
    const candidate = typeof args.path === "string" ? args.path : "";
    const decision = checkWorkspacePath(workspaceRoot, candidate);
    if (!decision.allowed) throw new Error(decision.reason);
    const resource = canonicalResourcePath(decision.resolvedPath);
    if (tool === READ) {
      return {
        lockDomain: canonicalResourcePath(workspaceRoot),
        effectClass: "read",
        permissionCategory: "read",
        concurrencyMode: "parallel",
        resources: [{ key: resource, access: "read" }],
      };
    }
    return {
      lockDomain: canonicalResourcePath(workspaceRoot),
      effectClass: "write",
      permissionCategory: "write",
      concurrencyMode: "exclusive",
      resources: [{ key: resource, access: "write" }],
    };
  }
  if (tool === SHELL) {
    const command = typeof args.command === "string" ? args.command : "";
    const shell = classifyShellCommand(command);
    const root = canonicalResourcePath(workspaceRoot);
    return {
      lockDomain: root,
      effectClass: shell.isReadOnly ? "read" : "unknown",
      permissionCategory: "shell",
      concurrencyMode: "exclusive",
      resources: [{ key: `${root}${path.sep}*`, access: "write" }],
    };
  }
  if (tool === JOB_START) {
    const command = typeof args.command === "string" ? args.command : "";
    const shell = classifyShellCommand(command);
    const root = canonicalResourcePath(workspaceRoot);
    return {
      lockDomain: root,
      effectClass: shell.isReadOnly ? "read" : "unknown",
      permissionCategory: "shell",
      concurrencyMode: "exclusive",
      resources: [{ key: `${root}${path.sep}*`, access: "write" }],
    };
  }
  if (tool === JOB_LIST || tool === JOB_READ || tool === JOB_WAIT) {
    const root = canonicalResourcePath(workspaceRoot);
    return {
      lockDomain: root,
      effectClass: "read",
      permissionCategory: "read",
      concurrencyMode: "parallel",
      resources: [
        { key: `${root}${path.sep}.paw-managed-jobs`, access: "read" },
      ],
    };
  }
  if (tool === JOB_KILL) {
    const root = canonicalResourcePath(workspaceRoot);
    return {
      lockDomain: root,
      effectClass: "unknown",
      permissionCategory: "shell",
      concurrencyMode: "exclusive",
      resources: [
        { key: `${root}${path.sep}.paw-managed-jobs`, access: "write" },
      ],
    };
  }
  throw new Error(`Tool has no Paw Next classifier: ${tool}`);
}

function canonicalResourcePath(input: string): string {
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

function toolFailure(code: string, message: string): ToolRunResult {
  return {
    ok: false,
    summary: message,
    payload: { code, message, executed: false },
  };
}

function hashCanonical(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function cloneAndDeepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) {
    throw new TypeError("Runtime tool schema must be an acyclic JSON tree");
  }
  seen.add(value);
  let clone: unknown;
  if (Array.isArray(value)) {
    clone = value.map((item) => cloneAndDeepFreeze(item, seen));
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(
        "Runtime tool schema must contain plain objects only",
      );
    }
    clone = Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        cloneAndDeepFreeze(item, seen),
      ]),
    );
  }
  seen.delete(value);
  return Object.freeze(clone) as T;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
