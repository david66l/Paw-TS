import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { DurableJsonPayloadV1, JsonValue } from "@paw/protocol";

import {
  canonicalJsonStringifyV1,
  hashCanonicalJsonV1,
  immutableCanonicalJsonCloneV1,
} from "../context/canonical-json.js";
import {
  type FileSessionExecutionLeaseV1,
  assertFileSessionExecutionLeaseCapabilityV1,
} from "../session/session-execution-lease.js";
import type {
  DurableJsonPayloadBindingV1,
  DurableJsonPayloadFieldV1,
} from "./canonical-payload-binding.js";
import {
  type CanonicalPayloadIdentityV1,
  freezeCanonicalPayloadIdentityV1,
} from "./canonical-payload-identity.js";

export const FILE_DURABLE_JSON_PAYLOAD_POLICY_VERSION_V1 =
  "paw.file-durable-json-payload-policy.v1" as const;
export const FILE_DURABLE_JSON_PAYLOAD_CODEC_V1 = Object.freeze({
  id: "paw.file-durable-json",
  version: "v1",
});
export const DEFAULT_FILE_DURABLE_JSON_PAYLOAD_POLICY_V1 = Object.freeze({
  policyVersion: FILE_DURABLE_JSON_PAYLOAD_POLICY_VERSION_V1,
  maxArtifactBytes: 16 * 1024 * 1024,
});

const ARTIFACT_SCHEMA_VERSION =
  "paw.file-durable-json-payload-artifact.v1" as const;
const ARTIFACT_REF = /^paw-payload:v1:([0-9a-f]{64})$/;
const ARTIFACT_FILE = /^([0-9a-f]{64})\.json$/;
const TEMP_FILE = /^\.payload-publish-\d+-[0-9a-f-]{36}\.tmp$/;
const SHA256 = /^[0-9a-f]{64}$/;
const STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/;
const MAX_CONFIGURABLE_ARTIFACT_BYTES = 256 * 1024 * 1024;

export interface FileDurableJsonPayloadPolicyV1 {
  readonly policyVersion: typeof FILE_DURABLE_JSON_PAYLOAD_POLICY_VERSION_V1;
  /** Maximum UTF-8 byte length of the complete canonical artifact envelope. */
  readonly maxArtifactBytes: number;
}

export interface FileDurableJsonPayloadReaderOptionsV1 {
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly policy: FileDurableJsonPayloadPolicyV1;
}

export interface FileDurableJsonPayloadWriterOptionsV1
  extends FileDurableJsonPayloadReaderOptionsV1 {
  readonly executionLease: FileSessionExecutionLeaseV1;
}

export interface FileDurableJsonPayloadReaderV1 {
  readCanonicalPayloadIdentity(): CanonicalPayloadIdentityV1;
  resolve(
    payload: DurableJsonPayloadV1,
    expectedBinding: DurableJsonPayloadBindingV1,
    signal?: AbortSignal,
  ): Promise<JsonValue>;
  hash(value: JsonValue): string;
}

export interface FileDurableJsonPayloadWriterV1
  extends FileDurableJsonPayloadReaderV1 {
  prepare(
    value: JsonValue,
    binding: DurableJsonPayloadBindingV1,
    signal?: AbortSignal,
  ): Promise<DurableJsonPayloadV1>;
}

interface StoreIdentity {
  readonly workspaceRoot: string;
  readonly workspaceIdentityHash: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly policy: FileDurableJsonPayloadPolicyV1;
  readonly payloadRoot: string;
  readonly versionRoot: string;
  readonly storeDir: string;
}

interface PayloadArtifactEnvelopeV1 {
  readonly schemaVersion: typeof ARTIFACT_SCHEMA_VERSION;
  readonly policy: FileDurableJsonPayloadPolicyV1;
  readonly payloadType: "durable_json";
  readonly workspaceIdentityHash: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly originSeq: number;
  readonly field: DurableJsonPayloadFieldV1;
  readonly valueHash: string;
  readonly value: JsonValue;
}

export function createFileDurableJsonPayloadReaderV1(
  options: FileDurableJsonPayloadReaderOptionsV1,
): FileDurableJsonPayloadReaderV1 {
  const identity = storeIdentity(options);
  return reader(identity);
}

export function createFileDurableJsonPayloadWriterV1(
  options: FileDurableJsonPayloadWriterOptionsV1,
): FileDurableJsonPayloadWriterV1 {
  const identity = storeIdentity(options);
  const capability = assertFileSessionExecutionLeaseCapabilityV1(
    options.executionLease,
    identity.workspaceRoot,
    identity.sessionId,
    identity.runId,
  );
  capability.assertHeld();
  const read = reader(identity);
  return Object.freeze({
    ...read,
    async prepare(
      value: JsonValue,
      binding: DurableJsonPayloadBindingV1,
      signal?: AbortSignal,
    ) {
      throwIfAborted(signal);
      capability.assertHeld();
      const canonicalValue = canonicalJsonValue(value, "payload value");
      const canonicalBinding = parseBinding(binding, "payload binding");
      const valueHash = hashCanonicalValue(canonicalValue);
      const envelope = immutableCanonicalJsonCloneV1({
        schemaVersion: ARTIFACT_SCHEMA_VERSION,
        policy: {
          policyVersion: identity.policy.policyVersion,
          maxArtifactBytes: identity.policy.maxArtifactBytes,
        },
        payloadType: "durable_json",
        workspaceIdentityHash: identity.workspaceIdentityHash,
        sessionId: identity.sessionId,
        runId: identity.runId,
        originSeq: canonicalBinding.originSeq,
        field: canonicalBinding.field,
        valueHash,
        value: canonicalValue,
      }) as unknown as PayloadArtifactEnvelopeV1;
      const bytes = canonicalJsonStringifyV1(envelope as unknown as JsonValue);
      assertArtifactSize(bytes, identity.policy);
      const envelopeHash = hashText(bytes);
      const payload = Object.freeze({
        kind: "artifact_ref" as const,
        artifactRef: `paw-payload:v1:${envelopeHash}`,
        hash: valueHash,
      });

      ensureWriterDirectories(identity);
      capability.assertHeld();
      throwIfAborted(signal);
      const finalPath = path.join(identity.storeDir, `${envelopeHash}.json`);
      publishArtifact(
        identity,
        finalPath,
        bytes,
        envelopeHash,
        capability.assertHeld,
        signal,
      );
      capability.assertHeld();
      throwIfAborted(signal);
      readAndVerifyArtifact(identity, payload, canonicalBinding, signal);
      capability.assertHeld();
      return payload;
    },
  });
}

function reader(identity: StoreIdentity): FileDurableJsonPayloadReaderV1 {
  const canonicalIdentity = freezeCanonicalPayloadIdentityV1({
    workspaceRoot: identity.workspaceRoot,
    sessionId: identity.sessionId,
    runId: identity.runId,
  });
  return Object.freeze({
    readCanonicalPayloadIdentity: () => canonicalIdentity,
    async resolve(
      payload: DurableJsonPayloadV1,
      expectedBinding: DurableJsonPayloadBindingV1,
      signal?: AbortSignal,
    ) {
      throwIfAborted(signal);
      const binding = parseBinding(expectedBinding, "expected binding");
      return readAndVerifyArtifact(identity, payload, binding, signal);
    },
    hash(value: JsonValue) {
      return hashCanonicalValue(canonicalJsonValue(value, "payload value"));
    },
  });
}

function storeIdentity(
  options: FileDurableJsonPayloadReaderOptionsV1,
): StoreIdentity {
  assertStableId(options.sessionId, "sessionId");
  assertStableId(options.runId, "runId");
  const policy = freezeFileDurableJsonPayloadPolicyV1(options.policy);
  const workspaceRoot = fs.realpathSync.native(
    path.resolve(options.workspaceRoot),
  );
  const workspaceStat = fs.lstatSync(workspaceRoot);
  if (!workspaceStat.isDirectory() || workspaceStat.isSymbolicLink()) {
    throw new Error("Payload store workspace must be a real directory");
  }
  const normalizedWorkspaceIdentity = workspaceRoot.replaceAll("\\", "/");
  const workspaceIdentityHash = hashText(
    JSON.stringify([
      "paw.canonical-workspace.v1",
      process.platform === "win32"
        ? normalizedWorkspaceIdentity.toLowerCase()
        : normalizedWorkspaceIdentity,
    ]),
  );
  const storeKey = hashText(
    JSON.stringify([
      "paw.durable-json-payload-store.v1",
      workspaceIdentityHash,
      options.sessionId,
      options.runId,
    ]),
  );
  const payloadRoot = path.join(
    workspaceRoot,
    ".paw",
    "paw-next",
    "durable-json-payloads",
  );
  const versionRoot = path.join(
    payloadRoot,
    FILE_DURABLE_JSON_PAYLOAD_CODEC_V1.version,
  );
  return Object.freeze({
    workspaceRoot,
    workspaceIdentityHash,
    sessionId: options.sessionId,
    runId: options.runId,
    policy,
    payloadRoot,
    versionRoot,
    storeDir: path.join(versionRoot, storeKey),
  });
}

/** The one strict policy parser shared by the store and product manifests. */
export function freezeFileDurableJsonPayloadPolicyV1(
  input: FileDurableJsonPayloadPolicyV1,
): FileDurableJsonPayloadPolicyV1 {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).sort().join("\0") !==
      "maxArtifactBytes\0policyVersion" ||
    input.policyVersion !== FILE_DURABLE_JSON_PAYLOAD_POLICY_VERSION_V1 ||
    !Number.isSafeInteger(input.maxArtifactBytes) ||
    input.maxArtifactBytes <= 0 ||
    input.maxArtifactBytes > MAX_CONFIGURABLE_ARTIFACT_BYTES
  ) {
    throw new Error("Durable JSON payload policy is invalid");
  }
  return Object.freeze({
    policyVersion: input.policyVersion,
    maxArtifactBytes: input.maxArtifactBytes,
  });
}

function parseBinding(
  input: DurableJsonPayloadBindingV1,
  label: string,
): DurableJsonPayloadBindingV1 {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).sort().join("\0") !== "field\0originSeq" ||
    !Number.isSafeInteger(input.originSeq) ||
    input.originSeq <= 0
  ) {
    throw new Error(`${label} is invalid`);
  }
  return Object.freeze({
    originSeq: input.originSeq,
    field: parseField(input.field, `${label}.field`),
  });
}

function parseField(
  input: DurableJsonPayloadFieldV1,
  label: string,
): DurableJsonPayloadFieldV1 {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${label} is invalid`);
  }
  switch (input.kind) {
    case "input_attachment":
      assertExactKeys(input, ["attachmentId", "inputId", "kind"], label);
      assertStableId(input.inputId, `${label}.inputId`);
      assertStableId(input.attachmentId, `${label}.attachmentId`);
      return Object.freeze({
        kind: input.kind,
        inputId: input.inputId,
        attachmentId: input.attachmentId,
      });
    case "model_response":
      assertExactKeys(input, ["kind", "modelCallId"], label);
      assertStableId(input.modelCallId, `${label}.modelCallId`);
      return Object.freeze({
        kind: input.kind,
        modelCallId: input.modelCallId,
      });
    case "tool_observation":
      assertExactKeys(input, ["callId", "kind"], label);
      assertStableId(input.callId, `${label}.callId`);
      return Object.freeze({ kind: input.kind, callId: input.callId });
    case "task_checkpoint":
      assertExactKeys(input, ["checkpointId", "kind"], label);
      assertStableId(input.checkpointId, `${label}.checkpointId`);
      return Object.freeze({
        kind: input.kind,
        checkpointId: input.checkpointId,
      });
    default:
      throw new Error(`${label}.kind is unsupported`);
  }
}

function readAndVerifyArtifact(
  identity: StoreIdentity,
  payload: DurableJsonPayloadV1,
  expectedBinding: DurableJsonPayloadBindingV1,
  signal?: AbortSignal,
): JsonValue {
  throwIfAborted(signal);
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    Object.keys(payload).sort().join("\0") !== "artifactRef\0hash\0kind" ||
    payload.kind !== "artifact_ref"
  ) {
    throw new Error("File durable JSON payload store requires artifact_ref");
  }
  const match = ARTIFACT_REF.exec(payload.artifactRef);
  if (!match || !SHA256.test(payload.hash)) {
    throw new Error("Durable JSON payload reference is invalid");
  }
  const envelopeHash = match[1] as string;
  validateReaderDirectories(identity);
  const finalPath = path.join(identity.storeDir, `${envelopeHash}.json`);
  const raw = readStableArtifactFile(
    identity,
    finalPath,
    identity.policy.maxArtifactBytes,
  );
  throwIfAborted(signal);
  if (hashText(raw) !== envelopeHash) {
    throw new Error("Durable JSON payload envelope hash mismatch");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("Durable JSON payload artifact JSON is invalid");
  }
  const envelope = parseEnvelope(parsed);
  if (canonicalJsonStringifyV1(envelope as unknown as JsonValue) !== raw) {
    throw new Error("Durable JSON payload artifact is not canonical JSON");
  }
  if (
    envelope.policy.policyVersion !== identity.policy.policyVersion ||
    envelope.policy.maxArtifactBytes !== identity.policy.maxArtifactBytes ||
    envelope.workspaceIdentityHash !== identity.workspaceIdentityHash ||
    envelope.sessionId !== identity.sessionId ||
    envelope.runId !== identity.runId ||
    envelope.originSeq !== expectedBinding.originSeq ||
    canonicalJsonStringifyV1(envelope.field as unknown as JsonValue) !==
      canonicalJsonStringifyV1(expectedBinding.field as unknown as JsonValue)
  ) {
    throw new Error("Durable JSON payload artifact binding mismatch");
  }
  const actualValueHash = hashCanonicalValue(envelope.value);
  if (
    envelope.valueHash !== actualValueHash ||
    payload.hash !== actualValueHash
  ) {
    throw new Error("Durable JSON payload value hash mismatch");
  }
  validateReaderDirectories(identity);
  throwIfAborted(signal);
  return envelope.value;
}

function parseEnvelope(value: unknown): PayloadArtifactEnvelopeV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Durable JSON payload artifact envelope is invalid");
  }
  assertExactKeys(
    value,
    [
      "field",
      "originSeq",
      "payloadType",
      "policy",
      "runId",
      "schemaVersion",
      "sessionId",
      "value",
      "valueHash",
      "workspaceIdentityHash",
    ],
    "payload artifact envelope",
  );
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== ARTIFACT_SCHEMA_VERSION ||
    record.payloadType !== "durable_json" ||
    typeof record.workspaceIdentityHash !== "string" ||
    !SHA256.test(record.workspaceIdentityHash) ||
    typeof record.valueHash !== "string" ||
    !SHA256.test(record.valueHash) ||
    !Number.isSafeInteger(record.originSeq) ||
    (record.originSeq as number) <= 0
  ) {
    throw new Error("Durable JSON payload artifact envelope is invalid");
  }
  assertStableId(record.sessionId, "payload artifact sessionId");
  assertStableId(record.runId, "payload artifact runId");
  const envelope = {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    policy: freezeFileDurableJsonPayloadPolicyV1(
      record.policy as FileDurableJsonPayloadPolicyV1,
    ),
    payloadType: "durable_json" as const,
    workspaceIdentityHash: record.workspaceIdentityHash as string,
    sessionId: record.sessionId as string,
    runId: record.runId as string,
    originSeq: record.originSeq as number,
    field: parseField(
      record.field as DurableJsonPayloadFieldV1,
      "payload artifact field",
    ),
    valueHash: record.valueHash as string,
    value: canonicalJsonValue(record.value, "payload artifact value"),
  };
  return Object.freeze(envelope);
}

function publishArtifact(
  identity: StoreIdentity,
  finalPath: string,
  bytes: string,
  expectedHash: string,
  assertHeld: () => void,
  signal?: AbortSignal,
): void {
  const tempPath = path.join(
    identity.storeDir,
    `.payload-publish-${process.pid}-${randomUUID()}.tmp`,
  );
  let descriptor: number | undefined;
  let cleanupError: unknown;
  try {
    descriptor = fs.openSync(tempPath, "wx", 0o600);
    fs.writeFileSync(descriptor, bytes, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    throwIfAborted(signal);
    assertHeld();
    validateWriterDirectories(identity);
    try {
      fs.linkSync(tempPath, finalPath);
    } catch (error) {
      if (!fsError(error, "EEXIST")) throw error;
    }
    fsyncDirectoryBestEffort(identity.storeDir);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.rmSync(tempPath, { force: true });
      fsyncDirectoryBestEffort(identity.storeDir);
    } catch (error) {
      cleanupError = error;
    }
  }
  if (cleanupError !== undefined) {
    throw new Error("Durable JSON payload publisher temp cleanup failed", {
      cause: cleanupError,
    });
  }
  assertHeld();
  assertStablePublishedFile(identity, finalPath, bytes, expectedHash);
  validateWriterDirectories(identity);
}

function assertStablePublishedFile(
  identity: StoreIdentity,
  finalPath: string,
  expectedBytes: string,
  expectedHash: string,
): void {
  validateWriterDirectories(identity);
  const stat = fs.lstatSync(finalPath, { bigint: true });
  if (stat.nlink === 1n) {
    assertExpectedPublishedBytes(finalPath, expectedBytes, expectedHash, 1n);
    validateWriterDirectories(identity);
    return;
  }
  recoverWriterPublisherAlias(
    identity,
    finalPath,
    stat,
    expectedBytes,
    expectedHash,
  );
}

function recoverWriterPublisherAlias(
  identity: StoreIdentity,
  finalPath: string,
  formalBefore: fs.BigIntStats,
  expectedBytes: string,
  expectedHash: string,
): void {
  if (
    !formalBefore.isFile() ||
    formalBefore.isSymbolicLink() ||
    formalBefore.nlink !== 2n
  ) {
    throw new Error("Durable JSON payload artifact has external hardlinks");
  }
  const directory = path.dirname(finalPath);
  const aliases = fs
    .readdirSync(directory)
    .filter((name) => TEMP_FILE.test(name))
    .map((name) => path.join(directory, name))
    .filter((candidate) => {
      const candidateStat = fs.lstatSync(candidate, { bigint: true });
      return (
        candidateStat.isFile() &&
        !candidateStat.isSymbolicLink() &&
        candidateStat.nlink === 2n &&
        candidateStat.dev === formalBefore.dev &&
        candidateStat.ino === formalBefore.ino
      );
    });
  if (aliases.length !== 1) {
    throw new Error(
      "Durable JSON payload artifact hardlink is not recoverable",
    );
  }
  const aliasPath = aliases[0] as string;
  const aliasBefore = fs.lstatSync(aliasPath, { bigint: true });
  if (!sameStableFile(formalBefore, aliasBefore, 2n)) {
    throw new Error("Durable JSON payload publisher alias changed");
  }

  // Do not mutate the namespace until the formal artifact and its only
  // reserved publisher alias have been proven to contain this prepare's exact
  // expected bytes. A collision must leave both links byte-for-byte intact.
  const formalAfter = assertExpectedPublishedBytes(
    finalPath,
    expectedBytes,
    expectedHash,
    2n,
  );
  const aliasAfter = fs.lstatSync(aliasPath, { bigint: true });
  if (!sameStableFile(formalAfter, aliasAfter, 2n)) {
    throw new Error("Durable JSON payload publisher alias changed");
  }
  validateWriterDirectories(identity);
  fs.rmSync(aliasPath);
  fsyncDirectoryBestEffort(directory);
  validateWriterDirectories(identity);
  assertExpectedPublishedBytes(finalPath, expectedBytes, expectedHash, 1n);
}

function assertExpectedPublishedBytes(
  finalPath: string,
  expectedBytes: string,
  expectedHash: string,
  expectedLinks: bigint,
): fs.BigIntStats {
  const before = fs.lstatSync(finalPath, { bigint: true });
  if (!isStableRegularFile(before, expectedLinks)) {
    throw new Error("Durable JSON payload artifact file is unsafe");
  }
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(finalPath, fs.constants.O_RDONLY);
    const openedBefore = fs.fstatSync(descriptor, { bigint: true });
    if (!sameStableFile(before, openedBefore, expectedLinks)) {
      throw new Error("Durable JSON payload artifact changed before open");
    }
    const bytes = fs.readFileSync(descriptor, "utf8");
    const openedAfter = fs.fstatSync(descriptor, { bigint: true });
    const after = fs.lstatSync(finalPath, { bigint: true });
    if (
      !sameStableFile(openedBefore, openedAfter, expectedLinks) ||
      !sameStableFile(openedAfter, after, expectedLinks)
    ) {
      throw new Error("Durable JSON payload artifact changed while reading");
    }
    if (bytes !== expectedBytes || hashText(bytes) !== expectedHash) {
      throw new Error("Durable JSON payload artifact collision detected");
    }
    return after;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function readStableArtifactFile(
  identity: StoreIdentity,
  filePath: string,
  maxBytes: number,
): string {
  validateReaderDirectories(identity);
  const name = path.basename(filePath);
  if (!ARTIFACT_FILE.test(name)) {
    throw new Error("Durable JSON payload artifact filename is invalid");
  }
  const before = fs.lstatSync(filePath, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    before.size > BigInt(maxBytes)
  ) {
    throw new Error("Durable JSON payload artifact file is unsafe");
  }
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY);
    const openedBefore = fs.fstatSync(descriptor, { bigint: true });
    if (!sameStableFile(before, openedBefore, 1n)) {
      throw new Error("Durable JSON payload artifact changed before open");
    }
    const raw = fs.readFileSync(descriptor, "utf8");
    if (Buffer.byteLength(raw, "utf8") > maxBytes) {
      throw new Error("Durable JSON payload artifact exceeds policy size");
    }
    const openedAfter = fs.fstatSync(descriptor, { bigint: true });
    const after = fs.lstatSync(filePath, { bigint: true });
    if (
      !sameStableFile(openedBefore, openedAfter, 1n) ||
      !sameStableFile(openedAfter, after, 1n)
    ) {
      throw new Error("Durable JSON payload artifact changed while reading");
    }
    return raw;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function sameStableFile(
  left: fs.BigIntStats,
  right: fs.BigIntStats,
  expectedLinks: bigint,
): boolean {
  return (
    isStableRegularFile(left, expectedLinks) &&
    isStableRegularFile(right, expectedLinks) &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function isStableRegularFile(
  stat: fs.BigIntStats,
  expectedLinks: bigint,
): boolean {
  return (
    stat.isFile() && !stat.isSymbolicLink() && stat.nlink === expectedLinks
  );
}

function ensureWriterDirectories(identity: StoreIdentity): void {
  for (const directory of [
    path.join(identity.workspaceRoot, ".paw"),
    path.join(identity.workspaceRoot, ".paw", "paw-next"),
    identity.payloadRoot,
    identity.versionRoot,
    identity.storeDir,
  ]) {
    try {
      fs.mkdirSync(directory);
    } catch (error) {
      if (!fsError(error, "EEXIST")) throw error;
    }
    validateDirectoryChain(identity.workspaceRoot, directory);
  }
}

function validateWriterDirectories(identity: StoreIdentity): void {
  validateDirectoryChain(identity.workspaceRoot, identity.storeDir);
}

function validateReaderDirectories(identity: StoreIdentity): void {
  validateDirectoryChain(identity.workspaceRoot, identity.storeDir);
}

function validateDirectoryChain(workspaceRoot: string, target: string): void {
  const relative = path.relative(workspaceRoot, target);
  if (
    relative === "" ||
    path.isAbsolute(relative) ||
    relative.split(path.sep).includes("..")
  ) {
    throw new Error("Durable JSON payload path escaped the workspace");
  }
  let current = workspaceRoot;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Durable JSON payload path contains an unsafe directory");
    }
    const canonical = fs.realpathSync.native(current);
    const canonicalRelative = path.relative(workspaceRoot, canonical);
    if (
      canonicalRelative === "" ||
      path.isAbsolute(canonicalRelative) ||
      canonicalRelative.split(path.sep).includes("..")
    ) {
      throw new Error("Durable JSON payload path escaped the workspace");
    }
  }
}

function canonicalJsonValue(value: unknown, label: string): JsonValue {
  assertJsonValue(value, label, new Set<object>());
  return immutableCanonicalJsonCloneV1(value as JsonValue);
}

function assertJsonValue(
  value: unknown,
  label: string,
  ancestors: Set<object>,
): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} is not finite JSON`);
    return;
  }
  if (typeof value !== "object") throw new Error(`${label} is not JSON`);
  if (ancestors.has(value)) throw new Error(`${label} contains a JSON cycle`);
  const prototype = Object.getPrototypeOf(value);
  if (
    !Array.isArray(value) &&
    prototype !== Object.prototype &&
    prototype !== null
  ) {
    throw new Error(`${label} has a non-JSON object prototype`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new Error(`${label} contains symbol keys`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw new Error(`${label} is sparse`);
        assertJsonValue(value[index], `${label}[${index}]`, ancestors);
      }
      return;
    }
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      assertJsonValue(record[key], `${label}.${key}`, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function hashCanonicalValue(value: JsonValue): string {
  return hashCanonicalJsonV1(value);
}

function assertArtifactSize(
  bytes: string,
  policy: FileDurableJsonPayloadPolicyV1,
): void {
  if (Buffer.byteLength(bytes, "utf8") > policy.maxArtifactBytes) {
    throw new Error("Durable JSON payload artifact exceeds policy size");
  }
}

function assertExactKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  if (
    Object.keys(value).sort().join("\0") !== [...expected].sort().join("\0")
  ) {
    throw new Error(`${label} has unsupported fields`);
  }
}

function assertStableId(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || !STABLE_ID.test(value)) {
    throw new Error(`${label} must be a stable id`);
  }
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  throw error;
}

function fsyncDirectoryBestEffort(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (
      !fsError(error, "EINVAL") &&
      !fsError(error, "EISDIR") &&
      !fsError(error, "EPERM") &&
      !fsError(error, "EACCES")
    ) {
      throw error;
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function fsError(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}
