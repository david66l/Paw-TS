import path from "node:path";

import type { McpServerConfig, ShellSandboxConfig } from "@paw/harness";
import {
  type PawNextMemoryPluginProfileV1,
  freezePawNextMemoryPluginProfileV1,
} from "@paw/memory-plugin";
import type {
  LanguageModel,
  PawModelTransport,
  PawProviderProtocol,
} from "@paw/models";
import { WORK_SEGMENT_POLICY_VERSION_V1 } from "@paw/protocol";
import {
  type FileDurableJsonPayloadRuntimePolicyV1,
  type FrozenPermissionConfigV1,
  type SessionLeaseHeartbeatPolicyV1,
  freezeFileDurableJsonPayloadRuntimePolicyV1,
} from "@paw/runtime";

import { preparePawNextProductRuntimeIdentityV3 } from "./composition.js";
import {
  type PawNextProductManifestV3,
  createPawNextProductManifestV3,
  hashPawNextProductManifestV3,
} from "./product-manifest-v3.js";
import type { PawNextProductProfileIdentityV1 } from "./product-manifest.js";
import {
  buildPawNextTaskOptionsFromProfileInternal,
  canonicalPawNextWorkspaceInternal,
  exactRecordInternal,
  parsePawNextProductProfileInternal,
  readStrictPawNextWorkspaceJsonInternal,
} from "./product-profile-common.js";
import type { PawNextProductProfileV1 } from "./product-profile.js";
import type { PawNextStartupRunIdentityV1 } from "./startup-scan.js";

export const PAW_NEXT_PRODUCT_PROFILE_SCHEMA_VERSION_V3 =
  "paw.next-product-profiles.v3" as const;
export const DEFAULT_PAW_NEXT_PRODUCT_PROFILE_FILE_V3 =
  ".paw/paw-next-product-profiles.v3.json" as const;
export const PAW_NEXT_MCP_RUNTIME_POLICY_VERSION_V1 =
  "paw.mcp-runtime.v1" as const;

export interface PawNextMcpRuntimeProfileV1 {
  readonly policyVersion: typeof PAW_NEXT_MCP_RUNTIME_POLICY_VERSION_V1;
  readonly servers: readonly McpServerConfig[];
  /** Exact mcp:<server>/<tool> targets available behind the fixed proxy. */
  readonly allowedTools: readonly string[];
}

export interface PawNextProductProfileV3
  extends Omit<PawNextProductProfileV1, "control"> {
  readonly control: {
    readonly mode: "interactive";
    readonly maxModelTurns: number;
    readonly naturalStop: "complete" | "await_user";
    readonly maxSegments: number;
    readonly maxTotalModelTurns: number;
  };
  readonly workSegmentPolicyVersion: typeof WORK_SEGMENT_POLICY_VERSION_V1;
  readonly payloadRuntime: FileDurableJsonPayloadRuntimePolicyV1;
  readonly mcp?: PawNextMcpRuntimeProfileV1;
  /** Optional root-only, read-only long-term memory plugin. */
  readonly memory?: PawNextMemoryPluginProfileV1;
}

export interface PawNextProductProfileStoreV3 {
  readonly schemaVersion: typeof PAW_NEXT_PRODUCT_PROFILE_SCHEMA_VERSION_V3;
  readonly profiles: readonly PawNextProductProfileV3[];
}

export interface LoadPawNextProductProfileStoreOptionsV3 {
  readonly workspaceRoot: string;
  readonly profilePath?: string;
}

export interface BuildPawNextTaskProfileInputV3 {
  readonly identity: Omit<PawNextStartupRunIdentityV1, "configHash">;
  readonly profile: PawNextProductProfileV3;
  readonly apiKey: string;
}

export interface PawNextTaskProfileOptionsV3 {
  readonly productVersion: "v3";
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly inputId: string;
  readonly goal: string;
  readonly model: LanguageModel;
  readonly profileIdentity: PawNextProductProfileIdentityV1;
  readonly credentialBindingHash: string;
  readonly providerProtocol: PawProviderProtocol;
  readonly transport: PawModelTransport;
  readonly permissionConfig: FrozenPermissionConfigV1;
  readonly systemPrompt: string;
  readonly maxModelTurns: number;
  readonly naturalStop: "complete" | "await_user";
  readonly maxSegments: number;
  readonly maxTotalModelTurns: number;
  readonly workSegmentPolicyVersion: typeof WORK_SEGMENT_POLICY_VERSION_V1;
  readonly contextWindowTokens: number;
  readonly reservedOutputTokens: number;
  readonly estimationMarginTokens: number;
  readonly estimatorId: string;
  readonly estimatorVersion: string;
  readonly heartbeatPolicy: SessionLeaseHeartbeatPolicyV1;
  readonly shellSandbox?: ShellSandboxConfig;
  readonly payloadRuntime: FileDurableJsonPayloadRuntimePolicyV1;
  readonly mcp?: PawNextMcpRuntimeProfileV1;
  readonly memory?: PawNextMemoryPluginProfileV1;
}

export interface BuiltPawNextTaskProfileV3 {
  readonly productVersion: "v3";
  readonly taskOptions: PawNextTaskProfileOptionsV3;
  readonly profile: PawNextProductProfileV3;
  readonly manifest: PawNextProductManifestV3;
  readonly configHash: string;
}

export function loadPawNextProductProfileStoreV3(
  options: LoadPawNextProductProfileStoreOptionsV3,
): PawNextProductProfileStoreV3 {
  const workspaceRoot = canonicalPawNextWorkspaceInternal(
    options.workspaceRoot,
  );
  const raw = readStrictPawNextWorkspaceJsonInternal(
    workspaceRoot,
    options.profilePath ??
      path.join(workspaceRoot, DEFAULT_PAW_NEXT_PRODUCT_PROFILE_FILE_V3),
    "Paw Next V3 product profile",
  );
  const root = exactRecordInternal(raw, "V3 profile store", [
    "schemaVersion",
    "profiles",
  ]);
  if (root.schemaVersion !== PAW_NEXT_PRODUCT_PROFILE_SCHEMA_VERSION_V3) {
    throw new Error("Unsupported Paw Next V3 product profile schemaVersion");
  }
  if (!Array.isArray(root.profiles)) {
    throw new Error("Paw Next V3 product profiles must be an array");
  }
  const profiles = root.profiles.map((value, index) =>
    parseProfileV3(value, `profiles[${index}]`),
  );
  assertUniqueProfiles(profiles);
  return Object.freeze({
    schemaVersion: PAW_NEXT_PRODUCT_PROFILE_SCHEMA_VERSION_V3,
    profiles: Object.freeze(profiles),
  });
}

export function buildPawNextTaskProfileV3(
  input: BuildPawNextTaskProfileInputV3,
): BuiltPawNextTaskProfileV3 {
  const profile = parseProfileV3(input.profile, "profile");
  const commonProfile: PawNextProductProfileV1 = Object.freeze({
    profileId: profile.profileId,
    revision: profile.revision,
    configHash: profile.configHash,
    model: profile.model,
    control: Object.freeze({
      mode: "interactive",
      maxModelTurns: profile.control.maxModelTurns,
      naturalStop: profile.control.naturalStop,
    }),
    systemPrompt: profile.systemPrompt,
    budget: profile.budget,
    permission: profile.permission,
    approval: profile.approval,
    heartbeat: profile.heartbeat,
    shellSandbox: profile.shellSandbox,
  });
  const task = buildPawNextTaskOptionsFromProfileInternal({
    identity: input.identity,
    profile: commonProfile,
    apiKey: input.apiKey,
  });
  const identityTask = Object.freeze({
    ...task,
    ...(profile.mcp === undefined ? {} : { mcp: profile.mcp }),
    ...(profile.memory === undefined ? {} : { memory: profile.memory }),
  });
  const v1 = preparePawNextProductRuntimeIdentityV3(identityTask).manifest;
  const manifest = createPawNextProductManifestV3({
    toolEffectCheckpointPolicyVersion: v1.toolEffectCheckpointPolicyVersion,
    runConfig: {
      mode: "interactive",
      maxModelTurns: profile.control.maxModelTurns,
      naturalStop: profile.control.naturalStop,
      maxSegments: profile.control.maxSegments,
      maxTotalModelTurns: profile.control.maxTotalModelTurns,
    },
    workSegmentPolicyVersion: profile.workSegmentPolicyVersion,
    model: v1.model,
    providerProtocol: v1.providerProtocol,
    transport: v1.transport,
    registryHash: v1.registryHash,
    shellSandboxHash: v1.shellSandboxHash,
    permissionPolicy: v1.permissionPolicy,
    approvalMode: v1.approvalMode,
    systemPromptHash: v1.systemPromptHash,
    contextBudget: v1.contextBudget,
    modelRuntimeProfile: v1.modelRuntimeProfile,
    modelCapabilities: v1.modelCapabilities,
    sessionLeaseHeartbeat: v1.sessionLeaseHeartbeat,
    profileIdentity: v1.profileIdentity,
    credentialBindingHash: v1.credentialBindingHash,
    payloadRuntime: profile.payloadRuntime,
    ...(profile.memory === undefined ? {} : { memory: profile.memory }),
  });
  const taskOptions: PawNextTaskProfileOptionsV3 = deepFreeze({
    productVersion: "v3",
    workspaceRoot: task.workspaceRoot,
    sessionId: task.sessionId,
    runId: task.runId,
    inputId: task.inputId,
    goal: task.goal,
    model: task.model,
    profileIdentity: task.profileIdentity as PawNextProductProfileIdentityV1,
    credentialBindingHash: task.credentialBindingHash as string,
    providerProtocol: task.providerProtocol as PawProviderProtocol,
    transport: task.transport as PawModelTransport,
    permissionConfig: task.permissionConfig as FrozenPermissionConfigV1,
    systemPrompt: task.systemPrompt as string,
    maxModelTurns: profile.control.maxModelTurns,
    naturalStop: profile.control.naturalStop,
    maxSegments: profile.control.maxSegments,
    maxTotalModelTurns: profile.control.maxTotalModelTurns,
    workSegmentPolicyVersion: profile.workSegmentPolicyVersion,
    contextWindowTokens: task.contextWindowTokens as number,
    reservedOutputTokens: task.reservedOutputTokens as number,
    estimationMarginTokens: task.estimationMarginTokens as number,
    estimatorId: task.estimatorId as string,
    estimatorVersion: task.estimatorVersion as string,
    heartbeatPolicy: task.heartbeatPolicy as SessionLeaseHeartbeatPolicyV1,
    ...(task.shellSandbox === undefined
      ? {}
      : { shellSandbox: task.shellSandbox }),
    payloadRuntime: profile.payloadRuntime,
    ...(profile.mcp === undefined ? {} : { mcp: profile.mcp }),
    ...(profile.memory === undefined ? {} : { memory: profile.memory }),
  });
  return deepFreeze({
    productVersion: "v3",
    taskOptions,
    profile,
    manifest,
    configHash: hashPawNextProductManifestV3(manifest),
  });
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function parseProfileV3(
  value: unknown,
  label: string,
): PawNextProductProfileV3 {
  const record = exactRecordWithOptionalKeysV1(
    value,
    label,
    [
      "profileId",
      "revision",
      "configHash",
      "model",
      "control",
      "systemPrompt",
      "budget",
      "permission",
      "approval",
      "heartbeat",
      "shellSandbox",
      "workSegmentPolicyVersion",
      "payloadRuntime",
    ],
    ["mcp", "memory"],
  );
  const control = parseControlV3(record.control, `${label}.control`);
  const common = parsePawNextProductProfileInternal(
    {
      profileId: record.profileId,
      revision: record.revision,
      configHash: record.configHash,
      model: record.model,
      control: {
        mode: control.mode,
        maxModelTurns: control.maxModelTurns,
        naturalStop: control.naturalStop,
      },
      systemPrompt: record.systemPrompt,
      budget: record.budget,
      permission: record.permission,
      approval: record.approval,
      heartbeat: record.heartbeat,
      shellSandbox: record.shellSandbox,
    },
    label,
  );
  if (record.workSegmentPolicyVersion !== WORK_SEGMENT_POLICY_VERSION_V1) {
    throw new Error("Unsupported Paw Next V3 work-segment policy version");
  }
  return Object.freeze({
    ...common,
    control,
    workSegmentPolicyVersion: WORK_SEGMENT_POLICY_VERSION_V1,
    payloadRuntime: freezeFileDurableJsonPayloadRuntimePolicyV1(
      record.payloadRuntime as FileDurableJsonPayloadRuntimePolicyV1,
    ),
    ...(record.mcp === undefined
      ? {}
      : { mcp: parseMcpRuntimeV1(record.mcp, `${label}.mcp`) }),
    ...(record.memory === undefined
      ? {}
      : { memory: freezePawNextMemoryPluginProfileV1(record.memory) }),
  });
}

function parseMcpRuntimeV1(
  value: unknown,
  label: string,
): PawNextMcpRuntimeProfileV1 {
  const record = exactRecordInternal(value, label, [
    "policyVersion",
    "servers",
    "allowedTools",
  ]);
  if (record.policyVersion !== PAW_NEXT_MCP_RUNTIME_POLICY_VERSION_V1) {
    throw new Error("Unsupported Paw Next MCP runtime policy version");
  }
  if (!Array.isArray(record.servers) || !Array.isArray(record.allowedTools)) {
    throw new Error("Paw Next MCP servers and allowedTools must be arrays");
  }
  const serverNames = new Set<string>();
  const servers = record.servers.map((server, index) => {
    const parsed = exactRecordWithOptionalKeysV1(
      server,
      `${label}.servers[${index}]`,
      ["name", "command", "args"],
      ["env"],
    );
    if (
      typeof parsed.name !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(parsed.name) ||
      serverNames.has(parsed.name) ||
      typeof parsed.command !== "string" ||
      !parsed.command.trim() ||
      !Array.isArray(parsed.args) ||
      !parsed.args.every((arg) => typeof arg === "string")
    ) {
      throw new Error(`Invalid or duplicate Paw Next MCP server: ${index}`);
    }
    let env: Record<string, string> | undefined;
    if (parsed.env !== undefined) {
      if (
        parsed.env === null ||
        typeof parsed.env !== "object" ||
        Array.isArray(parsed.env) ||
        !Object.entries(parsed.env).every(
          ([key, item]) => key.length > 0 && typeof item === "string",
        )
      ) {
        throw new Error(`Invalid Paw Next MCP server env: ${parsed.name}`);
      }
      env = Object.fromEntries(
        Object.entries(parsed.env as Record<string, string>).sort(([a], [b]) =>
          a.localeCompare(b),
        ),
      );
    }
    serverNames.add(parsed.name);
    return Object.freeze({
      name: parsed.name,
      command: parsed.command,
      args: Object.freeze([...(parsed.args as string[])]),
      ...(env === undefined ? {} : { env: Object.freeze(env) }),
    });
  });
  servers.sort((a, b) => a.name.localeCompare(b.name));
  const allowedTools = record.allowedTools.map((tool, index) => {
    if (typeof tool !== "string" || !/^mcp:[^/:\s]+\/[^/\s]+$/.test(tool)) {
      throw new Error(`Invalid Paw Next MCP allowed tool: ${index}`);
    }
    const serverName = tool.slice("mcp:".length, tool.indexOf("/"));
    if (!serverNames.has(serverName)) {
      throw new Error(`Paw Next MCP allowed tool has unknown server: ${tool}`);
    }
    return tool;
  });
  allowedTools.sort();
  if (new Set(allowedTools).size !== allowedTools.length) {
    throw new Error("Duplicate Paw Next MCP allowed tool");
  }
  return Object.freeze({
    policyVersion: PAW_NEXT_MCP_RUNTIME_POLICY_VERSION_V1,
    servers: Object.freeze(servers),
    allowedTools: Object.freeze(allowedTools),
  });
}

function exactRecordWithOptionalKeysV1(
  value: unknown,
  label: string,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new Error(`${label}.${key} is not supported`);
  }
  for (const key of requiredKeys) {
    if (!(key in record)) throw new Error(`${label}.${key} is required`);
  }
  return record;
}

function parseControlV3(
  value: unknown,
  label: string,
): PawNextProductProfileV3["control"] {
  const record = exactRecordInternal(value, label, [
    "mode",
    "maxModelTurns",
    "naturalStop",
    "maxSegments",
    "maxTotalModelTurns",
  ]);
  if (
    record.mode !== "interactive" ||
    !Number.isSafeInteger(record.maxModelTurns) ||
    (record.maxModelTurns as number) <= 0 ||
    (record.naturalStop !== "complete" &&
      record.naturalStop !== "await_user") ||
    !Number.isSafeInteger(record.maxSegments) ||
    (record.maxSegments as number) <= 0 ||
    !Number.isSafeInteger(record.maxTotalModelTurns) ||
    (record.maxTotalModelTurns as number) < (record.maxModelTurns as number)
  ) {
    throw new Error("Paw Next V3 control config is invalid");
  }
  return Object.freeze({
    mode: "interactive",
    maxModelTurns: record.maxModelTurns as number,
    naturalStop: record.naturalStop,
    maxSegments: record.maxSegments as number,
    maxTotalModelTurns: record.maxTotalModelTurns as number,
  });
}

function assertUniqueProfiles(
  profiles: readonly PawNextProductProfileV3[],
): void {
  const revisions = new Set<string>();
  const hashes = new Set<string>();
  for (const profile of profiles) {
    const revision = JSON.stringify([profile.profileId, profile.revision]);
    if (revisions.has(revision)) {
      throw new Error("Duplicate Paw Next V3 product profile revision");
    }
    if (hashes.has(profile.configHash)) {
      throw new Error("Duplicate Paw Next V3 product profile configHash");
    }
    revisions.add(revision);
    hashes.add(profile.configHash);
  }
}
