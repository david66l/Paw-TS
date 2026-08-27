import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import {
  CANONICAL_DURABLE_JSON_PAYLOAD_BINDING_VERSION_V1,
  EMPTY_RUN_JOURNAL_PREFIX_HASH_V1,
  FILE_DURABLE_JSON_PAYLOAD_CODEC_V1,
  FILE_DURABLE_JSON_PAYLOAD_POLICY_VERSION_V1,
  LOCATION_AWARE_PAYLOAD_MATERIALIZER_VERSION_V1,
  LOCATION_AWARE_PAYLOAD_SESSION_VERSION_V1,
  VERIFIED_CANONICAL_PAYLOAD_BUDGET_POLICY_VERSION_V1,
  acquireFileSessionExecutionLeaseV1,
  createFileDurableJsonPayloadReaderV1,
  createFileDurableJsonPayloadWriterV1,
  freezeFileDurableJsonPayloadPolicyV1,
  freezeFileDurableJsonPayloadRuntimePolicyV1,
} from "@paw/runtime";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("file durable JSON payload runtime policy", () => {
  test("freezes the exact public codec, binding, Session, and materializer versions", () => {
    expect(FILE_DURABLE_JSON_PAYLOAD_CODEC_V1).toEqual({
      id: "paw.file-durable-json",
      version: "v1",
    });
    expect(CANONICAL_DURABLE_JSON_PAYLOAD_BINDING_VERSION_V1).toBe(
      "paw.canonical-durable-json-payload-binding.v1",
    );
    expect(LOCATION_AWARE_PAYLOAD_SESSION_VERSION_V1).toBe(
      "paw.location-aware-payload-session.v1",
    );
    expect(LOCATION_AWARE_PAYLOAD_MATERIALIZER_VERSION_V1).toBe(
      "paw.location-aware-payload-materializer.v1",
    );
    expect(Object.isFrozen(FILE_DURABLE_JSON_PAYLOAD_CODEC_V1)).toBeTrue();
  });

  test("strictly freezes and detaches the standalone file store policy", () => {
    const caller = {
      policyVersion: FILE_DURABLE_JSON_PAYLOAD_POLICY_VERSION_V1,
      maxArtifactBytes: 256 * 1024 * 1024,
    };
    const frozen = freezeFileDurableJsonPayloadPolicyV1(caller);
    caller.maxArtifactBytes = 1;

    expect(frozen).toEqual({
      policyVersion: FILE_DURABLE_JSON_PAYLOAD_POLICY_VERSION_V1,
      maxArtifactBytes: 256 * 1024 * 1024,
    });
    expect(frozen).not.toBe(caller);
    expect(Object.isFrozen(frozen)).toBeTrue();

    for (const invalid of [
      null,
      [],
      {},
      {
        policyVersion: FILE_DURABLE_JSON_PAYLOAD_POLICY_VERSION_V1,
        maxArtifactBytes: 1,
        extra: true,
      },
      { maxArtifactBytes: 1 },
      {
        policyVersion: "paw.file-durable-json-payload-policy.v2",
        maxArtifactBytes: 1,
      },
      {
        policyVersion: FILE_DURABLE_JSON_PAYLOAD_POLICY_VERSION_V1,
        maxArtifactBytes: 0,
      },
      {
        policyVersion: FILE_DURABLE_JSON_PAYLOAD_POLICY_VERSION_V1,
        maxArtifactBytes: Number.MAX_SAFE_INTEGER + 1,
      },
      {
        policyVersion: FILE_DURABLE_JSON_PAYLOAD_POLICY_VERSION_V1,
        maxArtifactBytes: 256 * 1024 * 1024 + 1,
      },
    ]) {
      expect(() =>
        freezeFileDurableJsonPayloadPolicyV1(invalid as never),
      ).toThrow("policy is invalid");
    }
  });

  test("deep-freezes the exact aggregate policy while allowing store artifacts above the read total", () => {
    const caller = runtimePolicy({
      maxArtifactBytes: 32 * 1024 * 1024,
      maxTotalBytes: 1024,
    });
    const frozen = freezeFileDurableJsonPayloadRuntimePolicyV1(caller as never);

    expect(frozen as unknown).toEqual(caller);
    expect(frozen).not.toBe(caller);
    expect(frozen.codec).not.toBe(caller.codec);
    expect(frozen.storePolicy).not.toBe(caller.storePolicy);
    expect(frozen.readBudget).not.toBe(caller.readBudget);
    expect(Object.isFrozen(frozen)).toBeTrue();
    expect(Object.isFrozen(frozen.codec)).toBeTrue();
    expect(Object.isFrozen(frozen.storePolicy)).toBeTrue();
    expect(Object.isFrozen(frozen.readBudget)).toBeTrue();
    expect(frozen.locationAwareSessionVersion).toBe(
      LOCATION_AWARE_PAYLOAD_SESSION_VERSION_V1,
    );
    expect(frozen.materializerVersion).toBe(
      LOCATION_AWARE_PAYLOAD_MATERIALIZER_VERSION_V1,
    );

    caller.codec.id = "caller-mutated";
    caller.storePolicy.maxArtifactBytes = 1;
    caller.readBudget.maxTotalBytes = 1;
    caller.locationBindingVersion = "caller-mutated";
    caller.locationAwareSessionVersion = "caller-mutated";
    caller.materializerVersion = "caller-mutated";
    expect(frozen as unknown).toEqual(
      runtimePolicy({
        maxArtifactBytes: 32 * 1024 * 1024,
        maxTotalBytes: 1024,
      }),
    );
  });

  test("rejects missing, extra, malformed, and unsupported aggregate dimensions", () => {
    const valid = runtimePolicy();
    const { codec: _missingCodec, ...withoutCodec } = valid;
    const { storePolicy: _missingStore, ...withoutStore } = valid;
    const { readBudget: _missingBudget, ...withoutBudget } = valid;
    const {
      locationAwareSessionVersion: _missingSessionVersion,
      ...withoutSessionVersion
    } = valid;
    const invalid: unknown[] = [
      null,
      [],
      withoutCodec,
      withoutStore,
      withoutBudget,
      withoutSessionVersion,
      { ...valid, extra: true },
      { ...valid, codec: { ...valid.codec, extra: true } },
      { ...valid, codec: { id: "other", version: "v1" } },
      { ...valid, codec: { id: valid.codec.id, version: "v2" } },
      {
        ...valid,
        storePolicy: { ...valid.storePolicy, extra: true },
      },
      {
        ...valid,
        storePolicy: { ...valid.storePolicy, maxArtifactBytes: 0 },
      },
      {
        ...valid,
        readBudget: { ...valid.readBudget, extra: true },
      },
      {
        ...valid,
        readBudget: { ...valid.readBudget, maxTotalBytes: 0 },
      },
      {
        ...valid,
        readBudget: {
          ...valid.readBudget,
          policyVersion: "paw.verified-canonical-payload-budget.v2",
        },
      },
      { ...valid, locationBindingVersion: "binding.v2" },
      { ...valid, locationAwareSessionVersion: "session.v2" },
      { ...valid, materializerVersion: "materializer.v2" },
    ];

    for (const value of invalid) {
      expect(() =>
        freezeFileDurableJsonPayloadRuntimePolicyV1(value as never),
      ).toThrow();
    }
  });

  test("rejects a bad store policy before workspace, lease, or filesystem authority is touched", () => {
    let workspaceReads = 0;
    let leaseReads = 0;
    const options = {
      sessionId: "session-policy",
      runId: "run-policy",
      get workspaceRoot() {
        workspaceReads += 1;
        throw new Error("workspace getter must not run");
      },
      get executionLease() {
        leaseReads += 1;
        throw new Error("lease getter must not run");
      },
      policy: {
        policyVersion: FILE_DURABLE_JSON_PAYLOAD_POLICY_VERSION_V1,
        maxArtifactBytes: 0,
      },
    };

    expect(() =>
      createFileDurableJsonPayloadReaderV1(options as never),
    ).toThrow("policy is invalid");
    expect(() =>
      createFileDurableJsonPayloadWriterV1(options as never),
    ).toThrow("policy is invalid");
    expect(workspaceReads).toBe(0);
    expect(leaseReads).toBe(0);
  });

  test("keeps the real v1 artifact ref and path layout while using the frozen policy", async () => {
    const root = tempRoot();
    const leaseResult = acquireFileSessionExecutionLeaseV1({
      workspaceRoot: root,
      sessionId: "session-policy",
      runId: "run-policy",
      ownerId: "owner-policy",
      ttlMs: 60_000,
      baseTailSeq: 0,
      basePrefixHash: EMPTY_RUN_JOURNAL_PREFIX_HASH_V1,
      clock: () => 1,
    });
    if (leaseResult.status !== "acquired") {
      throw new Error(`lease failed: ${leaseResult.status}`);
    }
    const mutablePolicy = {
      policyVersion: FILE_DURABLE_JSON_PAYLOAD_POLICY_VERSION_V1,
      maxArtifactBytes: 1024 * 1024,
    };
    const writer = createFileDurableJsonPayloadWriterV1({
      workspaceRoot: root,
      sessionId: "session-policy",
      runId: "run-policy",
      executionLease: leaseResult.lease,
      policy: mutablePolicy,
    });
    mutablePolicy.maxArtifactBytes = 1;
    const payload = await writer.prepare(
      { stable: "payload" },
      {
        originSeq: 1,
        field: { kind: "model_response", modelCallId: "model-1" },
      },
    );

    expect(payload.kind).toBe("artifact_ref");
    if (payload.kind !== "artifact_ref") {
      throw new Error("file payload writer returned an inline payload");
    }
    expect(payload.artifactRef).toMatch(/^paw-payload:v1:[0-9a-f]{64}$/);
    const artifactHash = payload.artifactRef.replace("paw-payload:v1:", "");
    const artifacts = recursiveFiles(root).filter((file) =>
      file.endsWith(`${artifactHash}.json`),
    );
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.split(path.sep)).toContain(
      FILE_DURABLE_JSON_PAYLOAD_CODEC_V1.version,
    );
    expect(
      await writer.resolve(payload, {
        originSeq: 1,
        field: { kind: "model_response", modelCallId: "model-1" },
      }),
    ).toEqual({ stable: "payload" });
  });
});

function runtimePolicy(
  overrides: {
    readonly maxArtifactBytes?: number;
    readonly maxTotalBytes?: number;
  } = {},
) {
  return {
    codec: {
      id: FILE_DURABLE_JSON_PAYLOAD_CODEC_V1.id as string,
      version: FILE_DURABLE_JSON_PAYLOAD_CODEC_V1.version as string,
    },
    storePolicy: {
      policyVersion: FILE_DURABLE_JSON_PAYLOAD_POLICY_VERSION_V1 as string,
      maxArtifactBytes: overrides.maxArtifactBytes ?? 1024 * 1024,
    },
    readBudget: {
      policyVersion:
        VERIFIED_CANONICAL_PAYLOAD_BUDGET_POLICY_VERSION_V1 as string,
      maxTotalBytes: overrides.maxTotalBytes ?? 1024 * 1024,
    },
    locationBindingVersion:
      CANONICAL_DURABLE_JSON_PAYLOAD_BINDING_VERSION_V1 as string,
    locationAwareSessionVersion:
      LOCATION_AWARE_PAYLOAD_SESSION_VERSION_V1 as string,
    materializerVersion:
      LOCATION_AWARE_PAYLOAD_MATERIALIZER_VERSION_V1 as string,
  };
}

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-payload-policy-"));
  roots.push(root);
  return root;
}

function recursiveFiles(root: string): string[] {
  const output: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) output.push(...recursiveFiles(target));
    else output.push(target);
  }
  return output;
}
