import {
  hashCanonicalJsonV1 as hashCanonicalJsonV1Core,
  immutableCanonicalJsonCloneV1,
} from "@paw/core";
import type { JsonValue } from "@paw/protocol";

export const PAW_NEXT_PRODUCT_MANIFEST_SCHEMA_VERSION_V1 = "paw.product-manifest.v1";
export const PAW_NEXT_PRODUCT_COMPOSITION_VERSION_V1 = "paw.product-composition.v1";
export const PAW_NEXT_INLINE_PAYLOAD_CODEC_V1 = Object.freeze({
  id: "paw.inline-durable-json",
  version: "v1",
});

export interface PawNextProductProfileIdentityV1 {
  readonly profileId: string;
  readonly revision: number;
}

export interface PawNextProductManifestV1 {
  readonly schemaVersion: typeof PAW_NEXT_PRODUCT_MANIFEST_SCHEMA_VERSION_V1;
  readonly compositionVersion: typeof PAW_NEXT_PRODUCT_COMPOSITION_VERSION_V1;
  readonly payloadCodec: {
    readonly id: string;
    readonly version: string;
  };
  readonly toolEffectCheckpointPolicyVersion: string;
  readonly reducerVersion: string;
  readonly runConfig: JsonValue;
  readonly model: string;
  readonly providerProtocol: string;
  readonly transport: string;
  readonly registryHash: string;
  readonly shellSandboxHash: string;
  readonly permissionPolicy: JsonValue;
  readonly approvalMode: "available" | "unavailable";
  readonly systemPromptHash: string;
  readonly contextBudget: JsonValue;
  readonly modelRuntimeProfile: JsonValue;
  readonly modelCapabilities: JsonValue;
  readonly sessionLeaseHeartbeat: JsonValue;
  /** Present only for strict profile-built product runs. */
  readonly profileIdentity?: PawNextProductProfileIdentityV1;
  /** Domain-separated credential fingerprint; contains no plaintext secret. */
  readonly credentialBindingHash?: string;
}

export interface CreatePawNextProductManifestInputV1 {
  readonly toolEffectCheckpointPolicyVersion: string;
  readonly reducerVersion: string;
  readonly runConfig: unknown;
  readonly model: string;
  readonly providerProtocol: string;
  readonly transport: string;
  readonly registryHash: string;
  readonly shellSandboxHash: string;
  readonly permissionPolicy: unknown;
  readonly approvalMode: "available" | "unavailable";
  readonly systemPromptHash: string;
  readonly contextBudget: unknown;
  readonly modelRuntimeProfile: unknown;
  readonly modelCapabilities: unknown;
  readonly sessionLeaseHeartbeat: unknown;
  readonly profileIdentity?: PawNextProductProfileIdentityV1;
  readonly credentialBindingHash?: string;
}

/** Build the one frozen identity shared by fresh and resume, without plaintext credentials. */
export function createPawNextProductManifestV1(
  input: CreatePawNextProductManifestInputV1,
): PawNextProductManifestV1 {
  if ((input.profileIdentity === undefined) !== (input.credentialBindingHash === undefined)) {
    throw new Error("Paw Next profile identity and credential binding must be provided together");
  }
  if (input.profileIdentity !== undefined) {
    if (
      input.profileIdentity === null ||
      typeof input.profileIdentity !== "object" ||
      Array.isArray(input.profileIdentity) ||
      Object.keys(input.profileIdentity).sort().join("\0") !== "profileId\0revision" ||
      typeof input.profileIdentity.profileId !== "string" ||
      !input.profileIdentity.profileId.trim() ||
      !Number.isSafeInteger(input.profileIdentity.revision) ||
      input.profileIdentity.revision <= 0
    ) {
      throw new Error("Invalid Paw Next product profile identity");
    }
    if (
      typeof input.credentialBindingHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(input.credentialBindingHash)
    ) {
      throw new Error("Invalid Paw Next credential binding hash");
    }
  }
  return toFrozenJsonValueV1({
    schemaVersion: PAW_NEXT_PRODUCT_MANIFEST_SCHEMA_VERSION_V1,
    compositionVersion: PAW_NEXT_PRODUCT_COMPOSITION_VERSION_V1,
    payloadCodec: PAW_NEXT_INLINE_PAYLOAD_CODEC_V1,
    ...input,
  }) as unknown as PawNextProductManifestV1;
}

export function hashPawNextProductManifestV1(manifest: PawNextProductManifestV1): string {
  return hashCanonicalJsonV1(manifest);
}

export function hashCanonicalJsonV1(value: unknown): string {
  return hashCanonicalJsonV1Core(value);
}

/**
 * Detached, key-normalized and deeply immutable JSON.
 *
 * Normalization is intentional: the returned object carries canonical (sorted)
 * key order, so re-encoding it is a fixed point and cannot drift from the hash
 * computed over the same value.
 */
export function toFrozenJsonValueV1(value: unknown): JsonValue {
  return immutableCanonicalJsonCloneV1(value);
}
