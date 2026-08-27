import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import type { DurableJsonPayloadV1, JsonValue } from "@paw/protocol";
import {
  DEFAULT_FILE_DURABLE_JSON_PAYLOAD_POLICY_V1,
  type DurableJsonPayloadBindingV1,
  EMPTY_RUN_JOURNAL_PREFIX_HASH_V1,
  FILE_DURABLE_JSON_PAYLOAD_POLICY_VERSION_V1,
  type FileDurableJsonPayloadPolicyV1,
  type FileSessionExecutionLeaseV1,
  acquireFileSessionExecutionLeaseV1,
  createFileDurableJsonPayloadReaderV1,
  createFileDurableJsonPayloadWriterV1,
} from "@paw/runtime";

const roots: string[] = [];
let ownerSequence = 0;

const policy: FileDurableJsonPayloadPolicyV1 = Object.freeze({
  policyVersion: FILE_DURABLE_JSON_PAYLOAD_POLICY_VERSION_V1,
  maxArtifactBytes: 1024 * 1024,
});

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("file durable JSON payload store", () => {
  test("round-trips canonical immutable JSON without overwriting identical content", async () => {
    const root = tempRoot();
    const lease = acquire(root);
    const writer = createWriter(root, lease);
    const binding = modelBinding(4, "model-4");
    const original = {
      z: [{ b: 2 }],
      a: 1,
    };

    const first = await writer.prepare(
      original as unknown as JsonValue,
      binding,
      signal(),
    );
    original.a = 99;
    const firstOriginalItem = original.z[0];
    if (!firstOriginalItem) throw new Error("test fixture item is missing");
    firstOriginalItem.b = 88;

    const resolved = await writer.resolve(first, binding, signal());
    expect(resolved).toEqual({ a: 1, z: [{ b: 2 }] });
    expect(Object.isFrozen(writer)).toBeTrue();
    expect(Object.isFrozen(resolved)).toBeTrue();
    expect(Object.isFrozen((resolved as { z: unknown[] }).z)).toBeTrue();
    expect(
      Object.isFrozen((resolved as { z: Array<{ b: number }> }).z[0]),
    ).toBeTrue();
    expect(() => {
      (resolved as { a: number }).a = 500;
    }).toThrow();

    const second = await writer.prepare(
      { a: 1, z: [{ b: 2 }] },
      binding,
      signal(),
    );
    expect(second).toEqual(first);
    expect(payloadArtifactFiles(root)).toHaveLength(1);
    expect(await writer.resolve(first, binding, signal())).toEqual({
      a: 1,
      z: [{ b: 2 }],
    });
    const raw = fs.readFileSync(artifactPath(root, first), "utf8");
    expect(raw).toBe(canonicalJson(JSON.parse(raw) as JsonValue));
  });

  test("rejects non-canonical or wrong-type envelopes and never overwrites an occupied content address", async () => {
    const root = tempRoot();
    const writer = createWriter(root, acquire(root));
    const binding = modelBinding(5, "model-canonical");
    const payload = await writer.prepare(
      { canonical: true },
      binding,
      signal(),
    );
    const finalPath = artifactPath(root, payload);
    const canonicalBytes = fs.readFileSync(finalPath, "utf8");

    const nonCanonicalBytes = `{ ${canonicalBytes.slice(1)}`;
    const nonCanonicalHash = hash(Buffer.from(nonCanonicalBytes));
    fs.writeFileSync(
      path.join(path.dirname(finalPath), `${nonCanonicalHash}.json`),
      nonCanonicalBytes,
      "utf8",
    );
    await expect(
      writer.resolve(
        artifactRef(nonCanonicalHash, payload.hash),
        binding,
        signal(),
      ),
    ).rejects.toThrow("not canonical JSON");

    const wrongTypeEnvelope = JSON.parse(canonicalBytes) as Record<
      string,
      JsonValue
    >;
    wrongTypeEnvelope.payloadType = "not_durable_json";
    const wrongTypeBytes = canonicalJson(wrongTypeEnvelope);
    const wrongTypeHash = hash(Buffer.from(wrongTypeBytes));
    fs.writeFileSync(
      path.join(path.dirname(finalPath), `${wrongTypeHash}.json`),
      wrongTypeBytes,
      "utf8",
    );
    await expect(
      writer.resolve(
        artifactRef(wrongTypeHash, payload.hash),
        binding,
        signal(),
      ),
    ).rejects.toThrow("envelope is invalid");

    fs.rmSync(finalPath);
    fs.writeFileSync(finalPath, nonCanonicalBytes, "utf8");
    await expect(writer.resolve(payload, binding, signal())).rejects.toThrow(
      "envelope hash mismatch",
    );
    await expect(
      writer.prepare({ canonical: true }, binding, signal()),
    ).rejects.toThrow("collision");
    expect(fs.readFileSync(finalPath, "utf8")).toBe(nonCanonicalBytes);
  });

  test("binds every artifact to origin seq and its semantic owner", async () => {
    const root = tempRoot();
    const writer = createWriter(root, acquire(root));
    const binding = modelBinding(9, "model-9");
    const payload = await writer.prepare({ answer: 42 }, binding, signal());
    const wrongBindings: DurableJsonPayloadBindingV1[] = [
      modelBinding(10, "model-9"),
      modelBinding(9, "model-other"),
      {
        originSeq: 9,
        field: {
          kind: "input_attachment",
          inputId: "input-1",
          attachmentId: "attachment-1",
        },
      },
      {
        originSeq: 9,
        field: { kind: "tool_observation", callId: "call-1" },
      },
      {
        originSeq: 9,
        field: { kind: "task_checkpoint", checkpointId: "checkpoint-1" },
      },
    ];
    for (const wrong of wrongBindings) {
      await expect(writer.resolve(payload, wrong, signal())).rejects.toThrow(
        "binding mismatch",
      );
    }
  });

  test("permits only callers that retain the original accepted or distillation binding to reuse a ref", async () => {
    const root = tempRoot();
    const writer = createWriter(root, acquire(root));
    const attachmentBinding: DurableJsonPayloadBindingV1 = {
      originSeq: 2,
      field: {
        kind: "input_attachment",
        inputId: "input-1",
        attachmentId: "attachment-1",
      },
    };
    const checkpointBinding: DurableJsonPayloadBindingV1 = {
      originSeq: 20,
      field: { kind: "task_checkpoint", checkpointId: "checkpoint-1" },
    };
    const attachment = await writer.prepare(
      "attachment text",
      attachmentBinding,
      signal(),
    );
    const checkpoint = await writer.prepare(
      { summary: "stable" },
      checkpointBinding,
      signal(),
    );

    expect(await writer.resolve(attachment, attachmentBinding, signal())).toBe(
      "attachment text",
    );
    expect(await writer.resolve(attachment, attachmentBinding, signal())).toBe(
      "attachment text",
    );
    expect(
      await writer.resolve(checkpoint, checkpointBinding, signal()),
    ).toEqual({ summary: "stable" });
    expect(
      await writer.resolve(checkpoint, checkpointBinding, signal()),
    ).toEqual({ summary: "stable" });
    await expect(
      writer.resolve(
        checkpoint,
        {
          originSeq: 21,
          field: {
            kind: "task_checkpoint",
            checkpointId: "checkpoint-1",
          },
        },
        signal(),
      ),
    ).rejects.toThrow("binding mismatch");
  });

  test("the same JSON value at a different origin or owner gets a different content address", async () => {
    const root = tempRoot();
    const writer = createWriter(root, acquire(root));
    const value = { same: "value" };

    const original = await writer.prepare(
      value,
      modelBinding(3, "model-3"),
      signal(),
    );
    const differentOrigin = await writer.prepare(
      value,
      modelBinding(4, "model-3"),
      signal(),
    );
    const differentOwner = await writer.prepare(
      value,
      modelBinding(3, "model-other"),
      signal(),
    );

    expect(refId(differentOrigin)).not.toBe(refId(original));
    expect(refId(differentOwner)).not.toBe(refId(original));
    expect(payloadArtifactFiles(root)).toHaveLength(3);
  });

  test("rejects copied artifacts across workspace, session, and run identities", async () => {
    const sourceRoot = tempRoot();
    const sourceLease = acquire(sourceRoot, "session-source", "run-source");
    const sourceWriter = createWriter(
      sourceRoot,
      sourceLease,
      "session-source",
      "run-source",
    );
    const binding = modelBinding(7, "model-7");
    const payload = await sourceWriter.prepare(
      { source: true },
      binding,
      signal(),
    );
    const sourceArtifact = artifactPath(sourceRoot, payload);
    await sourceLease.release();

    const targets = [
      {
        root: tempRoot(),
        sessionId: "session-source",
        runId: "run-source",
      },
      { root: sourceRoot, sessionId: "session-other", runId: "run-source" },
      { root: sourceRoot, sessionId: "session-source", runId: "run-other" },
    ];
    for (const target of targets) {
      const targetLease = acquire(target.root, target.sessionId, target.runId);
      const targetWriter = createWriter(
        target.root,
        targetLease,
        target.sessionId,
        target.runId,
      );
      const seed = await targetWriter.prepare(
        { target: true },
        modelBinding(1, "target-model"),
        signal(),
      );
      const targetDir = path.dirname(artifactPath(target.root, seed));
      fs.copyFileSync(
        sourceArtifact,
        path.join(targetDir, path.basename(sourceArtifact)),
      );
      await expect(
        targetWriter.resolve(payload, binding, signal()),
      ).rejects.toThrow("binding mismatch");
      await targetLease.release();
    }
  });

  test("rejects malformed refs, wrong value hashes, missing files, and never creates on read", async () => {
    const absentRoot = tempRoot();
    const before = rawTree(absentRoot);
    const absentReader = createReader(absentRoot);
    expect(Object.isFrozen(absentReader)).toBeTrue();
    await expect(
      absentReader.resolve(
        artifactRef("0".repeat(64), "1".repeat(64)),
        modelBinding(1, "model-1"),
        signal(),
      ),
    ).rejects.toThrow();
    expect(rawTree(absentRoot)).toEqual(before);
    await expect(
      absentReader.resolve(
        {
          kind: "artifact_ref",
          artifactRef: "../outside.json",
          hash: "1".repeat(64),
        },
        modelBinding(1, "model-1"),
        signal(),
      ),
    ).rejects.toThrow("reference is invalid");
    expect(rawTree(absentRoot)).toEqual(before);

    const root = tempRoot();
    const writer = createWriter(root, acquire(root));
    const binding = modelBinding(3, "model-3");
    const payload = await writer.prepare({ ok: true }, binding, signal());
    await expect(
      writer.resolve({ ...payload, hash: "f".repeat(64) }, binding, signal()),
    ).rejects.toThrow("value hash mismatch");
    fs.rmSync(artifactPath(root, payload));
    const missingTree = rawTree(root);
    await expect(writer.resolve(payload, binding, signal())).rejects.toThrow();
    expect(rawTree(root)).toEqual(missingTree);
  });

  test("enforces canonical envelope byte limits for both writers and readers", async () => {
    const root = tempRoot();
    const lease = acquire(root);
    const tinyPolicy = {
      policyVersion: FILE_DURABLE_JSON_PAYLOAD_POLICY_VERSION_V1,
      maxArtifactBytes: 64,
    } as const;
    const tinyWriter = createFileDurableJsonPayloadWriterV1({
      workspaceRoot: root,
      sessionId: "session-1",
      runId: "run-1",
      executionLease: lease,
      policy: tinyPolicy,
    });
    const before = rawTree(root);
    await expect(
      tinyWriter.prepare({ value: "too-large" }, modelBinding(1), signal()),
    ).rejects.toThrow("exceeds policy size");
    expect(rawTree(root)).toEqual(before);

    const roomyWriter = createWriter(root, lease);
    const binding = modelBinding(2, "model-2");
    const payload = await roomyWriter.prepare(
      { value: "x".repeat(500) },
      binding,
      signal(),
    );
    const restrictiveReader = createFileDurableJsonPayloadReaderV1({
      workspaceRoot: root,
      sessionId: "session-1",
      runId: "run-1",
      policy: { ...policy, maxArtifactBytes: 128 },
    });
    await expect(
      restrictiveReader.resolve(payload, binding, signal()),
    ).rejects.toThrow("unsafe");
  });

  test("binds the complete artifact size policy into the reference", async () => {
    const root = tempRoot();
    const lease = acquire(root);
    const binding = modelBinding(7, "model-policy");
    const oneMiB = createFileDurableJsonPayloadWriterV1({
      workspaceRoot: root,
      sessionId: "session-1",
      runId: "run-1",
      executionLease: lease,
      policy,
    });
    const twoMiB = createFileDurableJsonPayloadWriterV1({
      workspaceRoot: root,
      sessionId: "session-1",
      runId: "run-1",
      executionLease: lease,
      policy: { ...policy, maxArtifactBytes: 2 * 1024 * 1024 },
    });

    const first = await oneMiB.prepare({ value: "same" }, binding, signal());
    const second = await twoMiB.prepare({ value: "same" }, binding, signal());
    if (first.kind !== "artifact_ref" || second.kind !== "artifact_ref") {
      throw new Error("file payload writer returned a non-artifact payload");
    }
    expect(first.hash).toBe(second.hash);
    expect(first.artifactRef).not.toBe(second.artifactRef);
    expect(await oneMiB.resolve(first, binding, signal())).toEqual({
      value: "same",
    });
    expect(await twoMiB.resolve(second, binding, signal())).toEqual({
      value: "same",
    });
    await expect(oneMiB.resolve(second, binding, signal())).rejects.toThrow(
      "binding mismatch",
    );
    await expect(twoMiB.resolve(first, binding, signal())).rejects.toThrow(
      "binding mismatch",
    );
  });

  test("rejects non-issued and identity-mismatched execution leases", () => {
    const root = tempRoot();
    const other = tempRoot();
    const lease = acquire(root);
    const duck = {
      ...lease,
      assertHeld: () => undefined,
      renew: async () => undefined,
      release: async () => "released" as const,
      linearizeJournalBatch: lease.linearizeJournalBatch.bind(lease),
    };
    expect(() =>
      createFileDurableJsonPayloadWriterV1({
        workspaceRoot: root,
        sessionId: "session-1",
        runId: "run-1",
        executionLease: duck,
        policy,
      }),
    ).toThrow("issued execution lease capability");
    expect(() => createWriter(other, lease)).toThrow("identity mismatch");
  });

  test("released or expired writers cannot publish another artifact", async () => {
    const releasedRoot = tempRoot();
    const releasedLease = acquire(releasedRoot);
    const releasedWriter = createWriter(releasedRoot, releasedLease);
    await releasedLease.release();
    const releasedTree = rawTree(releasedRoot);
    await expect(
      releasedWriter.prepare({ stale: "released" }, modelBinding(1), signal()),
    ).rejects.toThrow();
    expect(rawTree(releasedRoot)).toEqual(releasedTree);
    expect(payloadArtifactFiles(releasedRoot)).toHaveLength(0);

    const expiredRoot = tempRoot();
    let now = 10;
    const expiredLease = acquireAt(expiredRoot, () => now, 100);
    const expiredWriter = createWriter(expiredRoot, expiredLease);
    now = 111;
    const expiredTree = rawTree(expiredRoot);
    await expect(
      expiredWriter.prepare({ stale: "expired" }, modelBinding(1), signal()),
    ).rejects.toThrow();
    expect(rawTree(expiredRoot)).toEqual(expiredTree);
    expect(payloadArtifactFiles(expiredRoot)).toHaveLength(0);
  });

  test("abort is fail-closed and leaves the payload tree byte-identical", async () => {
    const root = tempRoot();
    const writer = createWriter(root, acquire(root));
    const controller = new AbortController();
    controller.abort("stop");
    const before = rawTree(root);
    await expect(
      writer.prepare({ no: "write" }, modelBinding(1), controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(rawTree(root)).toEqual(before);
  });

  test("a missing-final crash temp is ignored and never promoted by a read", async () => {
    const root = tempRoot();
    const writer = createWriter(root, acquire(root));
    const binding = modelBinding(5, "model-5");
    const payload = await writer.prepare({ crash: true }, binding, signal());
    const finalPath = artifactPath(root, payload);
    const tempPath = path.join(
      path.dirname(finalPath),
      `.payload-publish-${process.pid}-${randomUUID()}.tmp`,
    );
    fs.renameSync(finalPath, tempPath);
    const before = rawTree(root);

    await expect(writer.resolve(payload, binding, signal())).rejects.toThrow();
    expect(rawTree(root)).toEqual(before);
    expect(fs.existsSync(tempPath)).toBeTrue();
    expect(fs.existsSync(finalPath)).toBeFalse();
  });

  test("a read rejects but never repairs the publisher link-before-unlink window", async () => {
    const root = tempRoot();
    const writer = createWriter(root, acquire(root));
    const binding = modelBinding(6, "model-6");
    const payload = await writer.prepare({ linked: true }, binding, signal());
    const finalPath = artifactPath(root, payload);
    const tempPath = path.join(
      path.dirname(finalPath),
      `.payload-publish-${process.pid}-${randomUUID()}.tmp`,
    );
    fs.linkSync(finalPath, tempPath);
    const before = rawTree(root);

    await expect(writer.resolve(payload, binding, signal())).rejects.toThrow(
      "unsafe",
    );
    expect(rawTree(root)).toEqual(before);
    expect(fs.lstatSync(finalPath).nlink).toBe(2);

    expect(await writer.prepare({ linked: true }, binding, signal())).toEqual(
      payload,
    );
    expect(fs.existsSync(tempPath)).toBeFalse();
    expect(fs.lstatSync(finalPath).nlink).toBe(1);
  });

  test("a tampered formal file with a publisher-shaped inode alias is rejected without cleanup", async () => {
    const root = tempRoot();
    const writer = createWriter(root, acquire(root));
    const binding = modelBinding(7, "model-tampered-alias");
    const value = { linked: "tampered" };
    const payload = await writer.prepare(value, binding, signal());
    const finalPath = artifactPath(root, payload);
    const aliasPath = path.join(
      path.dirname(finalPath),
      `.payload-publish-${process.pid}-${randomUUID()}.tmp`,
    );
    fs.rmSync(finalPath);
    fs.writeFileSync(finalPath, "tampered-formal-bytes", "utf8");
    fs.linkSync(finalPath, aliasPath);
    const before = rawTree(root);

    await expect(writer.prepare(value, binding, signal())).rejects.toThrow(
      "collision",
    );
    expect(rawTree(root)).toEqual(before);
    expect(fs.existsSync(finalPath)).toBeTrue();
    expect(fs.existsSync(aliasPath)).toBeTrue();
    expect(fs.lstatSync(finalPath).nlink).toBe(2);
    expect(fs.lstatSync(aliasPath).ino).toBe(fs.lstatSync(finalPath).ino);
  });

  test("an unrelated publisher temp is ignored without being deleted", async () => {
    const root = tempRoot();
    const writer = createWriter(root, acquire(root));
    const binding = modelBinding(8, "model-8");
    const payload = await writer.prepare({ final: true }, binding, signal());
    const tempPath = path.join(
      path.dirname(artifactPath(root, payload)),
      `.payload-publish-${process.pid}-${randomUUID()}.tmp`,
    );
    fs.writeFileSync(tempPath, "orphan-temp", "utf8");
    const before = rawTree(root);

    expect(await writer.resolve(payload, binding, signal())).toEqual({
      final: true,
    });
    expect(rawTree(root)).toEqual(before);
    expect(fs.readFileSync(tempPath, "utf8")).toBe("orphan-temp");
  });

  test("external hardlinks fail closed without mutating either link", async () => {
    const root = tempRoot();
    const writer = createWriter(root, acquire(root));
    const binding = modelBinding(11, "model-11");
    const payload = await writer.prepare(
      { linked: "outside" },
      binding,
      signal(),
    );
    const finalPath = artifactPath(root, payload);
    const alias = path.join(root, "external-payload-hardlink.json");
    fs.linkSync(finalPath, alias);
    const before = rawTree(root);

    await expect(writer.resolve(payload, binding, signal())).rejects.toThrow(
      "unsafe",
    );
    expect(rawTree(root)).toEqual(before);
    expect(fs.lstatSync(alias).nlink).toBe(2);
  });

  test.skipIf(process.platform === "win32")(
    "artifact file symlinks fail closed without following the target",
    async () => {
      const root = tempRoot();
      const writer = createWriter(root, acquire(root));
      const binding = modelBinding(12, "model-12");
      const payload = await writer.prepare(
        { symbolic: false },
        binding,
        signal(),
      );
      const finalPath = artifactPath(root, payload);
      const outside = path.join(tempRoot(), "outside.json");
      fs.copyFileSync(finalPath, outside);
      fs.rmSync(finalPath);
      fs.symlinkSync(outside, finalPath, "file");
      const before = rawTree(root);

      await expect(writer.resolve(payload, binding, signal())).rejects.toThrow(
        "unsafe",
      );
      expect(rawTree(root)).toEqual(before);
    },
  );

  test("payload directory symlinks or Windows junctions fail closed", async () => {
    const root = tempRoot();
    const writer = createWriter(root, acquire(root));
    const binding = modelBinding(13, "model-13");
    const payload = await writer.prepare({ escaped: false }, binding, signal());
    const finalPath = artifactPath(root, payload);
    const storeDir = path.dirname(finalPath);
    const outsideDir = path.join(tempRoot(), "outside-store");
    fs.mkdirSync(outsideDir);
    fs.copyFileSync(finalPath, path.join(outsideDir, path.basename(finalPath)));
    fs.rmSync(storeDir, { recursive: true });
    fs.symlinkSync(
      outsideDir,
      storeDir,
      process.platform === "win32" ? "junction" : "dir",
    );
    const before = rawTree(root);

    await expect(writer.resolve(payload, binding, signal())).rejects.toThrow(
      "unsafe directory",
    );
    expect(rawTree(root)).toEqual(before);
  });

  test("policy and binding inputs are detached from caller mutation", async () => {
    const root = tempRoot();
    const lease = acquire(root);
    const mutablePolicy: FileDurableJsonPayloadPolicyV1 = {
      policyVersion: FILE_DURABLE_JSON_PAYLOAD_POLICY_VERSION_V1,
      maxArtifactBytes: 1024 * 1024,
    };
    const writer = createFileDurableJsonPayloadWriterV1({
      workspaceRoot: root,
      sessionId: "session-1",
      runId: "run-1",
      executionLease: lease,
      policy: mutablePolicy,
    });
    const mutableBinding = {
      originSeq: 14,
      field: { kind: "model_response" as const, modelCallId: "model-14" },
    };
    const payload = await writer.prepare(
      { detached: true },
      mutableBinding,
      signal(),
    );
    (mutablePolicy as { maxArtifactBytes: number }).maxArtifactBytes = 1;
    mutableBinding.originSeq = 99;
    mutableBinding.field.modelCallId = "mutated";

    expect(
      await writer.resolve(payload, modelBinding(14, "model-14"), signal()),
    ).toEqual({ detached: true });
    expect(
      Object.isFrozen(DEFAULT_FILE_DURABLE_JSON_PAYLOAD_POLICY_V1),
    ).toBeTrue();
  });
});

function createReader(root: string, sessionId = "session-1", runId = "run-1") {
  return createFileDurableJsonPayloadReaderV1({
    workspaceRoot: root,
    sessionId,
    runId,
    policy,
  });
}

function createWriter(
  root: string,
  executionLease: FileSessionExecutionLeaseV1,
  sessionId = "session-1",
  runId = "run-1",
) {
  return createFileDurableJsonPayloadWriterV1({
    workspaceRoot: root,
    sessionId,
    runId,
    executionLease,
    policy,
  });
}

function acquire(
  root: string,
  sessionId = "session-1",
  runId = "run-1",
): FileSessionExecutionLeaseV1 {
  ownerSequence += 1;
  const result = acquireFileSessionExecutionLeaseV1({
    workspaceRoot: root,
    sessionId,
    runId,
    ownerId: `payload-owner-${ownerSequence}`,
    ttlMs: 1_000_000,
    baseTailSeq: 0,
    basePrefixHash: EMPTY_RUN_JOURNAL_PREFIX_HASH_V1,
    clock: () => 42,
  });
  if (result.status !== "acquired") {
    throw new Error(`payload lease acquisition failed: ${result.status}`);
  }
  return result.lease;
}

function acquireAt(
  root: string,
  clock: () => number,
  ttlMs: number,
): FileSessionExecutionLeaseV1 {
  ownerSequence += 1;
  const result = acquireFileSessionExecutionLeaseV1({
    workspaceRoot: root,
    sessionId: "session-1",
    runId: "run-1",
    ownerId: `payload-owner-${ownerSequence}`,
    ttlMs,
    baseTailSeq: 0,
    basePrefixHash: EMPTY_RUN_JOURNAL_PREFIX_HASH_V1,
    clock,
  });
  if (result.status !== "acquired") {
    throw new Error(`payload lease acquisition failed: ${result.status}`);
  }
  return result.lease;
}

function modelBinding(
  originSeq: number,
  modelCallId = `model-${originSeq}`,
): DurableJsonPayloadBindingV1 {
  return {
    originSeq,
    field: { kind: "model_response", modelCallId },
  };
}

function artifactRef(
  envelopeHash: string,
  valueHash: string,
): DurableJsonPayloadV1 {
  return {
    kind: "artifact_ref",
    artifactRef: `paw-payload:v1:${envelopeHash}`,
    hash: valueHash,
  };
}

function refId(payload: DurableJsonPayloadV1): string {
  if (payload.kind !== "artifact_ref") throw new Error("expected artifact ref");
  return payload.artifactRef;
}

function artifactPath(root: string, payload: DurableJsonPayloadV1): string {
  if (payload.kind !== "artifact_ref") throw new Error("expected artifact ref");
  const hash = payload.artifactRef.split(":").at(-1);
  if (!hash) throw new Error("artifact ref has no hash");
  const matches = filesUnder(root).filter(
    (file) => path.basename(file) === `${hash}.json`,
  );
  if (matches.length !== 1) {
    throw new Error(`expected one payload artifact, found ${matches.length}`);
  }
  return matches[0] as string;
}

function payloadArtifactFiles(root: string): string[] {
  return filesUnder(root).filter((file) =>
    /[\\/]durable-json-payloads[\\/].*[\\/][0-9a-f]{64}\.json$/.test(file),
  );
}

function filesUnder(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const full = path.join(directory, name);
      const stat = fs.lstatSync(full);
      if (stat.isDirectory() && !stat.isSymbolicLink()) visit(full);
      else if (stat.isFile()) files.push(full);
    }
  };
  visit(root);
  return files;
}

function rawTree(root: string): readonly string[] {
  const entries: string[] = [];
  const visit = (directory: string) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const full = path.join(directory, name);
      const relative = path.relative(root, full);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) {
        entries.push(`link:${relative}:${fs.readlinkSync(full)}`);
      } else if (stat.isDirectory()) {
        entries.push(`dir:${relative}`);
        visit(full);
      } else {
        entries.push(
          `file:${relative}:${stat.nlink}:${stat.size}:${hash(fs.readFileSync(full))}`,
        );
      }
    }
  };
  visit(root);
  return entries;
}

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-payload-store-"));
  roots.push(root);
  return root;
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

function hash(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Readonly<Record<string, JsonValue>>;
  return `{${Object.keys(record)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson(record[key] as JsonValue)}`,
    )
    .join(",")}}`;
}
