import { CANONICAL_DURABLE_JSON_PAYLOAD_BINDING_VERSION_V1 } from "./canonical-payload-binding.js";
import {
  FILE_DURABLE_JSON_PAYLOAD_CODEC_V1,
  type FileDurableJsonPayloadPolicyV1,
  freezeFileDurableJsonPayloadPolicyV1,
} from "./file-durable-json-payload-store.js";
import {
  LOCATION_AWARE_PAYLOAD_MATERIALIZER_VERSION_V1,
  LOCATION_AWARE_PAYLOAD_SESSION_VERSION_V1,
} from "./location-aware-payload-session.js";
import {
  type VerifiedCanonicalPayloadBudgetV1,
  freezeVerifiedCanonicalPayloadBudgetV1,
} from "./verified-canonical-payload-index.js";

export interface FileDurableJsonPayloadRuntimePolicyV1 {
  readonly codec: typeof FILE_DURABLE_JSON_PAYLOAD_CODEC_V1;
  readonly storePolicy: FileDurableJsonPayloadPolicyV1;
  readonly readBudget: VerifiedCanonicalPayloadBudgetV1;
  readonly locationBindingVersion: typeof CANONICAL_DURABLE_JSON_PAYLOAD_BINDING_VERSION_V1;
  readonly locationAwareSessionVersion: typeof LOCATION_AWARE_PAYLOAD_SESSION_VERSION_V1;
  readonly materializerVersion: typeof LOCATION_AWARE_PAYLOAD_MATERIALIZER_VERSION_V1;
}

/** The one strict product-facing identity for the complete file payload runtime. */
export function freezeFileDurableJsonPayloadRuntimePolicyV1(
  value: FileDurableJsonPayloadRuntimePolicyV1,
): FileDurableJsonPayloadRuntimePolicyV1 {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\0") !==
      "codec\0locationAwareSessionVersion\0locationBindingVersion\0materializerVersion\0readBudget\0storePolicy"
  ) {
    throw new Error("File durable JSON payload runtime policy is invalid");
  }
  const codec = freezeCodec(value.codec);
  if (
    value.locationBindingVersion !==
      CANONICAL_DURABLE_JSON_PAYLOAD_BINDING_VERSION_V1 ||
    value.locationAwareSessionVersion !==
      LOCATION_AWARE_PAYLOAD_SESSION_VERSION_V1 ||
    value.materializerVersion !== LOCATION_AWARE_PAYLOAD_MATERIALIZER_VERSION_V1
  ) {
    throw new Error("File durable JSON payload runtime version is invalid");
  }
  const storePolicy = freezeFileDurableJsonPayloadPolicyV1(value.storePolicy);
  const readBudget = freezeVerifiedCanonicalPayloadBudgetV1(value.readBudget);
  return Object.freeze({
    codec,
    storePolicy,
    readBudget,
    locationBindingVersion: CANONICAL_DURABLE_JSON_PAYLOAD_BINDING_VERSION_V1,
    locationAwareSessionVersion: LOCATION_AWARE_PAYLOAD_SESSION_VERSION_V1,
    materializerVersion: LOCATION_AWARE_PAYLOAD_MATERIALIZER_VERSION_V1,
  });
}

function freezeCodec(
  value: typeof FILE_DURABLE_JSON_PAYLOAD_CODEC_V1,
): typeof FILE_DURABLE_JSON_PAYLOAD_CODEC_V1 {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\0") !== "id\0version" ||
    value.id !== FILE_DURABLE_JSON_PAYLOAD_CODEC_V1.id ||
    value.version !== FILE_DURABLE_JSON_PAYLOAD_CODEC_V1.version
  ) {
    throw new Error("File durable JSON payload codec is invalid");
  }
  return Object.freeze({
    id: FILE_DURABLE_JSON_PAYLOAD_CODEC_V1.id,
    version: FILE_DURABLE_JSON_PAYLOAD_CODEC_V1.version,
  });
}
