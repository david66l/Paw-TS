import path from "node:path";

import type { ShellSandboxConfig } from "@paw/harness";
import type {
  LanguageModel,
  PawModelTransport,
  PawProviderProtocol,
} from "@paw/models";
import {
  type FileDurableJsonPayloadRuntimePolicyV1,
  type FrozenPermissionConfigV1,
  type SessionLeaseHeartbeatPolicyV1,
  freezeFileDurableJsonPayloadRuntimePolicyV1,
} from "@paw/runtime";

import { preparePawNextProductRuntimeV1 } from "./composition.js";
import {
  type PawNextProductManifestV2,
  createPawNextProductManifestV2,
  hashPawNextProductManifestV2,
} from "./product-manifest-v2.js";
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

export const PAW_NEXT_PRODUCT_PROFILE_SCHEMA_VERSION_V2 =
  "paw.next-product-profiles.v2" as const;
export const DEFAULT_PAW_NEXT_PRODUCT_PROFILE_FILE_V2 =
  ".paw/paw-next-product-profiles.v2.json" as const;

export interface PawNextProductProfileV2 extends PawNextProductProfileV1 {
  readonly payloadRuntime: FileDurableJsonPayloadRuntimePolicyV1;
}

export interface PawNextProductProfileStoreV2 {
  readonly schemaVersion: typeof PAW_NEXT_PRODUCT_PROFILE_SCHEMA_VERSION_V2;
  readonly profiles: readonly PawNextProductProfileV2[];
}

export interface LoadPawNextProductProfileStoreOptionsV2 {
  readonly workspaceRoot: string;
  readonly profilePath?: string;
}

export interface BuildPawNextTaskProfileInputV2 {
  readonly identity: Omit<PawNextStartupRunIdentityV1, "configHash">;
  readonly profile: PawNextProductProfileV2;
  readonly apiKey: string;
}

/** Product inputs for the future V2 composition; deliberately not a V1 runner type. */
export interface PawNextTaskProfileOptionsV2 {
  readonly productVersion: "v2";
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
  readonly contextWindowTokens: number;
  readonly reservedOutputTokens: number;
  readonly estimationMarginTokens: number;
  readonly estimatorId: string;
  readonly estimatorVersion: string;
  readonly heartbeatPolicy: SessionLeaseHeartbeatPolicyV1;
  readonly shellSandbox?: ShellSandboxConfig;
  readonly payloadRuntime: FileDurableJsonPayloadRuntimePolicyV1;
}

export interface BuiltPawNextTaskProfileV2 {
  readonly productVersion: "v2";
  readonly taskOptions: PawNextTaskProfileOptionsV2;
  readonly profile: PawNextProductProfileV2;
  readonly manifest: PawNextProductManifestV2;
  readonly configHash: string;
}

export function loadPawNextProductProfileStoreV2(
  options: LoadPawNextProductProfileStoreOptionsV2,
): PawNextProductProfileStoreV2 {
  const workspaceRoot = canonicalPawNextWorkspaceInternal(
    options.workspaceRoot,
  );
  const raw = readStrictPawNextWorkspaceJsonInternal(
    workspaceRoot,
    options.profilePath ??
      path.join(workspaceRoot, DEFAULT_PAW_NEXT_PRODUCT_PROFILE_FILE_V2),
    "Paw Next V2 product profile",
  );
  const root = exactRecordInternal(raw, "V2 profile store", [
    "schemaVersion",
    "profiles",
  ]);
  if (root.schemaVersion !== PAW_NEXT_PRODUCT_PROFILE_SCHEMA_VERSION_V2) {
    throw new Error("Unsupported Paw Next V2 product profile schemaVersion");
  }
  if (!Array.isArray(root.profiles)) {
    throw new Error("Paw Next V2 product profiles must be an array");
  }
  const profiles = root.profiles.map((value, index) =>
    parseProfileV2(value, `profiles[${index}]`),
  );
  assertUniqueProfiles(profiles);
  return Object.freeze({
    schemaVersion: PAW_NEXT_PRODUCT_PROFILE_SCHEMA_VERSION_V2,
    profiles: Object.freeze(profiles),
  });
}

/** Build a V2 profile result without treating it as a runnable V1 product. */
export function buildPawNextTaskProfileV2(
  input: BuildPawNextTaskProfileInputV2,
): BuiltPawNextTaskProfileV2 {
  const profile = parseProfileV2(input.profile, "profile");
  const { payloadRuntime: _payloadRuntime, ...commonProfile } = profile;
  const taskOptions = buildPawNextTaskOptionsFromProfileInternal({
    identity: input.identity,
    profile: commonProfile,
    apiKey: input.apiKey,
  });
  const v1 = preparePawNextProductRuntimeV1(taskOptions).manifest;
  const manifest = createPawNextProductManifestV2({
    toolEffectCheckpointPolicyVersion: v1.toolEffectCheckpointPolicyVersion,
    reducerVersion: v1.reducerVersion,
    runConfig: v1.runConfig,
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
  });
  const v2TaskOptions: PawNextTaskProfileOptionsV2 = Object.freeze({
    productVersion: "v2",
    workspaceRoot: taskOptions.workspaceRoot,
    sessionId: taskOptions.sessionId,
    runId: taskOptions.runId,
    inputId: taskOptions.inputId,
    goal: taskOptions.goal,
    model: taskOptions.model,
    profileIdentity:
      taskOptions.profileIdentity as PawNextProductProfileIdentityV1,
    credentialBindingHash: taskOptions.credentialBindingHash as string,
    providerProtocol: taskOptions.providerProtocol as PawProviderProtocol,
    transport: taskOptions.transport as PawModelTransport,
    permissionConfig: taskOptions.permissionConfig as FrozenPermissionConfigV1,
    systemPrompt: taskOptions.systemPrompt as string,
    maxModelTurns: taskOptions.maxModelTurns as number,
    naturalStop: taskOptions.naturalStop as "complete" | "await_user",
    contextWindowTokens: taskOptions.contextWindowTokens as number,
    reservedOutputTokens: taskOptions.reservedOutputTokens as number,
    estimationMarginTokens: taskOptions.estimationMarginTokens as number,
    estimatorId: taskOptions.estimatorId as string,
    estimatorVersion: taskOptions.estimatorVersion as string,
    heartbeatPolicy:
      taskOptions.heartbeatPolicy as SessionLeaseHeartbeatPolicyV1,
    ...(taskOptions.shellSandbox === undefined
      ? {}
      : { shellSandbox: taskOptions.shellSandbox }),
    payloadRuntime: profile.payloadRuntime,
  });
  return Object.freeze({
    productVersion: "v2",
    taskOptions: v2TaskOptions,
    profile,
    manifest,
    configHash: hashPawNextProductManifestV2(manifest),
  });
}

function parseProfileV2(
  value: unknown,
  label: string,
): PawNextProductProfileV2 {
  const record = exactRecordInternal(value, label, [
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
    "payloadRuntime",
  ]);
  const common = parsePawNextProductProfileInternal(
    {
      profileId: record.profileId,
      revision: record.revision,
      configHash: record.configHash,
      model: record.model,
      control: record.control,
      systemPrompt: record.systemPrompt,
      budget: record.budget,
      permission: record.permission,
      approval: record.approval,
      heartbeat: record.heartbeat,
      shellSandbox: record.shellSandbox,
    },
    label,
  );
  return Object.freeze({
    ...common,
    payloadRuntime: freezeFileDurableJsonPayloadRuntimePolicyV1(
      record.payloadRuntime as FileDurableJsonPayloadRuntimePolicyV1,
    ),
  });
}

function assertUniqueProfiles(
  profiles: readonly PawNextProductProfileV2[],
): void {
  const revisions = new Set<string>();
  const hashes = new Set<string>();
  for (const profile of profiles) {
    const revision = JSON.stringify([profile.profileId, profile.revision]);
    if (revisions.has(revision)) {
      throw new Error("Duplicate Paw Next V2 product profile revision");
    }
    if (hashes.has(profile.configHash)) {
      throw new Error("Duplicate Paw Next V2 product profile configHash");
    }
    revisions.add(revision);
    hashes.add(profile.configHash);
  }
}
