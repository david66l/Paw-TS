import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";
import {
  CANONICAL_DURABLE_JSON_PAYLOAD_BINDING_VERSION_V1,
  FILE_DURABLE_JSON_PAYLOAD_CODEC_V1,
  FILE_DURABLE_JSON_PAYLOAD_POLICY_VERSION_V1,
  type FileDurableJsonPayloadRuntimePolicyV1,
  LOCATION_AWARE_PAYLOAD_MATERIALIZER_VERSION_V1,
  LOCATION_AWARE_PAYLOAD_SESSION_VERSION_V1,
  VERIFIED_CANONICAL_PAYLOAD_BUDGET_POLICY_VERSION_V1,
} from "@paw/runtime";

import {
  PAW_NEXT_PRODUCT_COMPOSITION_VERSION_V2,
  PAW_NEXT_PRODUCT_MANIFEST_SCHEMA_VERSION_V2,
  createPawNextProductManifestV2,
  hashPawNextProductManifestV2,
} from "../src/paw-next/product-manifest-v2.js";
import {
  PAW_NEXT_INLINE_PAYLOAD_CODEC_V1,
  PAW_NEXT_PRODUCT_COMPOSITION_VERSION_V1,
  PAW_NEXT_PRODUCT_MANIFEST_SCHEMA_VERSION_V1,
  createPawNextProductManifestV1,
  hashPawNextProductManifestV1,
} from "../src/paw-next/product-manifest.js";

const SECRET = "sk-private-manifest-secret";
const V1_HASH =
  "a86c8e1f54d3ccf6710066128e73f2c843495ba6d874afb84c5a5b9c77a00e66";
const V2_HASH =
  "b74ee24d0df7bc7409c2c3aa482ea4645a05f3d2192cfec2f92f02b4a1f7f935";
const V1_CANONICAL_JSON =
  '{"approvalMode":"unavailable","compositionVersion":"paw.product-composition.v1","contextBudget":{"contextWindowTokens":32000,"estimationMarginTokens":256,"estimatorId":"core:openai:gpt-test","estimatorVersion":"v1","reservedOutputTokens":2048},"credentialBindingHash":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","model":"openai:gpt-test","modelCapabilities":{"contextWindow":32000,"maxOutputTokens":4096},"modelRuntimeProfile":{"model":"gpt-test","protocol":"openai-compatible","thinkingEnabled":false},"payloadCodec":{"id":"paw.inline-durable-json","version":"v1"},"permissionPolicy":{"defaultAction":"deny","policyVersion":"permission.v1","rules":[]},"profileIdentity":{"profileId":"profile-golden","revision":3},"providerProtocol":"openai-compatible","reducerVersion":"paw.interactive-control-reducer.v1","registryHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","runConfig":{"maxModelTurns":12,"mode":"interactive","naturalStop":"complete"},"schemaVersion":"paw.product-manifest.v1","sessionLeaseHeartbeat":{"intervalMs":30000,"policyVersion":"paw.session-lease-heartbeat.v1","ttlMs":90000},"shellSandboxHash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","systemPromptHash":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","toolEffectCheckpointPolicyVersion":"paw.tool-effect-checkpoint.v1","transport":"complete"}';

describe("Paw Next product manifest V1/V2 identity", () => {
  test("keeps the V1 canonical bytes, known hash, key set, and inline API unchanged", () => {
    const manifest = createPawNextProductManifestV1(commonInput());
    const expected = expectedV1Manifest();

    expect(manifest as unknown).toEqual(expected);
    expect(Object.keys(manifest)).toEqual([
      "schemaVersion",
      "compositionVersion",
      "payloadCodec",
      "toolEffectCheckpointPolicyVersion",
      "reducerVersion",
      "runConfig",
      "model",
      "providerProtocol",
      "transport",
      "registryHash",
      "shellSandboxHash",
      "permissionPolicy",
      "approvalMode",
      "systemPromptHash",
      "contextBudget",
      "modelRuntimeProfile",
      "modelCapabilities",
      "sessionLeaseHeartbeat",
      "profileIdentity",
      "credentialBindingHash",
    ]);
    expect(canonicalJson(manifest)).toBe(V1_CANONICAL_JSON);
    expect(independentSha256(V1_CANONICAL_JSON)).toBe(V1_HASH);
    expect(hashPawNextProductManifestV1(manifest)).toBe(V1_HASH);
    expect(manifest.schemaVersion).toBe(
      PAW_NEXT_PRODUCT_MANIFEST_SCHEMA_VERSION_V1,
    );
    expect(manifest.compositionVersion).toBe(
      PAW_NEXT_PRODUCT_COMPOSITION_VERSION_V1,
    );
    expect(manifest.payloadCodec).toEqual(PAW_NEXT_INLINE_PAYLOAD_CODEC_V1);
    expect("payloadRuntime" in manifest).toBeFalse();
    assertDeepFrozen(manifest);

    const compileOnlyV1HasNoPayloadRuntime = () => {
      createPawNextProductManifestV1({
        ...commonInput(),
        // @ts-expect-error V1 remains the inline-only builder API.
        payloadRuntime: payloadRuntime(),
      });
    };
    expect(compileOnlyV1HasNoPayloadRuntime).toBeFunction();
  });

  test("builds a deterministic detached V2 manifest with a literal known hash", () => {
    const input = { ...commonInput(), payloadRuntime: payloadRuntime() };
    const repeatedInput = {
      ...commonInput(),
      payloadRuntime: payloadRuntime(),
    };
    const manifest = createPawNextProductManifestV2(input);
    const repeated = createPawNextProductManifestV2(repeatedInput);

    expect(manifest as unknown).toEqual(expectedV2Manifest());
    expect(Object.keys(manifest)).toEqual([
      "schemaVersion",
      "compositionVersion",
      "payloadRuntime",
      "toolEffectCheckpointPolicyVersion",
      "reducerVersion",
      "runConfig",
      "model",
      "providerProtocol",
      "transport",
      "registryHash",
      "shellSandboxHash",
      "permissionPolicy",
      "approvalMode",
      "systemPromptHash",
      "contextBudget",
      "modelRuntimeProfile",
      "modelCapabilities",
      "sessionLeaseHeartbeat",
      "profileIdentity",
      "credentialBindingHash",
    ]);
    expect(manifest).toEqual(repeated);
    expect(hashPawNextProductManifestV2(manifest)).toBe(V2_HASH);
    expect(independentSha256(canonicalJson(manifest))).toBe(V2_HASH);
    expect(manifest.schemaVersion).toBe(
      PAW_NEXT_PRODUCT_MANIFEST_SCHEMA_VERSION_V2,
    );
    expect(manifest.compositionVersion).toBe(
      PAW_NEXT_PRODUCT_COMPOSITION_VERSION_V2,
    );
    expect("payloadCodec" in manifest).toBeFalse();
    expect(JSON.stringify(manifest)).not.toContain(SECRET);
    assertDeepFrozen(manifest);

    input.runConfig.maxModelTurns = 999;
    input.permissionPolicy.rules.push({ id: "caller-mutation" });
    (
      input.payloadRuntime.storePolicy as { maxArtifactBytes: number }
    ).maxArtifactBytes = 1;
    (
      input.payloadRuntime.readBudget as { maxTotalBytes: number }
    ).maxTotalBytes = 1;
    (
      input.payloadRuntime as {
        locationBindingVersion: string;
        locationAwareSessionVersion: string;
        materializerVersion: string;
      }
    ).locationBindingVersion = "caller-mutation";
    (
      input.payloadRuntime as {
        locationBindingVersion: string;
        locationAwareSessionVersion: string;
        materializerVersion: string;
      }
    ).locationAwareSessionVersion = "caller-mutation";
    (
      input.payloadRuntime as {
        locationBindingVersion: string;
        locationAwareSessionVersion: string;
        materializerVersion: string;
      }
    ).materializerVersion = "caller-mutation";
    expect(hashPawNextProductManifestV2(manifest)).toBe(V2_HASH);
    expect(manifest as unknown).toEqual(expectedV2Manifest());
  });

  test("changes the V2 hash for each legal mutable payload runtime dimension", () => {
    const baseline = createPawNextProductManifestV2({
      ...commonInput(),
      payloadRuntime: payloadRuntime(),
    });
    const variants = [
      {
        ...payloadRuntime(),
        storePolicy: {
          ...payloadRuntime().storePolicy,
          maxArtifactBytes: 8 * 1024 * 1024,
        },
      },
      {
        ...payloadRuntime(),
        readBudget: {
          ...payloadRuntime().readBudget,
          maxTotalBytes: 64 * 1024 * 1024,
        },
      },
    ];

    for (const variant of variants) {
      const changed = createPawNextProductManifestV2({
        ...commonInput(),
        payloadRuntime: variant,
      });
      expect(hashPawNextProductManifestV2(changed)).not.toBe(
        hashPawNextProductManifestV2(baseline),
      );
    }
  });

  test("strictly rejects missing, extra, inline, or version-drifted payload identity", () => {
    const valid = payloadRuntime();
    const missing = Object.keys(valid).map((key) => {
      const copy = { ...valid } as Record<string, unknown>;
      delete copy[key];
      return copy;
    });
    const invalid: unknown[] = [
      undefined,
      null,
      {},
      ...missing,
      { ...valid, extra: true },
      { ...valid, codec: PAW_NEXT_INLINE_PAYLOAD_CODEC_V1 },
      { ...valid, codec: { ...valid.codec, id: "other-codec" } },
      { ...valid, codec: { ...valid.codec, version: "v2" } },
      { ...valid, codec: { ...valid.codec, extra: true } },
      { ...valid, storePolicy: { ...valid.storePolicy, extra: true } },
      {
        ...valid,
        storePolicy: { ...valid.storePolicy, policyVersion: "store.v2" },
      },
      { ...valid, readBudget: { ...valid.readBudget, extra: true } },
      {
        ...valid,
        readBudget: { ...valid.readBudget, policyVersion: "budget.v2" },
      },
      { ...valid, locationBindingVersion: "binding.v2" },
      { ...valid, locationAwareSessionVersion: "session.v2" },
      { ...valid, materializerVersion: "materializer.v2" },
    ];

    for (const payload of invalid) {
      expect(() =>
        createPawNextProductManifestV2({
          ...commonInput(),
          payloadRuntime: payload as never,
        }),
      ).toThrow();
    }

    const { payloadRuntime: _missingRuntime, ...missingRuntime } = {
      ...commonInput(),
      payloadRuntime: valid,
    };
    expect(() =>
      createPawNextProductManifestV2(missingRuntime as never),
    ).toThrow();
  });

  test("ignores hostile top-level identity overrides and secret-bearing extras", () => {
    const hostile = {
      ...commonInput(),
      payloadRuntime: payloadRuntime(),
      schemaVersion: "attacker.schema.v999",
      compositionVersion: "attacker.composition.v999",
      payloadCodec: PAW_NEXT_INLINE_PAYLOAD_CODEC_V1,
      apiKey: SECRET,
      extra: { secret: SECRET },
    };
    const manifest = createPawNextProductManifestV2(hostile);
    const serialized = JSON.stringify(manifest);

    expect(manifest as unknown).toEqual(expectedV2Manifest());
    expect(hashPawNextProductManifestV2(manifest)).toBe(V2_HASH);
    expect(manifest.schemaVersion).toBe(
      PAW_NEXT_PRODUCT_MANIFEST_SCHEMA_VERSION_V2,
    );
    expect(manifest.compositionVersion).toBe(
      PAW_NEXT_PRODUCT_COMPOSITION_VERSION_V2,
    );
    expect("payloadCodec" in manifest).toBeFalse();
    expect("apiKey" in manifest).toBeFalse();
    expect("extra" in manifest).toBeFalse();
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("attacker.");
  });

  test("retains the paired profile and credential identity rule without serializing a secret", () => {
    const common = commonInput();
    const { credentialBindingHash: _credential, ...withoutCredential } = common;
    const { profileIdentity: _profile, ...withoutProfile } = common;

    expect(() =>
      createPawNextProductManifestV2({
        ...withoutCredential,
        payloadRuntime: payloadRuntime(),
      } as never),
    ).toThrow("provided together");
    expect(() =>
      createPawNextProductManifestV2({
        ...withoutProfile,
        payloadRuntime: payloadRuntime(),
      } as never),
    ).toThrow("provided together");

    const manifest = createPawNextProductManifestV2({
      ...common,
      payloadRuntime: payloadRuntime(),
    });
    expect(JSON.stringify(manifest)).not.toContain(SECRET);
    expect(manifest.credentialBindingHash).toMatch(/^[a-f0-9]{64}$/);
  });
});

function commonInput() {
  return {
    toolEffectCheckpointPolicyVersion: "paw.tool-effect-checkpoint.v1",
    reducerVersion: "paw.interactive-control-reducer.v1",
    runConfig: {
      mode: "interactive",
      maxModelTurns: 12,
      naturalStop: "complete",
    },
    model: "openai:gpt-test",
    providerProtocol: "openai-compatible",
    transport: "complete",
    registryHash: "a".repeat(64),
    shellSandboxHash: "b".repeat(64),
    permissionPolicy: {
      policyVersion: "permission.v1",
      defaultAction: "deny",
      rules: [] as Array<{ id: string }>,
    },
    approvalMode: "unavailable" as const,
    systemPromptHash: "c".repeat(64),
    contextBudget: {
      contextWindowTokens: 32_000,
      reservedOutputTokens: 2_048,
      estimationMarginTokens: 256,
      estimatorId: "core:openai:gpt-test",
      estimatorVersion: "v1",
    },
    modelRuntimeProfile: {
      protocol: "openai-compatible",
      model: "gpt-test",
      thinkingEnabled: false,
    },
    modelCapabilities: { contextWindow: 32_000, maxOutputTokens: 4_096 },
    sessionLeaseHeartbeat: {
      policyVersion: "paw.session-lease-heartbeat.v1",
      ttlMs: 90_000,
      intervalMs: 30_000,
    },
    profileIdentity: { profileId: "profile-golden", revision: 3 },
    credentialBindingHash: "d".repeat(64),
  };
}

function payloadRuntime(): FileDurableJsonPayloadRuntimePolicyV1 {
  return {
    codec: {
      id: FILE_DURABLE_JSON_PAYLOAD_CODEC_V1.id,
      version: FILE_DURABLE_JSON_PAYLOAD_CODEC_V1.version,
    },
    storePolicy: {
      policyVersion: FILE_DURABLE_JSON_PAYLOAD_POLICY_VERSION_V1,
      maxArtifactBytes: 16 * 1024 * 1024,
    },
    readBudget: {
      policyVersion: VERIFIED_CANONICAL_PAYLOAD_BUDGET_POLICY_VERSION_V1,
      maxTotalBytes: 32 * 1024 * 1024,
    },
    locationBindingVersion: CANONICAL_DURABLE_JSON_PAYLOAD_BINDING_VERSION_V1,
    locationAwareSessionVersion: LOCATION_AWARE_PAYLOAD_SESSION_VERSION_V1,
    materializerVersion: LOCATION_AWARE_PAYLOAD_MATERIALIZER_VERSION_V1,
  };
}

function expectedV1Manifest() {
  return {
    schemaVersion: "paw.product-manifest.v1",
    compositionVersion: "paw.product-composition.v1",
    payloadCodec: { id: "paw.inline-durable-json", version: "v1" },
    ...commonInput(),
  };
}

function expectedV2Manifest() {
  return {
    schemaVersion: "paw.product-manifest.v2",
    compositionVersion: "paw.product-composition.v2",
    payloadRuntime: {
      codec: { id: "paw.file-durable-json", version: "v1" },
      storePolicy: {
        policyVersion: "paw.file-durable-json-payload-policy.v1",
        maxArtifactBytes: 16 * 1024 * 1024,
      },
      readBudget: {
        policyVersion: "paw.verified-canonical-payload-budget.v1",
        maxTotalBytes: 32 * 1024 * 1024,
      },
      locationBindingVersion: "paw.canonical-durable-json-payload-binding.v1",
      locationAwareSessionVersion: "paw.location-aware-payload-session.v1",
      materializerVersion: "paw.location-aware-payload-materializer.v1",
    },
    ...commonInput(),
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function independentSha256(value: string): string {
  return createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex");
}

function assertDeepFrozen(value: unknown): void {
  if (!value || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBeTrue();
  for (const nested of Object.values(value)) assertDeepFrozen(nested);
}
