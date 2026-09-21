import { defaultSettingsPath, pawSettingsLocalSchema } from "@paw/settings";

import {
  type RunExistingPawNextTaskOptionsV1,
  preparePawNextProductRuntimeV1,
} from "./composition.js";
import {
  buildPawNextTaskOptionsFromProfileInternal,
  canonicalPawNextWorkspaceInternal,
  readStrictPawNextWorkspaceJsonInternal,
} from "./product-profile-common.js";
import {
  type BuiltPawNextTaskProfileV2,
  type PawNextProductProfileV2,
  buildPawNextTaskProfileV2,
  loadPawNextProductProfileStoreV2,
} from "./product-profile-v2.js";
import {
  type PawNextProductProfileV1,
  loadPawNextProductProfileStoreV1,
} from "./product-profile.js";
import type { PawNextStartupRunIdentityV1 } from "./startup-scan.js";

export interface PawNextProductProfileCatalogSourceV1 {
  readonly profilePath?: string;
  readonly settingsPath?: string;
}

export interface CreatePawNextProductProfileCatalogOptionsV1 {
  readonly workspaceRoot: string;
  readonly v1?: PawNextProductProfileCatalogSourceV1;
  readonly v2?: PawNextProductProfileCatalogSourceV1;
}

export type PawNextProductProfileCatalogResolutionV1 =
  | Readonly<{
      productVersion: "v1";
      options: RunExistingPawNextTaskOptionsV1;
    }>
  | BuiltPawNextTaskProfileV2;

type CatalogEntry =
  | Readonly<{
      productVersion: "v1";
      profile: PawNextProductProfileV1;
      settingsPath: string;
    }>
  | Readonly<{
      productVersion: "v2";
      profile: PawNextProductProfileV2;
      settingsPath: string;
    }>;

/**
 * Parse all explicitly enabled descriptor sources once, then resolve only an
 * exact journal configHash. Construction never reads credentials or builds a
 * provider model.
 */
export function createPawNextProductProfileCatalogV1(
  options: CreatePawNextProductProfileCatalogOptionsV1,
): (
  identity: PawNextStartupRunIdentityV1,
) => PawNextProductProfileCatalogResolutionV1 | undefined {
  const sources = freezeCatalogSources(options);
  if (sources.v1 === undefined && sources.v2 === undefined) {
    throw new Error("Paw Next product profile catalog requires a source");
  }
  const workspaceRoot = canonicalPawNextWorkspaceInternal(
    sources.workspaceRoot,
  );
  const byHash = new Map<string, CatalogEntry>();
  const revisions = new Set<string>();
  if (sources.v1 !== undefined) {
    const store = loadPawNextProductProfileStoreV1({
      workspaceRoot,
      ...(sources.v1.profilePath === undefined
        ? {}
        : { profilePath: sources.v1.profilePath }),
    });
    const settingsPath =
      sources.v1.settingsPath ?? defaultSettingsPath(workspaceRoot);
    for (const profile of store.profiles) {
      addEntry(
        byHash,
        revisions,
        Object.freeze({ productVersion: "v1", profile, settingsPath }),
      );
    }
  }
  if (sources.v2 !== undefined) {
    const store = loadPawNextProductProfileStoreV2({
      workspaceRoot,
      ...(sources.v2.profilePath === undefined
        ? {}
        : { profilePath: sources.v2.profilePath }),
    });
    const settingsPath =
      sources.v2.settingsPath ?? defaultSettingsPath(workspaceRoot);
    for (const profile of store.profiles) {
      addEntry(
        byHash,
        revisions,
        Object.freeze({ productVersion: "v2", profile, settingsPath }),
      );
    }
  }

  return (identity) => {
    if (
      canonicalPawNextWorkspaceInternal(identity.workspaceRoot) !==
      workspaceRoot
    ) {
      throw new Error("Paw Next product profile catalog workspace mismatch");
    }
    const entry = byHash.get(identity.configHash);
    if (!entry) return undefined;
    const apiKey = readCredential(
      workspaceRoot,
      entry.settingsPath,
      entry.profile.model.credentialSlot,
    );
    if (entry.productVersion === "v1") {
      const candidate = buildPawNextTaskOptionsFromProfileInternal({
        identity,
        profile: entry.profile,
        apiKey,
      });
      const prepared = preparePawNextProductRuntimeV1(candidate);
      if (
        prepared.configHash !== entry.profile.configHash ||
        prepared.configHash !== identity.configHash
      ) {
        throw new Error("Paw Next V1 profile product configHash mismatch");
      }
      return Object.freeze({ productVersion: "v1", options: candidate });
    }
    const candidate = buildPawNextTaskProfileV2({
      identity,
      profile: entry.profile,
      apiKey,
    });
    if (
      candidate.configHash !== entry.profile.configHash ||
      candidate.configHash !== identity.configHash
    ) {
      throw new Error("Paw Next V2 profile product configHash mismatch");
    }
    return candidate;
  };
}

function freezeCatalogSources(
  value: CreatePawNextProductProfileCatalogOptionsV1,
): CreatePawNextProductProfileCatalogOptionsV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Paw Next product profile catalog options are invalid");
  }
  const keys = Object.keys(value).sort().join("\0");
  if (
    keys !== "v1\0workspaceRoot" &&
    keys !== "v2\0workspaceRoot" &&
    keys !== "v1\0v2\0workspaceRoot"
  ) {
    throw new Error("Paw Next product profile catalog options are invalid");
  }
  if (typeof value.workspaceRoot !== "string" || !value.workspaceRoot.trim()) {
    throw new Error("Paw Next product profile catalog workspace is invalid");
  }
  return Object.freeze({
    workspaceRoot: value.workspaceRoot,
    ...(value.v1 === undefined ? {} : { v1: freezeSource(value.v1, "v1") }),
    ...(value.v2 === undefined ? {} : { v2: freezeSource(value.v2, "v2") }),
  });
}

function freezeSource(
  value: PawNextProductProfileCatalogSourceV1,
  label: string,
): PawNextProductProfileCatalogSourceV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Paw Next ${label} catalog source is invalid`);
  }
  for (const key of Object.keys(value)) {
    if (key !== "profilePath" && key !== "settingsPath") {
      throw new Error(`Paw Next ${label} catalog source is invalid`);
    }
  }
  for (const candidate of [value.profilePath, value.settingsPath]) {
    if (
      candidate !== undefined &&
      (typeof candidate !== "string" || !candidate.trim())
    ) {
      throw new Error(`Paw Next ${label} catalog source is invalid`);
    }
  }
  return Object.freeze({
    ...(value.profilePath === undefined
      ? {}
      : { profilePath: value.profilePath }),
    ...(value.settingsPath === undefined
      ? {}
      : { settingsPath: value.settingsPath }),
  });
}

function addEntry(
  byHash: Map<string, CatalogEntry>,
  revisions: Set<string>,
  entry: CatalogEntry,
): void {
  if (byHash.has(entry.profile.configHash)) {
    throw new Error("Duplicate Paw Next catalog configHash");
  }
  const revision = JSON.stringify([
    entry.profile.profileId,
    entry.profile.revision,
  ]);
  if (revisions.has(revision)) {
    throw new Error("Duplicate Paw Next catalog profile revision");
  }
  byHash.set(entry.profile.configHash, entry);
  revisions.add(revision);
}

function readCredential(
  workspaceRoot: string,
  settingsPath: string,
  credentialSlot: string,
): string {
  const value = readStrictPawNextWorkspaceJsonInternal(
    workspaceRoot,
    settingsPath,
    "Paw Next credential settings",
  );
  const parsed = pawSettingsLocalSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Paw Next credential settings schema is invalid");
  }
  const apiKey = parsed.data.models?.[credentialSlot]?.apiKey;
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    throw new Error("Named Paw Next credential slot is unavailable");
  }
  return apiKey;
}
