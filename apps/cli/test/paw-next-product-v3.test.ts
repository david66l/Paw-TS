import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import { INTERACTIVE_CONTROL_REDUCER_VERSION_V2 } from "@paw/agent-loop";
import {
  PAW_NEXT_MEMORY_PLUGIN_POLICY_VERSION_V1,
  PAW_NEXT_MEMORY_V2_PROVIDER_VERSION_V1,
} from "@paw/memory-plugin";
import { WORK_SEGMENT_POLICY_VERSION_V1 } from "@paw/protocol";
import {
  CANONICAL_DURABLE_JSON_PAYLOAD_BINDING_VERSION_V1,
  FILE_DURABLE_JSON_PAYLOAD_CODEC_V1,
  FILE_DURABLE_JSON_PAYLOAD_POLICY_VERSION_V1,
  LOCATION_AWARE_PAYLOAD_MATERIALIZER_VERSION_V1,
  LOCATION_AWARE_PAYLOAD_SESSION_VERSION_V1,
  VERIFIED_CANONICAL_PAYLOAD_BUDGET_POLICY_VERSION_V1,
} from "@paw/runtime";

import {
  preparePawNextProductRuntimeIdentityV3,
  preparePawNextProductRuntimeV1,
} from "../src/paw-next/composition.js";
import {
  createPawNextProductManifestV2,
  hashPawNextProductManifestV2,
} from "../src/paw-next/product-manifest-v2.js";
import {
  PAW_NEXT_PRODUCT_COMPOSITION_VERSION_V3,
  PAW_NEXT_PRODUCT_MANIFEST_SCHEMA_VERSION_V3,
  createPawNextProductManifestV3,
  hashPawNextProductManifestV3,
} from "../src/paw-next/product-manifest-v3.js";
import {
  createPawNextProductManifestV1,
  hashPawNextProductManifestV1,
} from "../src/paw-next/product-manifest.js";
import { createPawNextProductProfileCatalogV3 } from "../src/paw-next/product-profile-catalog-v3.js";
import {
  DEFAULT_PAW_NEXT_PRODUCT_PROFILE_FILE_V2,
  PAW_NEXT_PRODUCT_PROFILE_SCHEMA_VERSION_V2,
  buildPawNextTaskProfileV2,
} from "../src/paw-next/product-profile-v2.js";
import {
  DEFAULT_PAW_NEXT_PRODUCT_PROFILE_FILE_V3,
  PAW_NEXT_PRODUCT_PROFILE_SCHEMA_VERSION_V3,
  buildPawNextTaskProfileV3,
  loadPawNextProductProfileStoreV3,
} from "../src/paw-next/product-profile-v3.js";
import {
  DEFAULT_PAW_NEXT_PRODUCT_PROFILE_FILE_V1,
  PAW_NEXT_PRODUCT_PROFILE_SCHEMA_VERSION_V1,
  buildPawNextTaskOptionsFromProfileV1,
} from "../src/paw-next/product-profile.js";

const SECRET = "sk-v3-product-secret";
const V1_HASH =
  "a86c8e1f54d3ccf6710066128e73f2c843495ba6d874afb84c5a5b9c77a00e66";
const V2_HASH =
  "b74ee24d0df7bc7409c2c3aa482ea4645a05f3d2192cfec2f92f02b4a1f7f935";
const V3_HASH =
  "7cb0747e3965022e40ce1387e4295e4d9501b0d708f85810aabbaec94018f39d";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("Paw Next V3 product manifest identity", () => {
  test("keeps V1/V2 known hashes while V3 has one literal exact identity", () => {
    const v1 = createPawNextProductManifestV1(commonInputV1());
    const v2 = createPawNextProductManifestV2({
      ...commonInputV1(),
      payloadRuntime: payloadRuntime(),
    });
    const v3 = createPawNextProductManifestV3(manifestInputV3());
    const expected = expectedManifestV3();

    expect(hashPawNextProductManifestV1(v1)).toBe(V1_HASH);
    expect(hashPawNextProductManifestV2(v2)).toBe(V2_HASH);
    expect(v3 as unknown).toEqual(expected);
    expect(Object.keys(v3)).toEqual([
      "schemaVersion",
      "compositionVersion",
      "reducerVersion",
      "workSegmentPolicyVersion",
      "runConfig",
      "contextCompaction",
      "completionReview",
      "progressAdvisor",
      "collaboration",
      "modelOutputRecovery",
      "payloadRuntime",
      "toolEffectCheckpointPolicyVersion",
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
    expect(v3.schemaVersion).toBe(PAW_NEXT_PRODUCT_MANIFEST_SCHEMA_VERSION_V3);
    expect(v3.compositionVersion).toBe(PAW_NEXT_PRODUCT_COMPOSITION_VERSION_V3);
    expect(v3.reducerVersion).toBe(INTERACTIVE_CONTROL_REDUCER_VERSION_V2);
    expect(v3.workSegmentPolicyVersion).toBe(WORK_SEGMENT_POLICY_VERSION_V1);
    expect(independentSha256(canonicalJson(expected))).toBe(V3_HASH);
    expect(hashPawNextProductManifestV3(v3)).toBe(V3_HASH);
    expect(JSON.stringify(v3)).not.toContain(SECRET);
    assertDeepFrozen(v3);
  });

  test("strictly rejects incomplete payload identity and invalid V3 segment control", () => {
    const validPayload = payloadRuntime();
    const invalidPayloads = [
      without(validPayload, "codec"),
      without(validPayload, "storePolicy"),
      without(validPayload, "readBudget"),
      without(validPayload, "locationBindingVersion"),
      without(validPayload, "locationAwareSessionVersion"),
      without(validPayload, "materializerVersion"),
      { ...validPayload, extra: true },
      { ...validPayload, codec: { ...validPayload.codec, version: "v2" } },
      { ...validPayload, locationBindingVersion: "binding.v2" },
      { ...validPayload, locationAwareSessionVersion: "session.v2" },
      { ...validPayload, materializerVersion: "materializer.v2" },
    ];
    for (const payloadRuntime of invalidPayloads) {
      expect(() =>
        createPawNextProductManifestV3({
          ...manifestInputV3(),
          payloadRuntime: payloadRuntime as never,
        }),
      ).toThrow();
    }

    const controls: unknown[] = [
      null,
      {},
      { ...runConfig(), extra: true },
      { ...runConfig(), mode: "benchmark" },
      { ...runConfig(), maxModelTurns: 0 },
      { ...runConfig(), maxSegments: 0 },
      { ...runConfig(), maxTotalModelTurns: 7 },
      { ...runConfig(), maxTotalModelTurns: Number.MAX_SAFE_INTEGER + 1 },
      { ...runConfig(), softModelTurns: 4 },
      {
        ...runConfig(),
        softModelTurns: 8,
        renewalModelTurns: 2,
        softNoProgressTurns: 2,
      },
    ];
    for (const runConfig of controls) {
      expect(() =>
        createPawNextProductManifestV3({
          ...manifestInputV3(),
          runConfig: runConfig as never,
        }),
      ).toThrow();
    }
    expect(() =>
      createPawNextProductManifestV3({
        ...manifestInputV3(),
        workSegmentPolicyVersion: "paw.work-segment.v2" as never,
      }),
    ).toThrow();
  });

  test("changes hash for every legal mutable V3 control or file-policy limit", () => {
    const baseline = hashPawNextProductManifestV3(
      createPawNextProductManifestV3(manifestInputV3()),
    );
    const variants = [
      { runConfig: { ...runConfig(), maxModelTurns: 9 } },
      { runConfig: { ...runConfig(), maxSegments: 5 } },
      { runConfig: { ...runConfig(), maxTotalModelTurns: 25 } },
      { runConfig: { ...runConfig(), naturalStop: "await_user" as const } },
      {
        runConfig: {
          ...runConfig(),
          softModelTurns: 4,
          renewalModelTurns: 2,
          softNoProgressTurns: 2,
        },
      },
      {
        payloadRuntime: {
          ...payloadRuntime(),
          storePolicy: {
            ...payloadRuntime().storePolicy,
            maxArtifactBytes: 8 * 1024 * 1024,
          },
        },
      },
      {
        payloadRuntime: {
          ...payloadRuntime(),
          readBudget: {
            ...payloadRuntime().readBudget,
            maxTotalBytes: 64 * 1024 * 1024,
          },
        },
      },
    ];
    for (const variant of variants) {
      const changed = createPawNextProductManifestV3({
        ...manifestInputV3(),
        ...variant,
      });
      expect(hashPawNextProductManifestV3(changed)).not.toBe(baseline);
    }
  });

  test("binds the optional root memory plugin without exposing raw scope ids", () => {
    const memory = {
      policyVersion: PAW_NEXT_MEMORY_PLUGIN_POLICY_VERSION_V1,
      mode: "read_only" as const,
      providerVersion: PAW_NEXT_MEMORY_V2_PROVIDER_VERSION_V1,
      scope: {
        tenantId: "tenant-secret",
        userId: "user-secret",
        workspaceId: "workspace-secret",
        repositoryId: "repo-public-id",
      },
      maxCards: 3,
      maxInjectedTokens: 512,
    };
    const baseline = createPawNextProductManifestV3(manifestInputV3());
    const enabled = createPawNextProductManifestV3({
      ...manifestInputV3(),
      memory,
    });

    expect(enabled.memory).toMatchObject({
      mode: "read_only",
      providerVersion: PAW_NEXT_MEMORY_V2_PROVIDER_VERSION_V1,
      authority: "untrusted_evidence_only",
      writePolicy: "disabled",
    });
    expect(hashPawNextProductManifestV3(enabled)).not.toBe(
      hashPawNextProductManifestV3(baseline),
    );
    expect(JSON.stringify(enabled)).not.toContain("tenant-secret");
    expect(JSON.stringify(enabled)).not.toContain("user-secret");
    expect(enabled.memory?.scopeFingerprint).toHaveLength(20);
    assertDeepFrozen(enabled);
  });

  test("freezes the opt-in two-phase memory writer into product identity", () => {
    const enabled = createPawNextProductManifestV3({
      ...manifestInputV3(),
      memory: {
        policyVersion: PAW_NEXT_MEMORY_PLUGIN_POLICY_VERSION_V1,
        mode: "read_write",
        providerVersion: PAW_NEXT_MEMORY_V2_PROVIDER_VERSION_V1,
        scope: {
          tenantId: "tenant-secret",
          userId: "user-secret",
          workspaceId: "workspace-secret",
          repositoryId: "repo-id",
        },
        maxCards: 3,
        maxInjectedTokens: 512,
        writer: {
          policyVersion: "paw.memory-writer.v1",
          extractorVersion: "paw.memory-atom-extractor.json.v1",
          maxAtoms: 8,
          maxSourceChars: 24_000,
          topicOrganizer: {
            policyVersion: "paw.memory-topic-organization.v1",
            extractorVersion: "paw.memory-topic-extractor.json.v1",
            maxTopics: 8,
          },
          personaProjector: {
            policyVersion: "paw.memory-persona-evidence-projector.v1",
            maxClaims: 8,
            maxChars: 2_048,
            minimumConfidence: 0.7,
          },
          rawEvidenceResolver: {
            policyVersion: "paw.memory-raw-evidence-resolver.v1",
            maxSpans: 6,
            maxChars: 6_000,
          },
          coveragePlanner: {
            policyVersion: "paw.memory-evidence-coverage-planner.v1",
            extractorVersion: "paw.memory-evidence-requirement-planner.json.v1",
            maxRequirements: 4,
            maxExpansionTopics: 3,
            maxSupplementalStates: 8,
            maxSupplementalChars: 4_096,
          },
          evidencePlanner: {
            policyVersion: "paw.memory-topic-evidence-planner.v1",
            maxIndexTopics: 96,
            maxSelectedTopics: 3,
            maxStates: 16,
            maxEvidenceChars: 8_000,
          },
        },
      },
    });
    expect(enabled.memory).toMatchObject({
      mode: "read_write",
      writePolicy: "journal_two_phase",
      writer: {
        policyVersion: "paw.memory-writer.v1",
        extractorVersion: "paw.memory-atom-extractor.json.v1",
        maxAtoms: 8,
        maxSourceChars: 24_000,
        topicOrganizer: {
          policyVersion: "paw.memory-topic-organization.v1",
          extractorVersion: "paw.memory-topic-extractor.json.v1",
          maxTopics: 8,
        },
        personaProjector: {
          policyVersion: "paw.memory-persona-evidence-projector.v1",
          maxClaims: 8,
          maxChars: 2_048,
          minimumConfidence: 0.7,
        },
        rawEvidenceResolver: {
          policyVersion: "paw.memory-raw-evidence-resolver.v1",
          maxSpans: 6,
          maxChars: 6_000,
        },
        coveragePlanner: {
          policyVersion: "paw.memory-evidence-coverage-planner.v1",
          extractorVersion: "paw.memory-evidence-requirement-planner.json.v1",
          maxRequirements: 4,
          maxExpansionTopics: 3,
          maxSupplementalStates: 8,
          maxSupplementalChars: 4_096,
        },
        evidencePlanner: {
          policyVersion: "paw.memory-topic-evidence-planner.v1",
          maxIndexTopics: 96,
          maxSelectedTopics: 3,
          maxStates: 16,
          maxEvidenceChars: 8_000,
        },
      },
    });
    expect(JSON.stringify(enabled)).not.toContain("tenant-secret");
    expect(JSON.stringify(enabled)).not.toContain("user-secret");
    assertDeepFrozen(enabled);
  });

  test("detaches nested inputs and strips hostile identity or secret extras", () => {
    const input = {
      ...manifestInputV3(),
      schemaVersion: "hostile.schema",
      compositionVersion: "hostile.composition",
      reducerVersion: "hostile.reducer",
      apiKey: SECRET,
      extra: { secret: SECRET },
    };
    const manifest = createPawNextProductManifestV3(input);
    const originalHash = hashPawNextProductManifestV3(manifest);
    input.runConfig.maxSegments = 99;
    input.payloadRuntime.storePolicy.maxArtifactBytes = 1;
    input.permissionPolicy.rules.push({ id: "caller-mutation" });

    expect(hashPawNextProductManifestV3(manifest)).toBe(originalHash);
    expect(manifest as unknown).toEqual(expectedManifestV3());
    expect(JSON.stringify(manifest)).not.toContain(SECRET);
    expect("apiKey" in manifest).toBeFalse();
    expect("extra" in manifest).toBeFalse();
    assertDeepFrozen(manifest);
  });
});

describe("Paw Next V3 profile and aggregate catalog", () => {
  test("strictly loads, freezes, and detaches the complete V3 profile", () => {
    const root = workspace();
    const source = profileV3("strict-v3", 1);
    writeV3Store(root, [source]);
    const loaded = loadPawNextProductProfileStoreV3({ workspaceRoot: root });

    expect(loaded.schemaVersion).toBe(
      PAW_NEXT_PRODUCT_PROFILE_SCHEMA_VERSION_V3,
    );
    expect(loaded.profiles[0]).toEqual(source);
    assertDeepFrozen(loaded);
    source.control.maxSegments = 99;
    source.payloadRuntime.storePolicy.maxArtifactBytes = 1;
    expect(loaded.profiles[0]?.control.maxSegments).toBe(4);
    expect(
      loaded.profiles[0]?.payloadRuntime.storePolicy.maxArtifactBytes,
    ).toBe(16 * 1024 * 1024);

    const valid = profileV3("invalid-v3", 2);
    const invalid: unknown[] = [
      without(valid, "payloadRuntime"),
      without(valid, "workSegmentPolicyVersion"),
      { ...valid, extra: true },
      { ...valid, control: without(valid.control, "maxSegments") },
      { ...valid, control: { ...valid.control, extra: true } },
      { ...valid, control: { ...valid.control, maxSegments: 0 } },
      { ...valid, control: { ...valid.control, maxTotalModelTurns: 7 } },
      { ...valid, workSegmentPolicyVersion: "paw.work-segment.v2" },
      {
        ...valid,
        payloadRuntime: {
          ...valid.payloadRuntime,
          materializerVersion: "materializer.v2",
        },
      },
    ];
    for (const profile of invalid) {
      writeV3Store(root, [profile]);
      expect(() =>
        loadPawNextProductProfileStoreV3({ workspaceRoot: root }),
      ).toThrow();
    }
  });

  test("builds V3 common identity from the existing product authority", () => {
    const root = workspace();
    const identity = taskIdentity(root, "authority");
    const v3Profile = profileV3("authority", 1);
    const v1Profile = profileV1("authority", 1);
    const v1Options = buildPawNextTaskOptionsFromProfileV1({
      identity,
      profile: v1Profile,
      apiKey: SECRET,
    });
    const v1Manifest = preparePawNextProductRuntimeV1(v1Options).manifest;
    const v3Identity = preparePawNextProductRuntimeIdentityV3(v1Options);
    const v3IdentityManifest = v3Identity.manifest;
    const built = buildPawNextTaskProfileV3({
      identity,
      profile: v3Profile,
      apiKey: SECRET,
    });

    expect(built.productVersion).toBe("v3");
    expect(built.taskOptions.productVersion).toBe("v3");
    expect(built.configHash).toBe(hashPawNextProductManifestV3(built.manifest));
    expect(built.manifest).toMatchObject({
      registryHash: v3IdentityManifest.registryHash,
      shellSandboxHash: v1Manifest.shellSandboxHash,
      systemPromptHash: v1Manifest.systemPromptHash,
      toolEffectCheckpointPolicyVersion:
        v1Manifest.toolEffectCheckpointPolicyVersion,
      permissionPolicy: v1Manifest.permissionPolicy,
      model: v1Manifest.model,
      modelCapabilities: v1Manifest.modelCapabilities,
    });
    expect(built.manifest.registryHash).not.toBe(v1Manifest.registryHash);
    expect(v3Identity.registry.plugins).toEqual([
      {
        pluginId: "paw.code-intelligence",
        pluginVersion: "paw.code-intelligence.v1",
      },
      {
        pluginId: "paw.collaboration",
        pluginVersion:
          "paw.collaboration.v1.8:boundaries:mission-budget:soft-renewal16:n8:c3:m8:d24:s96:t240:g4000:r6000",
      },
      {
        pluginId: "paw.mcp-proxy",
        pluginVersion:
          "paw.mcp-proxy.v1.74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b",
      },
      {
        pluginId: "paw.output-recall",
        pluginVersion:
          "paw.output-recall.v2:t12000:h3000:l2000:dt3000:dh1000:dl500:c8000:u32000:r256000",
      },
      {
        pluginId: "paw.task-progress",
        pluginVersion: "paw.task-progress.v1:i100:d100:c500",
      },
      {
        pluginId: "paw.web-access",
        pluginVersion:
          "paw.web-access.v1:bing-html-v1:d50000:c100000:b2097152:t15000:r5:s10:q500",
      },
      {
        pluginId: "paw.workspace-inspection",
        pluginVersion: "paw.workspace-inspection.v2",
      },
      {
        pluginId: "paw.workspace-mutation",
        pluginVersion: "paw.workspace-mutation.v1",
      },
    ]);
    expect(
      v3Identity.registry.definitions.map((item) => item.function.name),
    ).toEqual(
      expect.arrayContaining([
        "workspace_progress_read",
        "workspace_todo_write",
        "workspace_web_fetch",
        "workspace_web_search",
      ]),
    );
    expect(JSON.stringify(built.manifest)).not.toContain(SECRET);
    assertDeepFrozen(built);
  });

  test("freezes MCP scope into registry identity without exposing server secrets", () => {
    const root = workspace();
    const identity = taskIdentity(root, "mcp-scope");
    const linearServer = {
      name: "linear",
      command: "linear-mcp-secret-command",
      args: ["--stdio", "--tenant", "example"],
      env: { Z_TOKEN: "server-secret", A_MODE: "test" },
    };
    const githubServer = {
      name: "github",
      command: "github-mcp",
      args: ["--stdio"],
    };
    const mcp = {
      policyVersion: "paw.mcp-runtime.v1" as const,
      servers: [linearServer, githubServer],
      allowedTools: ["mcp:linear/create_issue", "mcp:github/search_code"],
    };
    const reorderedMcp = {
      ...mcp,
      servers: [
        githubServer,
        {
          ...linearServer,
          env: { A_MODE: "test", Z_TOKEN: "server-secret" },
        },
      ],
      allowedTools: [...mcp.allowedTools].reverse(),
    };
    const first = buildPawNextTaskProfileV3({
      identity,
      profile: { ...profileV3("mcp-scope", 1), mcp },
      apiKey: SECRET,
    });
    const reordered = buildPawNextTaskProfileV3({
      identity,
      profile: { ...profileV3("mcp-scope", 1), mcp: reorderedMcp },
      apiKey: SECRET,
    });
    const changedEnv = buildPawNextTaskProfileV3({
      identity,
      profile: {
        ...profileV3("mcp-scope", 1),
        mcp: {
          ...mcp,
          servers: [
            { ...linearServer, env: { Z_TOKEN: "changed-secret" } },
            githubServer,
          ],
        },
      },
      apiKey: SECRET,
    });
    const changedAllowlist = buildPawNextTaskProfileV3({
      identity,
      profile: {
        ...profileV3("mcp-scope", 1),
        mcp: { ...mcp, allowedTools: ["mcp:github/search_code"] },
      },
      apiKey: SECRET,
    });

    expect(reordered.configHash).toBe(first.configHash);
    expect(changedEnv.configHash).not.toBe(first.configHash);
    expect(changedAllowlist.configHash).not.toBe(first.configHash);
    expect(first.taskOptions.mcp?.servers.map((server) => server.name)).toEqual(
      ["github", "linear"],
    );
    expect(first.taskOptions.mcp?.allowedTools).toEqual([
      "mcp:github/search_code",
      "mcp:linear/create_issue",
    ]);
    const manifestText = JSON.stringify(first.manifest);
    expect(manifestText).not.toContain("server-secret");
    expect(manifestText).not.toContain("linear-mcp-secret-command");

    const firstRuntime = preparePawNextProductRuntimeIdentityV3(
      first.taskOptions,
    );
    const changedRuntime = preparePawNextProductRuntimeIdentityV3(
      changedAllowlist.taskOptions,
    );
    expect(firstRuntime.registry.definitions).toEqual(
      changedRuntime.registry.definitions,
    );
    expect(firstRuntime.registry.registryHash).not.toBe(
      changedRuntime.registry.registryHash,
    );
    expect(
      firstRuntime.registry.resolveProviderName("workspace_use_mcp")
        ?.internalName,
    ).toBe("workspace.use_mcp");
    assertDeepFrozen(first);
  });

  test("strictly rejects malformed MCP profiles and unknown exact targets", () => {
    const root = workspace();
    const identity = taskIdentity(root, "mcp-invalid");
    const base = profileV3("mcp-invalid", 1);
    const invalidMcp: unknown[] = [
      {
        policyVersion: "paw.mcp-runtime.v2",
        servers: [],
        allowedTools: [],
      },
      {
        policyVersion: "paw.mcp-runtime.v1",
        servers: [
          { name: "github", command: "mcp", args: [] },
          { name: "github", command: "mcp", args: [] },
        ],
        allowedTools: [],
      },
      {
        policyVersion: "paw.mcp-runtime.v1",
        servers: [{ name: "github", command: "mcp", args: [] }],
        allowedTools: ["mcp:linear/create_issue"],
      },
      {
        policyVersion: "paw.mcp-runtime.v1",
        servers: [
          { name: "github", command: "mcp", args: [], env: { TOKEN: 42 } },
        ],
        allowedTools: [],
      },
      {
        policyVersion: "paw.mcp-runtime.v1",
        servers: [{ name: "github", command: "mcp", args: [], extra: true }],
        allowedTools: [],
      },
    ];
    for (const mcp of invalidMcp) {
      expect(() =>
        buildPawNextTaskProfileV3({
          identity,
          profile: { ...base, mcp } as never,
          apiKey: SECRET,
        }),
      ).toThrow();
    }
  });

  test("resolves exact V1/V2/V3 hashes without fallback", () => {
    const root = workspace();
    const identity = taskIdentity(root, "catalog");
    const seedV1 = profileV1("catalog-v1", 1);
    const hashV1 = preparePawNextProductRuntimeV1(
      buildPawNextTaskOptionsFromProfileV1({
        identity,
        profile: seedV1,
        apiKey: SECRET,
      }),
    ).configHash;
    const seedV2 = profileV2("catalog-v2", 1);
    const hashV2 = buildPawNextTaskProfileV2({
      identity,
      profile: seedV2,
      apiKey: SECRET,
    }).configHash;
    const seedV3 = profileV3("catalog-v3", 1);
    const hashV3 = buildPawNextTaskProfileV3({
      identity,
      profile: seedV3,
      apiKey: SECRET,
    }).configHash;
    writeV1Store(root, [{ ...seedV1, configHash: hashV1 }]);
    writeV2Store(root, [{ ...seedV2, configHash: hashV2 }]);
    writeV3Store(root, [{ ...seedV3, configHash: hashV3 }]);
    writeSettings(root, { primary: SECRET });
    const catalog = createPawNextProductProfileCatalogV3({
      workspaceRoot: root,
      v1: {},
      v2: {},
      v3: {},
    });

    expect(catalog({ ...identity, configHash: hashV1 })?.productVersion).toBe(
      "v1",
    );
    expect(catalog({ ...identity, configHash: hashV2 })?.productVersion).toBe(
      "v2",
    );
    expect(catalog({ ...identity, configHash: hashV3 })?.productVersion).toBe(
      "v3",
    );
    expect(
      catalog({ ...identity, configHash: "f".repeat(64) }),
    ).toBeUndefined();
  });

  test("rejects cross-version hash and revision ambiguity", () => {
    const duplicateHashRoot = workspace();
    writeV1Store(duplicateHashRoot, [profileV1("hash-v1", 1, "1".repeat(64))]);
    writeV2Store(duplicateHashRoot, [profileV2("hash-v2", 1, "1".repeat(64))]);
    writeV3Store(duplicateHashRoot, [profileV3("hash-v3", 1, "3".repeat(64))]);
    expect(() =>
      createPawNextProductProfileCatalogV3({
        workspaceRoot: duplicateHashRoot,
        v1: {},
        v2: {},
        v3: {},
      }),
    ).toThrow(/configHash/i);

    const duplicateRevisionRoot = workspace();
    writeV1Store(duplicateRevisionRoot, [
      profileV1("same-profile", 1, "1".repeat(64)),
    ]);
    writeV2Store(duplicateRevisionRoot, [
      profileV2("other-profile", 2, "2".repeat(64)),
    ]);
    writeV3Store(duplicateRevisionRoot, [
      profileV3("same-profile", 1, "3".repeat(64)),
    ]);
    expect(() =>
      createPawNextProductProfileCatalogV3({
        workspaceRoot: duplicateRevisionRoot,
        v1: {},
        v2: {},
        v3: {},
      }),
    ).toThrow(/profile revision/i);
  });

  test("an exact V3 hit with a missing credential never tries V1/V2", () => {
    const root = workspace();
    const identity = taskIdentity(root, "no-fallback");
    const missing = profileV3("missing-v3", 1);
    const missingHash = buildPawNextTaskProfileV3({
      identity,
      profile: missing,
      apiKey: SECRET,
    }).configHash;
    writeV1Store(root, [profileV1("available-v1", 1, "1".repeat(64))]);
    writeV2Store(root, [profileV2("available-v2", 1, "2".repeat(64))]);
    writeV3Store(root, [
      {
        ...missing,
        configHash: missingHash,
        model: { ...missing.model, credentialSlot: "missing" },
      },
    ]);
    writeSettings(root, { primary: SECRET });
    const catalog = createPawNextProductProfileCatalogV3({
      workspaceRoot: root,
      v1: {},
      v2: {},
      v3: {},
    });

    expect(() => catalog({ ...identity, configHash: missingHash })).toThrow(
      /credential slot is unavailable/i,
    );
  });
});

function commonInputV1() {
  return {
    toolEffectCheckpointPolicyVersion: "paw.tool-effect-checkpoint.v1",
    reducerVersion: "paw.interactive-control-reducer.v1",
    runConfig: {
      mode: "interactive" as const,
      maxModelTurns: 12,
      naturalStop: "complete" as const,
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

function manifestInputV3() {
  const {
    reducerVersion: _reducerVersion,
    runConfig: _runConfig,
    ...common
  } = commonInputV1();
  return {
    ...common,
    runConfig: runConfig(),
    workSegmentPolicyVersion: WORK_SEGMENT_POLICY_VERSION_V1,
    payloadRuntime: payloadRuntime(),
  };
}

function expectedManifestV3() {
  const {
    reducerVersion: _reducerVersion,
    runConfig: _runConfig,
    ...common
  } = commonInputV1();
  return {
    schemaVersion: "paw.product-manifest.v3",
    compositionVersion: "paw.product-composition.v3.19",
    reducerVersion: "paw.interactive-control.v2",
    workSegmentPolicyVersion: "paw.work-segment.v1",
    runConfig: runConfig(),
    contextCompaction: {
      plannerPolicyVersion: "paw.context-compaction.v1:r8000:n2:t4",
      lifecyclePolicyVersion:
        "paw.context-compaction-lifecycle.v1:s2000:x9500:c5:f3:l2:g12000",
      orchestrationPolicyVersion: "paw.context-compaction-orchestrator.v1",
      evidencePolicyVersion: "paw.checkpoint-evidence.v1:t12000:p256",
      distillerPolicyVersion:
        "paw.checkpoint-distiller.v1:p256000:o4096:t45000:vrequired",
      semanticVerifierPolicyVersion:
        "paw.checkpoint-semantic-verifier.v1:p192000:o512:t30000",
    },
    completionReview: {
      journalPolicyVersion: "paw.completion-review.v1",
      triggerPolicyVersion:
        "paw.completion-review-trigger.v2:verification-evidence-short-circuit",
      evidencePacketPolicyVersion: "paw.completion-review-evidence-packet.v1",
      gatePolicyVersion: "paw.completion-review-gate.v3",
      reviewerPolicyVersion:
        "paw.completion-reviewer.v2:p96000:o4096:r1:t30000",
      continuationPolicyVersion: "paw.completion-review-continuation.v2",
      maxBlocksPerRun: 2,
    },
    progressAdvisor: {
      policyVersion:
        "paw.progress-advisor.v5:r3-5-8:n4-8-16:g16-18:e8:verified-pass:main-owned-replan:journal-anchor",
      mode: "journal_timeline_anchored_advice_only",
    },
    collaboration: {
      policyVersion:
        "paw.collaboration.v1.8:boundaries:mission-budget:soft-renewal16:n8:c3:m8:d24:s96:t240:g4000:r6000",
      coordinatorPolicyVersion:
        "paw.collaboration-coordinator.v1:runtime-activity:stable-call-id",
      delegationSchemaVersion:
        "paw.collaboration-delegation.v3:explicit-agent:soft-renewal",
      rosterVersion: "paw.collaboration-roster.v4:effect-profiles",
      childRuntimePolicyVersion:
        "paw.collaboration-child-runtime.v3:effect-profile-tools",
      mode: "adaptive_durable_paw_next_v3_orchestration",
      dispatchInterface: "explicit_agent_delegate",
      missionScheduling: "dependency_graph_single_downgrade",
      childPolicy: "agent_effect_profile_enforced",
      childJournal: "independent_file_session",
      rosterSource: "defaults_plus_workspace_agent_registry",
      writeConflictPolicy: "mission_mutator_serialization_plus_v3_global_lock",
      maxConcurrentChildren: 3,
      maxChildDepth: 1,
    },
    modelOutputRecovery: {
      policyVersion: "paw.model-output-recovery.v1:d32000:l64000:h128000:c3",
      defaultMaxOutputTokens: 32000,
      lowerTierMaxOutputTokens: 64000,
      upperTierMaxOutputTokens: 128000,
      maxContinuations: 3,
    },
    payloadRuntime: payloadRuntime(),
    ...common,
  };
}

function runConfig() {
  return {
    mode: "interactive" as const,
    maxModelTurns: 8,
    naturalStop: "complete" as const,
    maxSegments: 4,
    maxTotalModelTurns: 24,
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

function profileV1(
  profileId: string,
  revision: number,
  configHash = "0".repeat(64),
) {
  return {
    profileId,
    revision,
    configHash,
    model: {
      protocol: "openai-compatible" as const,
      transport: "complete" as const,
      model: "profile-v3-test-model",
      baseUrl: "https://profile.example.invalid/v1",
      capabilities: { contextWindow: 32_000, maxOutputTokens: 4_096 },
      thinkingEnabled: false,
      reasoningEffort: null,
      credentialSlot: "primary",
    },
    control: {
      mode: "interactive" as const,
      maxModelTurns: 8,
      naturalStop: "complete" as const,
    },
    systemPrompt: "strict V3 profile system",
    budget: {
      contextWindowTokens: 32_000,
      reservedOutputTokens: 4_096,
      estimationMarginTokens: 256,
      estimator: { id: "core:openai:profile-v3-test-model", version: "v1" },
    },
    permission: {
      policyVersion: "profile-v3-permission.v1",
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

function profileV2(
  profileId: string,
  revision: number,
  configHash = "0".repeat(64),
) {
  return {
    ...profileV1(profileId, revision, configHash),
    payloadRuntime: payloadRuntime(),
  };
}

function profileV3(
  profileId: string,
  revision: number,
  configHash = "0".repeat(64),
) {
  return {
    ...profileV1(profileId, revision, configHash),
    control: runConfig(),
    workSegmentPolicyVersion: WORK_SEGMENT_POLICY_VERSION_V1,
    payloadRuntime: payloadRuntime(),
  };
}

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-product-v3-"));
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

function writeV1Store(root: string, profiles: readonly unknown[]): void {
  writeJson(path.join(root, DEFAULT_PAW_NEXT_PRODUCT_PROFILE_FILE_V1), {
    schemaVersion: PAW_NEXT_PRODUCT_PROFILE_SCHEMA_VERSION_V1,
    profiles,
  });
}

function writeV2Store(root: string, profiles: readonly unknown[]): void {
  writeJson(path.join(root, DEFAULT_PAW_NEXT_PRODUCT_PROFILE_FILE_V2), {
    schemaVersion: PAW_NEXT_PRODUCT_PROFILE_SCHEMA_VERSION_V2,
    profiles,
  });
}

function writeV3Store(root: string, profiles: readonly unknown[]): void {
  writeJson(path.join(root, DEFAULT_PAW_NEXT_PRODUCT_PROFILE_FILE_V3), {
    schemaVersion: PAW_NEXT_PRODUCT_PROFILE_SCHEMA_VERSION_V3,
    profiles,
  });
}

function writeSettings(root: string, values: Record<string, string>): void {
  writeJson(path.join(root, ".paw", "settings.local.json"), {
    models: Object.fromEntries(
      Object.entries(values).map(([slot, apiKey]) => [slot, { apiKey }]),
    ),
  });
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
  for (const child of Object.values(value)) assertDeepFrozen(child);
}
