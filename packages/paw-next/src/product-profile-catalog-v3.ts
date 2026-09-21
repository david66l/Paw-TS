import { defaultSettingsPath, pawSettingsLocalSchema } from "@paw/settings";

import { preparePawNextProductRuntimeV1 } from "./composition.js";
import type { PawNextProductProfileCatalogResolutionV1 } from "./product-profile-catalog.js";
import {
  buildPawNextTaskOptionsFromProfileInternal,
  canonicalPawNextWorkspaceInternal,
  readStrictPawNextWorkspaceJsonInternal,
} from "./product-profile-common.js";
import {
  type PawNextProductProfileV2,
  buildPawNextTaskProfileV2,
  loadPawNextProductProfileStoreV2,
} from "./product-profile-v2.js";
import {
  type BuiltPawNextTaskProfileV3,
  type PawNextProductProfileV3,
  buildPawNextTaskProfileV3,
  loadPawNextProductProfileStoreV3,
} from "./product-profile-v3.js";
import {
  type PawNextProductProfileV1,
  loadPawNextProductProfileStoreV1,
} from "./product-profile.js";
import type { PawNextStartupRunIdentityV1 } from "./startup-scan.js";

export interface PawNextProductProfileCatalogSourceV3 {
  readonly profilePath?: string;
  readonly settingsPath?: string;
}

export interface CreatePawNextProductProfileCatalogOptionsV3 {
  readonly workspaceRoot: string;
  readonly v1?: PawNextProductProfileCatalogSourceV3;
  readonly v2?: PawNextProductProfileCatalogSourceV3;
  readonly v3?: PawNextProductProfileCatalogSourceV3;
}

export type PawNextProductProfileCatalogResolutionV3 =
  | PawNextProductProfileCatalogResolutionV1
  | BuiltPawNextTaskProfileV3;

type CatalogEntryV3 =
  | Readonly<{
      productVersion: "v1";
      profile: PawNextProductProfileV1;
      settingsPath: string;
    }>
  | Readonly<{
      productVersion: "v2";
      profile: PawNextProductProfileV2;
      settingsPath: string;
    }>
  | Readonly<{
      productVersion: "v3";
      profile: PawNextProductProfileV3;
      settingsPath: string;
    }>;

/** Explicit aggregate catalog; exact configHash misses never cross versions. */
export function createPawNextProductProfileCatalogV3(
  options: CreatePawNextProductProfileCatalogOptionsV3,
): (
  identity: PawNextStartupRunIdentityV1,
) => PawNextProductProfileCatalogResolutionV3 | undefined {
  const sources = freezeCatalogOptions(options);
  const workspaceRoot = canonicalPawNextWorkspaceInternal(
    sources.workspaceRoot,
  );
  const byHash = new Map<string, CatalogEntryV3>();
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
  if (sources.v3 !== undefined) {
    const store = loadPawNextProductProfileStoreV3({
      workspaceRoot,
      ...(sources.v3.profilePath === undefined
        ? {}
        : { profilePath: sources.v3.profilePath }),
    });
    const settingsPath =
      sources.v3.settingsPath ?? defaultSettingsPath(workspaceRoot);
    for (const profile of store.profiles) {
      addEntry(
        byHash,
        revisions,
        Object.freeze({ productVersion: "v3", profile, settingsPath }),
      );
    }
  }

  return (identity) => {
    if (
      canonicalPawNextWorkspaceInternal(identity.workspaceRoot) !==
      workspaceRoot
    ) {
      throw new Error("Paw Next V3 product profile catalog workspace mismatch");
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
    if (entry.productVersion === "v2") {
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
    }
    const candidate = buildPawNextTaskProfileV3({
      identity,
      profile: entry.profile,
      apiKey,
    });
    if (
      candidate.configHash !== entry.profile.configHash ||
      candidate.configHash !== identity.configHash
    ) {
      throw new Error("Paw Next V3 profile product configHash mismatch");
    }
    return candidate;
  };
}

function freezeCatalogOptions(
  value: CreatePawNextProductProfileCatalogOptionsV3,
): CreatePawNextProductProfileCatalogOptionsV3 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Paw Next V3 product profile catalog options are invalid");
  }
  for (const key of Object.keys(value)) {
    if (
      key !== "workspaceRoot" &&
      key !== "v1" &&
      key !== "v2" &&
      key !== "v3"
    ) {
      throw new Error(
        "Paw Next V3 product profile catalog options are invalid",
      );
    }
  }
  if (
    typeof value.workspaceRoot !== "string" ||
    !value.workspaceRoot.trim() ||
    (value.v1 === undefined && value.v2 === undefined && value.v3 === undefined)
  ) {
    throw new Error("Paw Next V3 product profile catalog options are invalid");
  }
  return Object.freeze({
    workspaceRoot: value.workspaceRoot,
    ...(value.v1 === undefined ? {} : { v1: freezeSource(value.v1, "v1") }),
    ...(value.v2 === undefined ? {} : { v2: freezeSource(value.v2, "v2") }),
    ...(value.v3 === undefined ? {} : { v3: freezeSource(value.v3, "v3") }),
  });
}

function freezeSource(
  value: PawNextProductProfileCatalogSourceV3,
  label: string,
): PawNextProductProfileCatalogSourceV3 {
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
  byHash: Map<string, CatalogEntryV3>,
  revisions: Set<string>,
  entry: CatalogEntryV3,
): void {
  if (byHash.has(entry.profile.configHash)) {
    throw new Error("Duplicate Paw Next V3 catalog configHash");
  }
  const revision = JSON.stringify([
    entry.profile.profileId,
    entry.profile.revision,
  ]);
  if (revisions.has(revision)) {
    throw new Error("Duplicate Paw Next V3 catalog profile revision");
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
