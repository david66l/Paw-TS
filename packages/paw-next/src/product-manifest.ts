import { createHash } from "node:crypto";

import type { JsonValue } from "@paw/protocol";

export const PAW_NEXT_PRODUCT_MANIFEST_SCHEMA_VERSION_V1 =
  "paw.product-manifest.v1";
export const PAW_NEXT_PRODUCT_COMPOSITION_VERSION_V1 =
  "paw.product-composition.v1";
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
  if (
    (input.profileIdentity === undefined) !==
    (input.credentialBindingHash === undefined)
  ) {
    throw new Error(
      "Paw Next profile identity and credential binding must be provided together",
    );
  }
  if (input.profileIdentity !== undefined) {
    if (
      input.profileIdentity === null ||
      typeof input.profileIdentity !== "object" ||
      Array.isArray(input.profileIdentity) ||
      Object.keys(input.profileIdentity).sort().join("\0") !==
        "profileId\0revision" ||
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
  return freezeJson(
    toJsonValue({
      schemaVersion: PAW_NEXT_PRODUCT_MANIFEST_SCHEMA_VERSION_V1,
      compositionVersion: PAW_NEXT_PRODUCT_COMPOSITION_VERSION_V1,
      payloadCodec: PAW_NEXT_INLINE_PAYLOAD_CODEC_V1,
      ...input,
    }),
  ) as unknown as PawNextProductManifestV1;
}

export function hashPawNextProductManifestV1(
  manifest: PawNextProductManifestV1,
): string {
  return hashCanonicalJsonV1(manifest);
}

export function hashCanonicalJsonV1(value: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(toJsonValue(value)))
    .digest("hex");
}

export function toFrozenJsonValueV1(value: unknown): JsonValue {
  return freezeJson(toJsonValue(value));
}

function freezeJson<T extends JsonValue>(value: T): T {
  if (value !== null && typeof value === "object") {
    if (Array.isArray(value)) {
      for (const item of value) freezeJson(item);
    } else {
      for (const item of Object.values(value)) freezeJson(item);
    }
    Object.freeze(value);
  }
  return value;
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

function toJsonValue(value: unknown, seen = new Set<object>()): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Value is not valid JSON");
    return value;
  }
  if (typeof value !== "object") throw new Error("Value is not valid JSON");
  if (seen.has(value)) throw new Error("Value contains a JSON cycle");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => toJsonValue(item, seen));
    }
    const output: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) output[key] = toJsonValue(item, seen);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}
