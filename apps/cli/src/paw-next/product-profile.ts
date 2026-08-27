import path from "node:path";

import type { ShellSandboxConfig } from "@paw/harness";
import type { PawModelTransport, PawProviderProtocol } from "@paw/models";
import type {
  FrozenPermissionConfigV1,
  SessionLeaseHeartbeatPolicyV1,
} from "@paw/runtime";
import { defaultSettingsPath, pawSettingsLocalSchema } from "@paw/settings";

import {
  type RunExistingPawNextTaskOptionsV1,
  preparePawNextProductRuntimeV1,
} from "./composition.js";
import {
  buildPawNextTaskOptionsFromProfileInternal,
  canonicalPawNextWorkspaceInternal,
  exactRecordInternal,
  parsePawNextProductProfileInternal,
  readStrictPawNextWorkspaceJsonInternal,
} from "./product-profile-common.js";
import type { PawNextStartupRunIdentityV1 } from "./startup-scan.js";

export const PAW_NEXT_PRODUCT_PROFILE_SCHEMA_VERSION_V1 =
  "paw.next-product-profiles.v1" as const;
export const DEFAULT_PAW_NEXT_PRODUCT_PROFILE_FILE_V1 =
  ".paw/paw-next-product-profiles.v1.json" as const;

export interface PawNextProductModelProfileV1 {
  readonly protocol: PawProviderProtocol;
  readonly transport: PawModelTransport;
  readonly model: string;
  readonly baseUrl: string;
  readonly capabilities: {
    readonly contextWindow: number;
    readonly maxOutputTokens: number;
  };
  readonly thinkingEnabled: boolean | null;
  readonly reasoningEffort: "high" | "max" | null;
  readonly credentialSlot: string;
}

export interface PawNextProductProfileV1 {
  readonly profileId: string;
  readonly revision: number;
  readonly configHash: string;
  readonly model: PawNextProductModelProfileV1;
  readonly control: {
    readonly mode: "interactive";
    readonly maxModelTurns: number;
    readonly naturalStop: "complete" | "await_user";
  };
  readonly systemPrompt: string;
  readonly budget: {
    readonly contextWindowTokens: number;
    readonly reservedOutputTokens: number;
    readonly estimationMarginTokens: number;
    readonly estimator: {
      readonly id: string;
      readonly version: string;
    };
  };
  readonly permission: FrozenPermissionConfigV1;
  readonly approval: "unavailable";
  readonly heartbeat: SessionLeaseHeartbeatPolicyV1;
  readonly shellSandbox: ShellSandboxConfig | null;
}

export interface PawNextProductProfileStoreV1 {
  readonly schemaVersion: typeof PAW_NEXT_PRODUCT_PROFILE_SCHEMA_VERSION_V1;
  readonly profiles: readonly PawNextProductProfileV1[];
}

export interface LoadPawNextProductProfileStoreOptionsV1 {
  readonly workspaceRoot: string;
  readonly profilePath?: string;
}

export interface BuildPawNextTaskOptionsFromProfileInputV1 {
  readonly identity: Omit<PawNextStartupRunIdentityV1, "configHash">;
  readonly profile: PawNextProductProfileV1;
  readonly apiKey: string;
}

export interface CreatePawNextProductProfileResolverOptionsV1 {
  readonly workspaceRoot: string;
  readonly profilePath?: string;
  readonly settingsPath?: string;
}

export function loadPawNextProductProfileStoreV1(
  options: LoadPawNextProductProfileStoreOptionsV1,
): PawNextProductProfileStoreV1 {
  const workspaceRoot = canonicalPawNextWorkspaceInternal(
    options.workspaceRoot,
  );
  const value = readStrictPawNextWorkspaceJsonInternal(
    workspaceRoot,
    options.profilePath ??
      path.join(workspaceRoot, DEFAULT_PAW_NEXT_PRODUCT_PROFILE_FILE_V1),
    "Paw Next product profile",
  );
  return parseProfileStore(value);
}

/** The only profile-to-product mapping shared by fresh callers and resume. */
export function buildPawNextTaskOptionsFromProfileV1(
  input: BuildPawNextTaskOptionsFromProfileInputV1,
): RunExistingPawNextTaskOptionsV1 {
  return buildPawNextTaskOptionsFromProfileInternal(input);
}

/** Build one strict V1 workspace resolver selected only by journal configHash. */
export function createPawNextProductProfileResolverV1(
  options: CreatePawNextProductProfileResolverOptionsV1,
): (
  identity: PawNextStartupRunIdentityV1,
) => RunExistingPawNextTaskOptionsV1 | undefined {
  const workspaceRoot = canonicalPawNextWorkspaceInternal(
    options.workspaceRoot,
  );
  const store = loadPawNextProductProfileStoreV1({
    workspaceRoot,
    ...(options.profilePath === undefined
      ? {}
      : { profilePath: options.profilePath }),
  });
  const settingsPath =
    options.settingsPath ?? defaultSettingsPath(workspaceRoot);
  return (identity) => {
    if (
      canonicalPawNextWorkspaceInternal(identity.workspaceRoot) !==
      workspaceRoot
    ) {
      throw new Error("Paw Next profile resolver workspace mismatch");
    }
    const profile = store.profiles.find(
      (candidate) => candidate.configHash === identity.configHash,
    );
    if (!profile) return undefined;
    const settingsValue = readStrictPawNextWorkspaceJsonInternal(
      workspaceRoot,
      settingsPath,
      "Paw Next credential settings",
    );
    const parsedSettings = pawSettingsLocalSchema.safeParse(settingsValue);
    if (!parsedSettings.success) {
      throw new Error("Paw Next credential settings schema is invalid");
    }
    const apiKey =
      parsedSettings.data.models?.[profile.model.credentialSlot]?.apiKey;
    if (typeof apiKey !== "string" || !apiKey.trim()) {
      throw new Error("Named Paw Next credential slot is unavailable");
    }
    const candidate = buildPawNextTaskOptionsFromProfileInternal({
      identity,
      profile,
      apiKey,
    });
    const prepared = preparePawNextProductRuntimeV1(candidate);
    if (prepared.configHash !== identity.configHash) {
      throw new Error("Paw Next profile product configHash mismatch");
    }
    return candidate;
  };
}

function parseProfileStore(value: unknown): PawNextProductProfileStoreV1 {
  const root = exactRecordInternal(value, "profile store", [
    "schemaVersion",
    "profiles",
  ]);
  if (root.schemaVersion !== PAW_NEXT_PRODUCT_PROFILE_SCHEMA_VERSION_V1) {
    throw new Error("Unsupported Paw Next product profile schemaVersion");
  }
  if (!Array.isArray(root.profiles)) {
    throw new Error("Paw Next product profiles must be an array");
  }
  const profiles = root.profiles.map((item, index) =>
    parsePawNextProductProfileInternal(item, `profiles[${index}]`),
  );
  const profileRevisions = new Set<string>();
  const configHashes = new Set<string>();
  for (const profile of profiles) {
    const revision = JSON.stringify([profile.profileId, profile.revision]);
    if (profileRevisions.has(revision)) {
      throw new Error("Duplicate Paw Next product profile revision");
    }
    if (configHashes.has(profile.configHash)) {
      throw new Error("Duplicate Paw Next product profile configHash");
    }
    profileRevisions.add(revision);
    configHashes.add(profile.configHash);
  }
  return Object.freeze({
    schemaVersion: PAW_NEXT_PRODUCT_PROFILE_SCHEMA_VERSION_V1,
    profiles: Object.freeze(profiles),
  });
}
