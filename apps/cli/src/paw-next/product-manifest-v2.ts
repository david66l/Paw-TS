import {
  type FileDurableJsonPayloadRuntimePolicyV1,
  freezeFileDurableJsonPayloadRuntimePolicyV1,
} from "@paw/runtime";

import {
  type CreatePawNextProductManifestInputV1,
  type PawNextProductManifestV1,
  createPawNextProductManifestV1,
  hashCanonicalJsonV1,
  toFrozenJsonValueV1,
} from "./product-manifest.js";

export const PAW_NEXT_PRODUCT_MANIFEST_SCHEMA_VERSION_V2 =
  "paw.product-manifest.v2" as const;
export const PAW_NEXT_PRODUCT_COMPOSITION_VERSION_V2 =
  "paw.product-composition.v2" as const;

type PawNextProductManifestCommonV1 = Omit<
  PawNextProductManifestV1,
  "schemaVersion" | "compositionVersion" | "payloadCodec"
>;

/** The additive V2 manifest. V1 remains the inline-only product identity. */
export interface PawNextProductManifestV2
  extends PawNextProductManifestCommonV1 {
  readonly schemaVersion: typeof PAW_NEXT_PRODUCT_MANIFEST_SCHEMA_VERSION_V2;
  readonly compositionVersion: typeof PAW_NEXT_PRODUCT_COMPOSITION_VERSION_V2;
  readonly payloadRuntime: FileDurableJsonPayloadRuntimePolicyV1;
}

export interface CreatePawNextProductManifestInputV2
  extends CreatePawNextProductManifestInputV1 {
  readonly payloadRuntime: FileDurableJsonPayloadRuntimePolicyV1;
}

/**
 * Build a detached V2 product identity. No payload runtime dimension is
 * optional or defaulted; callers must provide the complete Runtime policy.
 */
export function createPawNextProductManifestV2(
  input: CreatePawNextProductManifestInputV2,
): PawNextProductManifestV2 {
  const payloadRuntime = freezeFileDurableJsonPayloadRuntimePolicyV1(
    input.payloadRuntime,
  );
  // V1 remains the authority for every common field and for the paired
  // profile/credential identity rule. Only its inline payload identity is
  // deliberately replaced below.
  const v1 = createPawNextProductManifestV1({
    toolEffectCheckpointPolicyVersion: input.toolEffectCheckpointPolicyVersion,
    reducerVersion: input.reducerVersion,
    runConfig: input.runConfig,
    model: input.model,
    providerProtocol: input.providerProtocol,
    transport: input.transport,
    registryHash: input.registryHash,
    shellSandboxHash: input.shellSandboxHash,
    permissionPolicy: input.permissionPolicy,
    approvalMode: input.approvalMode,
    systemPromptHash: input.systemPromptHash,
    contextBudget: input.contextBudget,
    modelRuntimeProfile: input.modelRuntimeProfile,
    modelCapabilities: input.modelCapabilities,
    sessionLeaseHeartbeat: input.sessionLeaseHeartbeat,
    profileIdentity: input.profileIdentity,
    credentialBindingHash: input.credentialBindingHash,
  });
  const {
    schemaVersion: _schemaVersion,
    compositionVersion: _compositionVersion,
    payloadCodec: _payloadCodec,
    ...common
  } = v1;
  return toFrozenJsonValueV1({
    schemaVersion: PAW_NEXT_PRODUCT_MANIFEST_SCHEMA_VERSION_V2,
    compositionVersion: PAW_NEXT_PRODUCT_COMPOSITION_VERSION_V2,
    payloadRuntime,
    ...common,
  }) as unknown as PawNextProductManifestV2;
}

export function hashPawNextProductManifestV2(
  manifest: PawNextProductManifestV2,
): string {
  return hashCanonicalJsonV1(manifest);
}
