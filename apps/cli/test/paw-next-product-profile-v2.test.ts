import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import {
  CANONICAL_DURABLE_JSON_PAYLOAD_BINDING_VERSION_V1,
  FILE_DURABLE_JSON_PAYLOAD_CODEC_V1,
  FILE_DURABLE_JSON_PAYLOAD_POLICY_VERSION_V1,
  LOCATION_AWARE_PAYLOAD_MATERIALIZER_VERSION_V1,
  LOCATION_AWARE_PAYLOAD_SESSION_VERSION_V1,
  VERIFIED_CANONICAL_PAYLOAD_BUDGET_POLICY_VERSION_V1,
} from "@paw/runtime";

import { preparePawNextProductRuntimeV1 } from "../src/paw-next/composition.js";
import { hashPawNextProductManifestV2 } from "../src/paw-next/product-manifest-v2.js";
import { createPawNextProductProfileCatalogV1 } from "../src/paw-next/product-profile-catalog.js";
import {
  DEFAULT_PAW_NEXT_PRODUCT_PROFILE_FILE_V2,
  PAW_NEXT_PRODUCT_PROFILE_SCHEMA_VERSION_V2,
  buildPawNextTaskProfileV2,
  loadPawNextProductProfileStoreV2,
} from "../src/paw-next/product-profile-v2.js";
import {
  DEFAULT_PAW_NEXT_PRODUCT_PROFILE_FILE_V1,
  PAW_NEXT_PRODUCT_PROFILE_SCHEMA_VERSION_V1,
  buildPawNextTaskOptionsFromProfileV1,
  createPawNextProductProfileResolverV1,
} from "../src/paw-next/product-profile.js";

const SECRET_ONE = "sk-catalog-one";
const SECRET_TWO = "sk-catalog-two";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("Paw Next V2 product profile and exact catalog", () => {
  test("strictly loads the complete V2 schema and recursively freezes its payload identity", () => {
    const root = workspace();
    const profile = v2Profile("strict-v2", 1);
    writeV2Store(root, [profile]);

    const loaded = loadPawNextProductProfileStoreV2({ workspaceRoot: root });
    expect(loaded.schemaVersion).toBe(
      PAW_NEXT_PRODUCT_PROFILE_SCHEMA_VERSION_V2,
    );
    expect(loaded.profiles[0]).toEqual(profile);
    assertDeepFrozen(loaded);

    const invalid: unknown[] = [
      null,
      {},
      { schemaVersion: PAW_NEXT_PRODUCT_PROFILE_SCHEMA_VERSION_V2 },
      {
        schemaVersion: PAW_NEXT_PRODUCT_PROFILE_SCHEMA_VERSION_V2,
        profiles: {},
      },
      {
        schemaVersion: "paw.next-product-profiles.v3",
        profiles: [profile],
      },
      {
        schemaVersion: PAW_NEXT_PRODUCT_PROFILE_SCHEMA_VERSION_V2,
        profiles: [{ ...profile, extra: true }],
      },
      {
        schemaVersion: PAW_NEXT_PRODUCT_PROFILE_SCHEMA_VERSION_V2,
        profiles: [without(profile, "payloadRuntime")],
      },
      {
        schemaVersion: PAW_NEXT_PRODUCT_PROFILE_SCHEMA_VERSION_V2,
        profiles: [
          {
            ...profile,
            payloadRuntime: {
              ...profile.payloadRuntime,
              locationAwareSessionVersion: "session.v2",
            },
          },
        ],
      },
      {
        schemaVersion: PAW_NEXT_PRODUCT_PROFILE_SCHEMA_VERSION_V2,
        profiles: [{ ...profile, revision: 0 }],
      },
      {
        schemaVersion: PAW_NEXT_PRODUCT_PROFILE_SCHEMA_VERSION_V2,
        profiles: [{ ...profile, revision: Number.MAX_SAFE_INTEGER + 1 }],
      },
    ];
    for (const value of invalid) {
      writeJson(v2Path(root), value);
      expect(() =>
        loadPawNextProductProfileStoreV2({ workspaceRoot: root }),
      ).toThrow();
    }
  });

  test("builds one explicit V2 identity and never feeds stored configHash back into it", () => {
    const root = workspace();
    const identity = taskIdentity(root, "direct-v2");
    const first = buildPawNextTaskProfileV2({
      identity,
      profile: v2Profile("direct-v2", 1, "primary", "a".repeat(64)),
      apiKey: SECRET_ONE,
    });
    const second = buildPawNextTaskProfileV2({
      identity,
      profile: v2Profile("direct-v2", 1, "primary", "b".repeat(64)),
      apiKey: SECRET_ONE,
    });

    expect(first.productVersion).toBe("v2");
    expect(first.taskOptions.productVersion).toBe("v2");
    expect(first.configHash).toBe(hashPawNextProductManifestV2(first.manifest));
    expect(second.configHash).toBe(first.configHash);
    expect(first.taskOptions.payloadRuntime).toEqual(payloadRuntime());
    assertDeepFrozen(first.taskOptions.payloadRuntime);
    expect(JSON.stringify(first.manifest)).not.toContain(SECRET_ONE);
  });

  test("constructs without credentials and performs exact no-hit with zero credential access", () => {
    const root = workspace();
    writeV2Store(root, [v2Profile("lazy-v2", 1)]);
    const catalog = createPawNextProductProfileCatalogV1({
      workspaceRoot: root,
      v2: {},
    });

    expect(
      catalog({
        ...taskIdentity(root, "lazy-v2"),
        configHash: "f".repeat(64),
      }),
    ).toBeUndefined();
    expect(fs.existsSync(settingsPath(root))).toBeFalse();
  });

  test("resolves V1 and V2 only by exact declared and journal hash", () => {
    const root = workspace();
    const identity = taskIdentity(root, "catalog-exact");
    const v1Seed = v1Profile("shared-profile", 1);
    const v1Options = buildPawNextTaskOptionsFromProfileV1({
      identity,
      profile: v1Seed,
      apiKey: SECRET_ONE,
    });
    const v1Hash = preparePawNextProductRuntimeV1(v1Options).configHash;
    const v2Seed = v2Profile("shared-profile", 2);
    const v2Hash = buildPawNextTaskProfileV2({
      identity,
      profile: v2Seed,
      apiKey: SECRET_ONE,
    }).configHash;
    writeV1Store(root, [{ ...v1Seed, configHash: v1Hash }]);
    writeV2Store(root, [{ ...v2Seed, configHash: v2Hash }]);
    writeSettings(root, { primary: SECRET_ONE });

    const catalog = createPawNextProductProfileCatalogV1({
      workspaceRoot: root,
      v1: {},
      v2: {},
    });
    const v1 = catalog({ ...identity, configHash: v1Hash });
    const v2 = catalog({ ...identity, configHash: v2Hash });
    expect(v1?.productVersion).toBe("v1");
    expect(v2?.productVersion).toBe("v2");
    if (!v1 || v1.productVersion !== "v1") throw new Error("missing V1");
    if (!v2 || v2.productVersion !== "v2") throw new Error("missing V2");
    expect(preparePawNextProductRuntimeV1(v1.options).configHash).toBe(v1Hash);
    expect(v2.configHash).toBe(v2Hash);
    expect(v2.profile.configHash).toBe(v2Hash);
    expect(v2.taskOptions.payloadRuntime).toEqual(payloadRuntime());
  });

  test("rejects an exact V2 declared and journal hash when the builder recomputes another identity", () => {
    const root = workspace();
    const identity = taskIdentity(root, "v2-hash-mismatch");
    const fakeV2Hash = "6".repeat(64);
    const v1Seed = v1Profile("usable-v1-sibling", 1);
    const v1Hash = preparePawNextProductRuntimeV1(
      buildPawNextTaskOptionsFromProfileV1({
        identity,
        profile: v1Seed,
        apiKey: SECRET_ONE,
      }),
    ).configHash;
    writeV1Store(root, [{ ...v1Seed, configHash: v1Hash }]);
    writeV2Store(root, [v2Profile("mismatched-v2", 1, "primary", fakeV2Hash)]);
    writeSettings(root, { primary: SECRET_ONE });
    const catalog = createPawNextProductProfileCatalogV1({
      workspaceRoot: root,
      v1: {},
      v2: {},
    });

    expect(() => catalog({ ...identity, configHash: fakeV2Hash })).toThrow(
      "V2 profile product configHash mismatch",
    );
    expect(catalog({ ...identity, configHash: v1Hash })?.productVersion).toBe(
      "v1",
    );
  });

  test("freezes and detaches every V2 resolved identity object from caller mutation", () => {
    const root = workspace();
    const identity = taskIdentity(root, "v2-detached");
    const source = v2Profile("v2-detached", 1);
    const result = buildPawNextTaskProfileV2({
      identity,
      profile: source,
      apiKey: SECRET_ONE,
    });
    const originalHash = result.configHash;

    expect(Object.isFrozen(result)).toBeTrue();
    expect(Object.isFrozen(result.taskOptions)).toBeTrue();
    expect(Object.isFrozen(result.profile)).toBeTrue();
    expect(Object.isFrozen(result.manifest)).toBeTrue();
    assertDeepFrozen(result.profile);
    assertDeepFrozen(result.manifest);
    assertDeepFrozen(result.taskOptions.payloadRuntime);
    expect(result.profile).not.toBe(source);
    expect(result.profile.payloadRuntime).not.toBe(source.payloadRuntime);
    expect(result.taskOptions.payloadRuntime).not.toBe(source.payloadRuntime);

    source.model.model = "caller-mutated-model";
    (
      source.permission.rules as Array<{
        id: string;
        layer: "default";
        action: "deny";
      }>
    ).push({
      id: "caller-mutated-rule",
      layer: "default",
      action: "deny",
    });
    source.payloadRuntime.storePolicy.maxArtifactBytes = 1;
    source.payloadRuntime.readBudget.maxTotalBytes = 1;
    (
      source.payloadRuntime as {
        locationBindingVersion: string;
        locationAwareSessionVersion: string;
        materializerVersion: string;
      }
    ).locationBindingVersion = "caller-mutated-binding";

    expect(result.configHash).toBe(originalHash);
    expect(hashPawNextProductManifestV2(result.manifest)).toBe(originalHash);
    expect(result.profile.model.model).toBe("profile-v2-test-model");
    expect(result.profile.permission.rules).toEqual([]);
    expect(result.profile.payloadRuntime).toEqual(payloadRuntime());
    expect(result.taskOptions.payloadRuntime).toEqual(payloadRuntime());
  });

  test("fails catalog ambiguity while allowing the same profile id at another revision", () => {
    const duplicateHashRoot = workspace();
    const duplicateHash = "1".repeat(64);
    writeV1Store(duplicateHashRoot, [
      v1Profile("v1-hash", 1, "primary", duplicateHash),
    ]);
    writeV2Store(duplicateHashRoot, [
      v2Profile("v2-hash", 1, "primary", duplicateHash),
    ]);
    expect(() =>
      createPawNextProductProfileCatalogV1({
        workspaceRoot: duplicateHashRoot,
        v1: {},
        v2: {},
      }),
    ).toThrow("configHash");

    const duplicateRevisionRoot = workspace();
    writeV1Store(duplicateRevisionRoot, [
      v1Profile("same", 1, "primary", "2".repeat(64)),
    ]);
    writeV2Store(duplicateRevisionRoot, [
      v2Profile("same", 1, "primary", "3".repeat(64)),
    ]);
    expect(() =>
      createPawNextProductProfileCatalogV1({
        workspaceRoot: duplicateRevisionRoot,
        v1: {},
        v2: {},
      }),
    ).toThrow("profile revision");

    const legalRoot = workspace();
    writeV1Store(legalRoot, [v1Profile("same", 1, "primary", "4".repeat(64))]);
    writeV2Store(legalRoot, [v2Profile("same", 2, "primary", "5".repeat(64))]);
    expect(() =>
      createPawNextProductProfileCatalogV1({
        workspaceRoot: legalRoot,
        v1: {},
        v2: {},
      }),
    ).not.toThrow();
  });

  test("a missing key fails only the exact hit and never tries another version or environment", () => {
    const root = workspace();
    const identity = taskIdentity(root, "missing-key");
    const v1Seed = v1Profile("missing-key-v1", 1, "missing");
    const v1Hash = preparePawNextProductRuntimeV1(
      buildPawNextTaskOptionsFromProfileV1({
        identity,
        profile: v1Seed,
        apiKey: SECRET_ONE,
      }),
    ).configHash;
    const v2Seed = v2Profile("available-v2", 1, "primary");
    const v2Hash = buildPawNextTaskProfileV2({
      identity,
      profile: v2Seed,
      apiKey: SECRET_TWO,
    }).configHash;
    writeV1Store(root, [{ ...v1Seed, configHash: v1Hash }]);
    writeV2Store(root, [{ ...v2Seed, configHash: v2Hash }]);
    writeSettings(root, { primary: SECRET_TWO });
    const catalog = createPawNextProductProfileCatalogV1({
      workspaceRoot: root,
      v1: {},
      v2: {},
    });

    expect(catalog({ ...identity, configHash: v2Hash })?.productVersion).toBe(
      "v2",
    );
    expect(() => catalog({ ...identity, configHash: v1Hash })).toThrow(
      "credential slot is unavailable",
    );
    expect(
      catalog({ ...identity, configHash: "e".repeat(64) }),
    ).toBeUndefined();
  });

  test("binds named workspace credentials without leaking them and preserves the old V1 resolver", () => {
    const root = workspace();
    const identity = taskIdentity(root, "secret-binding");
    const base = v2Profile("secret-binding", 1);
    const first = buildPawNextTaskProfileV2({
      identity,
      profile: base,
      apiKey: SECRET_ONE,
    });
    const changedKey = buildPawNextTaskProfileV2({
      identity,
      profile: base,
      apiKey: SECRET_TWO,
    });
    const changedSlot = buildPawNextTaskProfileV2({
      identity,
      profile: { ...base, model: { ...base.model, credentialSlot: "other" } },
      apiKey: SECRET_ONE,
    });
    expect(changedKey.configHash).not.toBe(first.configHash);
    expect(changedSlot.configHash).not.toBe(first.configHash);
    for (const candidate of [first, changedKey, changedSlot]) {
      const serialized = JSON.stringify(candidate.manifest);
      expect(serialized).not.toContain(SECRET_ONE);
      expect(serialized).not.toContain(SECRET_TWO);
      expect(candidate.manifest.credentialBindingHash).toMatch(
        /^[a-f0-9]{64}$/,
      );
    }

    const v1Seed = v1Profile("legacy-v1", 1);
    const v1Hash = preparePawNextProductRuntimeV1(
      buildPawNextTaskOptionsFromProfileV1({
        identity,
        profile: v1Seed,
        apiKey: SECRET_ONE,
      }),
    ).configHash;
    writeV1Store(root, [{ ...v1Seed, configHash: v1Hash }]);
    writeSettings(root, { primary: SECRET_ONE });
    const oldResolver = createPawNextProductProfileResolverV1({
      workspaceRoot: root,
    });
    expect(oldResolver({ ...identity, configHash: v1Hash })).toBeDefined();
    expect(fs.existsSync(v2Path(root))).toBeFalse();
  });

  test("reuses the strict workspace reader for V2 profile links", () => {
    const root = workspace();
    writeV2Store(root, [v2Profile("linked-v2", 1)]);
    const linked = path.join(root, ".paw", "linked-v2.json");
    fs.linkSync(v2Path(root), linked);
    expect(() =>
      loadPawNextProductProfileStoreV2({
        workspaceRoot: root,
        profilePath: linked,
      }),
    ).toThrow("single-link regular file");
  });
});

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-profile-v2-"));
  fs.mkdirSync(path.join(root, ".paw"), { recursive: true });
  roots.push(root);
  return root;
}

function taskIdentity(root: string, suffix: string) {
  return {
    workspaceRoot: root,
    sessionId: `session-${suffix}`,
    runId: `run-${suffix}`,
    inputId: `input-${suffix}`,
    goal: `goal-${suffix}`,
  };
}

function v1Profile(
  profileId: string,
  revision: number,
  credentialSlot = "primary",
  configHash = "0".repeat(64),
) {
  return {
    profileId,
    revision,
    configHash,
    model: {
      protocol: "openai-compatible" as const,
      transport: "complete" as const,
      model: "profile-v2-test-model",
      baseUrl: "https://profile.example.invalid/v1",
      capabilities: { contextWindow: 32_000, maxOutputTokens: 4_096 },
      thinkingEnabled: false,
      reasoningEffort: null,
      credentialSlot,
    },
    control: {
      mode: "interactive" as const,
      maxModelTurns: 8,
      naturalStop: "complete" as const,
    },
    systemPrompt: "strict profile system",
    budget: {
      contextWindowTokens: 32_000,
      reservedOutputTokens: 4_096,
      estimationMarginTokens: 256,
      estimator: { id: "core:openai:profile-v2-test-model", version: "v1" },
    },
    permission: {
      policyVersion: "profile-v2-permission.v1",
      defaultAction: "deny" as const,
      rules: [],
    },
    approval: "unavailable" as const,
    heartbeat: {
      policyVersion: "paw.session-lease-heartbeat.v1" as const,
      ttlMs: 90_000,
      intervalMs: 30_000,
    },
    shellSandbox: null,
  };
}

function v2Profile(
  profileId: string,
  revision: number,
  credentialSlot = "primary",
  configHash = "0".repeat(64),
) {
  return {
    ...v1Profile(profileId, revision, credentialSlot, configHash),
    payloadRuntime: payloadRuntime(),
  };
}

function payloadRuntime() {
  return {
    codec: FILE_DURABLE_JSON_PAYLOAD_CODEC_V1,
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

function writeV1Store(root: string, profiles: readonly unknown[]): void {
  writeJson(v1Path(root), {
    schemaVersion: PAW_NEXT_PRODUCT_PROFILE_SCHEMA_VERSION_V1,
    profiles,
  });
}

function writeV2Store(root: string, profiles: readonly unknown[]): void {
  writeJson(v2Path(root), {
    schemaVersion: PAW_NEXT_PRODUCT_PROFILE_SCHEMA_VERSION_V2,
    profiles,
  });
}

function writeSettings(root: string, values: Record<string, string>): void {
  writeJson(settingsPath(root), {
    models: Object.fromEntries(
      Object.entries(values).map(([slot, apiKey]) => [slot, { apiKey }]),
    ),
  });
}

function v1Path(root: string): string {
  return path.join(root, DEFAULT_PAW_NEXT_PRODUCT_PROFILE_FILE_V1);
}

function v2Path(root: string): string {
  return path.join(root, DEFAULT_PAW_NEXT_PRODUCT_PROFILE_FILE_V2);
}

function settingsPath(root: string): string {
  return path.join(root, ".paw", "settings.local.json");
}

function writeJson(target: string, value: unknown): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(value));
}

function without<T extends object>(value: T, key: keyof T): Partial<T> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

function assertDeepFrozen(value: unknown): void {
  if (!value || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBeTrue();
  for (const child of Object.values(value)) assertDeepFrozen(child);
}
