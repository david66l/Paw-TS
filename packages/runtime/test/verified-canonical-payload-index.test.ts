import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import type { SessionInputSnapshot } from "@paw/agent-loop";
import {
  type DerivedDecisionV1,
  type DurableJsonPayloadV1,
  type InputFactV1,
  type JsonValue,
  RUN_JOURNAL_SCHEMA_VERSION_V1,
  type RunJournalEnvelopeV1,
} from "@paw/protocol";
import {
  type CanonicalDurableJsonPayloadResolverV1,
  DEFAULT_FILE_DURABLE_JSON_PAYLOAD_POLICY_V1,
  EMPTY_RUN_JOURNAL_PREFIX_HASH_V1,
  type FileSessionExecutionLeaseV1,
  VERIFIED_CANONICAL_PAYLOAD_BUDGET_POLICY_VERSION_V1,
  VERIFIED_CANONICAL_PAYLOAD_INDEX_VERSION_V1,
  acquireFileSessionExecutionLeaseV1,
  assertVerifiedCanonicalPayloadIndexMatchesV1,
  buildVerifiedCanonicalPayloadIndexV1,
  createFileDurableJsonPayloadReaderV1,
  createFileDurableJsonPayloadWriterV1,
  createVerifiedModelResponseEvidenceV1,
  validateCanonicalDurableJsonPayloadPrefixV1,
} from "@paw/runtime";

const roots: string[] = [];
let ownerSequence = 0;

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("verified canonical payload index", () => {
  test("adapts an issued index into exact Agent Loop model response evidence", async () => {
    const fixture = completeFixture();
    const expectedBudget = budget(1_000_000);
    const index = await build(fixture);
    const identity = fixture.resolver.readCanonicalPayloadIdentity();
    const evidence = createVerifiedModelResponseEvidenceV1({
      index,
      fullPrefix: fixture.prefix,
      identity,
      budget: expectedBudget,
    });
    const snapshot = sessionSnapshot(fixture.prefix);
    const carrier = fixture.prefix.find(
      (entry) =>
        entry.record.kind === "input_fact" &&
        entry.record.fact.type === "model.settled",
    );
    if (
      !carrier ||
      carrier.record.kind !== "input_fact" ||
      carrier.record.fact.type !== "model.settled" ||
      !carrier.record.fact.response
    ) {
      throw new Error("expected model response carrier");
    }

    const resolved = evidence.requireModelResponse({
      snapshot,
      carrierSeq: carrier.seq,
      modelCallId: "model-1",
      payload: carrier.record.fact.response,
    });
    expect(resolved as unknown).toEqual(fixture.values.model);
    expect(() =>
      evidence.assertSnapshot({ ...snapshot, tailSeq: snapshot.tailSeq + 1 }),
    ).toThrow("snapshot mismatch");
    expect(() =>
      createVerifiedModelResponseEvidenceV1({
        index,
        fullPrefix: fixture.prefix,
        identity,
        budget: budget(999_999),
      }),
    ).toThrow("prefix mismatch");
    expect(() =>
      createVerifiedModelResponseEvidenceV1({
        index,
        fullPrefix: fixture.prefix,
        identity: {
          ...identity,
          workspaceRoot: `${identity.workspaceRoot}-other`,
        },
        budget: expectedBudget,
      }),
    ).toThrow("prefix mismatch");
  });

  test("verifies all five carrier kinds in stable mixed inline/artifact order", async () => {
    const fixture = completeFixture();
    const before = JSON.stringify(fixture.prefix);
    const index = await build(fixture);

    expect(index).toMatchObject({
      indexVersion: VERIFIED_CANONICAL_PAYLOAD_INDEX_VERSION_V1,
      sessionId: "session-1",
      runId: "run-1",
      tailSeq: 18,
      budget: budget(1_000_000),
    });
    expect(index.prefixDigest).toBe(
      hashJson(fixture.prefix as unknown as JsonValue),
    );
    expect(index.occurrences.map((item) => item.location.kind)).toEqual([
      "input_attachment",
      "input_attachment",
      "input_attachment",
      "input_attachment",
      "input_attachment",
      "model_response",
      "tool_observation",
      "task_checkpoint",
      "task_checkpoint",
      "task_checkpoint",
    ]);
    expect(fixture.resolver.resolveCalls).toEqual([
      fixture.refs.attachment,
      fixture.refs.model,
      fixture.refs.tool,
      fixture.refs.distilled,
    ]);
    expect(index.totalBytes).toBe(uniqueBindingBytes(fixture.values));
    expect(JSON.stringify(fixture.prefix)).toBe(before);
    assertRecursivelyFrozen(index);

    const accepted = index.occurrences[0];
    const promoted = index.occurrences[2];
    const settled = index.occurrences[7];
    const recorded = index.occurrences[8];
    expect(accepted?.binding).toEqual(promoted?.binding);
    expect(accepted?.value).toBe(promoted?.value);
    expect(settled?.binding).toEqual(recorded?.binding);
    expect(settled?.value).toBe(recorded?.value);
  });

  test("charges once per canonical binding and separately for equal values at different bindings", async () => {
    const fixture = completeFixture({ equalAttachmentValues: true });
    const index = await build(fixture);
    expect(index.occurrences[0]?.value).toEqual(index.occurrences[1]?.value);
    expect(index.occurrences[0]?.binding).not.toEqual(
      index.occurrences[1]?.binding,
    );
    expect(index.totalBytes).toBe(uniqueBindingBytes(fixture.values));
    expect(fixture.resolver.resolveCalls).toHaveLength(4);
  });

  test("binds exact prefix identity and digest and rejects forged indexes", async () => {
    const fixture = completeFixture();
    const index = await build(fixture);
    expect(() =>
      assertIndexMatches(index, fixture, fixture.prefix),
    ).not.toThrow();

    for (const mutation of [
      (prefix: RunJournalEnvelopeV1[]) => {
        prefix.forEach((item, index) => {
          prefix[index] = { ...item, sessionId: "session-other" };
        });
      },
      (prefix: RunJournalEnvelopeV1[]) => {
        prefix.forEach((item, index) => {
          prefix[index] = { ...item, runId: "run-other" };
        });
      },
      (prefix: RunJournalEnvelopeV1[]) => {
        prefix.push(
          envelope(prefix.length + 1, {
            kind: "input_fact",
            fact: runtimeFailure("tail changed"),
          }),
        );
      },
      (prefix: RunJournalEnvelopeV1[]) => {
        const first = prefix[0];
        if (!first) throw new Error("fixture first envelope is missing");
        prefix[0] = { ...first, ts: 999 };
      },
    ]) {
      const changed = clone(fixture.prefix);
      mutation(changed);
      expect(() => assertIndexMatches(index, fixture, changed)).toThrow(
        "prefix mismatch",
      );
    }

    expect(() =>
      assertIndexMatches(index, fixture, fixture.prefix, budget(999_999)),
    ).toThrow("prefix mismatch");

    const forged = { ...index };
    expect(() =>
      assertVerifiedCanonicalPayloadIndexMatchesV1(forged, {
        fullPrefix: fixture.prefix,
        identity: fixture.resolver.readCanonicalPayloadIdentity(),
        budget: budget(1_000_000),
      }),
    ).toThrow("not issued");
  });

  test("cannot move issued evidence across real workspaces or identity shadows", async () => {
    const rootA = tempRoot();
    const rootB = tempRoot();
    const leaseA = acquireLease(rootA);
    const writerA = createFileDurableJsonPayloadWriterV1({
      workspaceRoot: rootA,
      sessionId: "session-1",
      runId: "run-1",
      executionLease: leaseA,
      policy: DEFAULT_FILE_DURABLE_JSON_PAYLOAD_POLICY_V1,
    });
    const readerB = createFileDurableJsonPayloadReaderV1({
      workspaceRoot: rootB,
      sessionId: "session-1",
      runId: "run-1",
      policy: DEFAULT_FILE_DURABLE_JSON_PAYLOAD_POLICY_V1,
    });
    const binding = {
      originSeq: 2,
      field: {
        kind: "input_attachment" as const,
        inputId: "input-1",
        attachmentId: "attachment-1",
      },
    };
    const payload = await writerA.prepare("workspace A", binding);
    const prefix = minimalAttachmentPrefix(payload);
    const mutableResolver: CanonicalDurableJsonPayloadResolverV1 & {
      workspaceRoot: string;
    } = {
      workspaceRoot: rootA,
      readCanonicalPayloadIdentity: writerA.readCanonicalPayloadIdentity,
      async resolve(payloadValue, expectedBinding, signal) {
        mutableResolver.readCanonicalPayloadIdentity =
          readerB.readCanonicalPayloadIdentity;
        mutableResolver.workspaceRoot = rootB;
        return writerA.resolve(payloadValue, expectedBinding, signal);
      },
      hash: writerA.hash,
    };
    const identityA = writerA.readCanonicalPayloadIdentity();
    expect(Object.isFrozen(identityA)).toBeTrue();
    expect(
      Reflect.set(identityA as object, "workspaceRoot", rootB),
    ).toBeFalse();
    const index = await buildVerifiedCanonicalPayloadIndexV1({
      fullPrefix: prefix,
      resolver: mutableResolver,
      budget: budget(1_000_000),
    });
    expect(index.workspaceRoot).toBe(identityA.workspaceRoot);
    expect(mutableResolver.workspaceRoot).toBe(rootB);
    expect(() =>
      assertVerifiedCanonicalPayloadIndexMatchesV1(index, {
        fullPrefix: prefix,
        identity: readerB.readCanonicalPayloadIdentity(),
        budget: budget(1_000_000),
      }),
    ).toThrow("prefix mismatch");
    expect(() =>
      assertVerifiedCanonicalPayloadIndexMatchesV1(index, {
        fullPrefix: prefix,
        identity: identityA,
        budget: budget(999_999),
      }),
    ).toThrow("prefix mismatch");
    expect(() =>
      assertVerifiedCanonicalPayloadIndexMatchesV1(index, {
        fullPrefix: clone(prefix),
        identity: identityA,
        budget: budget(1_000_000),
      }),
    ).not.toThrow();
    await leaseA.release();
  });

  test("requires exact carrier location, owner, and payload for every lookup", async () => {
    const fixture = completeFixture();
    const index = await build(fixture);
    const model = index.occurrences.find(
      (item) => item.location.kind === "model_response",
    );
    if (!model || model.location.kind !== "model_response") {
      throw new Error("model occurrence is missing");
    }
    expect(
      index.requireOccurrence({
        location: model.location,
        payload: model.payload,
      }),
    ).toBe(model);
    expect(
      index.findOccurrence({
        location: { ...model.location, modelCallId: "model-other" },
        payload: model.payload,
      }),
    ).toBeUndefined();
    expect(
      index.findOccurrence({
        location: model.location,
        payload: { ...model.payload, hash: "0".repeat(64) },
      }),
    ).toBeUndefined();
    expect(
      index.requireModelResponse({
        carrierSeq: model.location.carrierSeq,
        modelCallId: model.location.modelCallId,
        payload: model.payload,
      }).toolCalls[0]?.callId,
    ).toBe("call-1");
    expect(
      index.findModelResponse({
        carrierSeq: model.location.carrierSeq,
        modelCallId: "model-other",
        payload: model.payload,
      }),
    ).toBeUndefined();
    expect("findByArtifactRef" in index).toBeFalse();
    expect("findByModelCallId" in index).toBeFalse();
  });

  test("detaches every value and lookup result from hostile input and resolver mutation", async () => {
    const fixture = completeFixture();
    const index = await build(fixture);
    const model = index.occurrences.find(
      (item) => item.location.kind === "model_response",
    );
    if (!model || model.location.kind !== "model_response") {
      throw new Error("model occurrence is missing");
    }
    const original = JSON.stringify(model.value);
    fixture.resolver.mutate(fixture.refs.model, { replaced: true });
    const carrier = fixture.prefix[8];
    if (
      carrier?.record.kind !== "input_fact" ||
      carrier.record.fact.type !== "model.settled" ||
      !carrier.record.fact.response
    ) {
      throw new Error("model carrier is missing");
    }
    (carrier.record.fact.response as { hash: string }).hash = "f".repeat(64);
    expect(JSON.stringify(model.value)).toBe(original);
    const response = index.requireModelResponse({
      carrierSeq: model.location.carrierSeq,
      modelCallId: model.location.modelCallId,
      payload: model.payload,
    });
    expect(JSON.stringify(response)).toBe(original);
    assertRecursivelyFrozen(response);
  });

  test("fails hash, type, model-observation, and checkpoint range gates", async () => {
    const cases: Array<{
      name: string;
      mutate(fixture: CompleteFixture): void;
      message: string;
    }> = [
      {
        name: "hash",
        mutate: (fixture) => {
          fixture.resolver.mutate(fixture.refs.tool, { changed: true });
        },
        message: "hash mismatch",
      },
      {
        name: "attachment type",
        mutate: (fixture) =>
          replaceArtifact(fixture, fixture.refs.attachment, { not: "text" }),
        message: "must be text",
      },
      {
        name: "model identity",
        mutate: (fixture) => {
          const response = clone(fixture.values.model) as Record<
            string,
            unknown
          >;
          const calls = response.toolCalls as Array<Record<string, unknown>>;
          if (!calls[0]) throw new Error("model call fixture is missing");
          calls[0].callId = "call-other";
          replaceArtifact(fixture, fixture.refs.model, response as JsonValue);
        },
        message: "identity mismatch",
      },
      {
        name: "checkpoint range",
        mutate: (fixture) => {
          const checkpoint = taskCheckpoint([99]);
          replaceArtifact(fixture, fixture.refs.distilled, checkpoint);
        },
        message: "outside its source range",
      },
    ];

    for (const item of cases) {
      const fixture = completeFixture();
      item.mutate(fixture);
      await expect(build(fixture), item.name).rejects.toThrow(item.message);
    }
  });

  test("enforces exact N/N-1 total bytes with legal carrier reuse counted once", async () => {
    const fixture = completeFixture();
    const roomy = await build(fixture);
    const exact = await build(fixture, roomy.totalBytes);
    expect(exact.totalBytes).toBe(roomy.totalBytes);
    await expect(build(fixture, roomy.totalBytes - 1)).rejects.toThrow(
      "total byte budget exceeded",
    );
    expect(exact.budget).toEqual(budget(roomy.totalBytes));
    assertRecursivelyFrozen(exact.budget);
  });

  test("honors abort before reader I/O and shares one semantic core with the B2 validator", async () => {
    const fixture = completeFixture();
    const controller = new AbortController();
    controller.abort(new Error("stop index"));
    await expect(
      buildVerifiedCanonicalPayloadIndexV1({
        fullPrefix: fixture.prefix,
        resolver: fixture.resolver,
        budget: budget(1_000_000),
        signal: controller.signal,
      }),
    ).rejects.toThrow("stop index");
    expect(fixture.resolver.resolveCalls).toHaveLength(0);

    await expect(
      validateCanonicalDurableJsonPayloadPrefixV1({
        fullPrefix: fixture.prefix,
        materializer: fixture.resolver,
        budget: budget(1_000_000),
      }),
    ).resolves.toBeUndefined();
    fixture.resolver.mutate(fixture.refs.model, { corrupt: true });
    await expect(build(fixture)).rejects.toThrow("hash mismatch");
    await expect(
      validateCanonicalDurableJsonPayloadPrefixV1({
        fullPrefix: fixture.prefix,
        materializer: fixture.resolver,
        budget: budget(1_000_000),
      }),
    ).rejects.toThrow("hash mismatch");
  });

  test("a missing or corrupt real artifact is rejected without reader writes", async () => {
    for (const damage of ["missing", "corrupt"] as const) {
      const root = tempRoot();
      const lease = acquireLease(root);
      const writer = createFileDurableJsonPayloadWriterV1({
        workspaceRoot: root,
        sessionId: "session-1",
        runId: "run-1",
        executionLease: lease,
        policy: DEFAULT_FILE_DURABLE_JSON_PAYLOAD_POLICY_V1,
      });
      const binding = {
        originSeq: 2,
        field: {
          kind: "input_attachment" as const,
          inputId: "input-1",
          attachmentId: "attachment-1",
        },
      };
      const payload = await writer.prepare("artifact text", binding);
      const prefix = minimalAttachmentPrefix(payload);
      const artifactPath = onlyPayloadArtifact(root);
      if (damage === "missing") fs.rmSync(artifactPath);
      else fs.writeFileSync(artifactPath, "corrupt bytes", "utf8");
      const before = rawTree(root);
      const reader = createFileDurableJsonPayloadReaderV1({
        workspaceRoot: root,
        sessionId: "session-1",
        runId: "run-1",
        policy: DEFAULT_FILE_DURABLE_JSON_PAYLOAD_POLICY_V1,
      });

      await expect(
        buildVerifiedCanonicalPayloadIndexV1({
          fullPrefix: prefix,
          resolver: reader,
          budget: budget(1_000_000),
        }),
      ).rejects.toThrow();
      expect(rawTree(root)).toEqual(before);
      await lease.release();
    }
  });
});

interface CompleteFixture {
  prefix: RunJournalEnvelopeV1[];
  resolver: MemoryResolver;
  refs: {
    attachment: string;
    model: string;
    tool: string;
    distilled: string;
  };
  values: {
    attachmentA: JsonValue;
    attachmentB: JsonValue;
    initial: JsonValue;
    model: JsonValue;
    tool: JsonValue;
    distilled: JsonValue;
    direct: JsonValue;
  };
}

function completeFixture(
  options: { readonly equalAttachmentValues?: boolean } = {},
): CompleteFixture {
  const resolver = new MemoryResolver();
  const attachmentA: JsonValue = "shared attachment";
  const attachmentB: JsonValue = options.equalAttachmentValues
    ? "shared attachment"
    : "inline attachment";
  const initial: JsonValue = "initial attachment";
  const call = nativeCall("call-1", 0, { path: "README.md" });
  const model = modelResponse([call]);
  const tool: JsonValue = { text: "read result" };
  const distilled = taskCheckpoint([1, 13]);
  const direct = taskCheckpoint([1, 17]);
  const attachmentPayload = resolver.artifact("a", attachmentA);
  const modelPayload = resolver.artifact("c", model);
  const toolPayload = resolver.artifact("d", tool);
  const distilledPayload = resolver.artifact("e", distilled);
  const acceptedAttachments = [
    attachment("attachment-a", attachmentPayload),
    attachment("attachment-b", inline(attachmentB)),
  ] as const;
  const journal = new JournalFixture();
  journal.fact(attempt());
  journal.decision();
  journal.fact({
    type: "input.accepted",
    inputId: "input-steer",
    delivery: "steer",
    content: "steer",
    contentHash: "steer-hash",
    callerId: "caller-1",
    attachments: acceptedAttachments,
  });
  journal.decision();
  journal.fact({
    type: "input.promoted",
    inputId: "input-steer",
    delivery: "steer",
    content: "steer",
    contentHash: "steer-hash",
    attachments: acceptedAttachments,
  });
  journal.fact({
    type: "input.promoted",
    inputId: "input-initial",
    delivery: "initial",
    content: "initial",
    contentHash: "initial-hash",
    attachments: [attachment("attachment-initial", inline(initial))],
  });
  journal.fact({
    type: "model.dispatch_recorded",
    modelCallId: "model-1",
    turn: 1,
    requestHash: "request-hash",
  });
  journal.decision();
  journal.fact({
    type: "model.settled",
    modelCallId: "model-1",
    turn: 1,
    status: "completed",
    hasToolCalls: true,
    hasVisibleOutput: false,
    response: modelPayload,
  });
  journal.fact({
    type: "tool.call_observed",
    callId: call.callId,
    modelCallId: "model-1",
    turn: 1,
    tool: call.name,
    args: call.args,
    order: call.sourceIndex,
  });
  journal.fact({
    type: "tool.dispatch_recorded",
    callId: "call-1",
    turn: 1,
    sourceIndex: 0,
    batchId: "batch-1",
    mode: "parallel",
  });
  journal.fact({
    type: "tool.permission_resolved",
    turn: 1,
    sourceIndex: 0,
    callId: "call-1",
    tool: "workspace.read_file",
    policyVersion: "policy-v1",
    resolution: "allow_once",
    source: "base_policy",
  });
  const toolSettledSeq = journal.fact({
    type: "tool.settled",
    callId: "call-1",
    status: "completed",
    observation: {
      schemaVersion: "paw.tool-observation.v1",
      summary: "read",
      isError: false,
      payload: toolPayload,
    },
  });
  journal.fact({
    type: "context.checkpoint_distillation_claimed",
    claimId: "claim-1",
    checkpointId: "checkpoint-1",
    boundary: "after_tool_batch_settled",
    policyVersion: "checkpoint-policy-v1",
    sourceFromSeq: 1,
    sourceThroughSeq: toolSettledSeq,
    sourceInputHash: "source-hash-1",
  });
  journal.decision();
  journal.fact({
    type: "context.checkpoint_distillation_settled",
    claimId: "claim-1",
    status: "completed",
    checkpoint: distilledPayload,
  });
  journal.fact({
    type: "context.checkpoint_recorded",
    checkpointId: "checkpoint-1",
    distillationClaimId: "claim-1",
    policyVersion: "checkpoint-policy-v1",
    sourceFromSeq: 1,
    sourceThroughSeq: toolSettledSeq,
    sourceInputHash: "source-hash-1",
    checkpoint: distilledPayload,
  });
  journal.fact({
    type: "context.checkpoint_recorded",
    checkpointId: "checkpoint-direct",
    supersedesCheckpointId: "checkpoint-1",
    policyVersion: "checkpoint-policy-v1",
    sourceFromSeq: 1,
    sourceThroughSeq: 17,
    sourceInputHash: "source-hash-2",
    checkpoint: inline(direct),
  });
  return {
    prefix: journal.prefix,
    resolver,
    refs: {
      attachment: attachmentPayload.artifactRef,
      model: modelPayload.artifactRef,
      tool: toolPayload.artifactRef,
      distilled: distilledPayload.artifactRef,
    },
    values: {
      attachmentA,
      attachmentB,
      initial,
      model,
      tool,
      distilled,
      direct,
    },
  };
}

class MemoryResolver {
  readonly values = new Map<string, JsonValue>();
  readonly resolveCalls: string[] = [];

  readCanonicalPayloadIdentity() {
    return {
      workspaceRoot: "memory://workspace",
      sessionId: "session-1",
      runId: "run-1",
    };
  }

  artifact(
    marker: string,
    value: JsonValue,
  ): Extract<DurableJsonPayloadV1, { kind: "artifact_ref" }> {
    const digit = marker.charCodeAt(0).toString(16).at(-1) ?? "0";
    const artifactRef = `paw-payload:v1:${digit.repeat(64)}`;
    this.values.set(artifactRef, clone(value));
    return { kind: "artifact_ref", artifactRef, hash: hashJson(value) };
  }

  async resolve(
    payload: DurableJsonPayloadV1,
    _binding: unknown,
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    if (signal?.aborted) throw signal.reason;
    if (payload.kind !== "artifact_ref") throw new Error("expected artifact");
    this.resolveCalls.push(payload.artifactRef);
    const value = this.values.get(payload.artifactRef);
    if (value === undefined) throw new Error("artifact is missing");
    return clone(value);
  }

  hash(value: JsonValue): string {
    return hashJson(value);
  }

  mutate(artifactRef: string, value: JsonValue): void {
    this.values.set(artifactRef, clone(value));
  }
}

class JournalFixture {
  readonly prefix: RunJournalEnvelopeV1[] = [];

  fact(fact: InputFactV1): number {
    const seq = this.prefix.length + 1;
    this.prefix.push(envelope(seq, { kind: "input_fact", fact }));
    return seq;
  }

  decision(): number {
    const previous = this.prefix.at(-1);
    if (!previous || previous.record.kind !== "input_fact") {
      throw new Error("decision fixture must follow input fact");
    }
    const decision: DerivedDecisionV1 = {
      type: "control.decided",
      reducerVersion: "fixture-reducer-v1",
      inputThroughSeq: previous.seq,
      stateHash: `state-${previous.seq}`,
      action: { kind: "continue", reasonCode: "fixture_continue" },
    };
    const seq = this.prefix.length + 1;
    this.prefix.push(envelope(seq, { kind: "derived_decision", decision }));
    return seq;
  }
}

function replaceArtifact(
  fixture: CompleteFixture,
  artifactRef: string,
  value: JsonValue,
): void {
  fixture.resolver.mutate(artifactRef, value);
  for (const envelope of fixture.prefix) {
    if (envelope.record.kind !== "input_fact") continue;
    const fact = envelope.record.fact;
    const payloads: DurableJsonPayloadV1[] = [];
    if (fact.type === "input.accepted" || fact.type === "input.promoted") {
      payloads.push(...(fact.attachments ?? []).map((item) => item.content));
    } else if (fact.type === "model.settled" && fact.response) {
      payloads.push(fact.response);
    } else if (fact.type === "tool.settled" && fact.observation?.payload) {
      payloads.push(fact.observation.payload);
    } else if (
      fact.type === "context.checkpoint_distillation_settled" &&
      fact.checkpoint
    ) {
      payloads.push(fact.checkpoint);
    } else if (fact.type === "context.checkpoint_recorded") {
      payloads.push(fact.checkpoint);
    }
    for (const payload of payloads) {
      if (
        payload.kind === "artifact_ref" &&
        payload.artifactRef === artifactRef
      ) {
        (payload as { hash: string }).hash = hashJson(value);
      }
    }
  }
}

function build(fixture: CompleteFixture, maxTotalBytes = 1_000_000) {
  return buildVerifiedCanonicalPayloadIndexV1({
    fullPrefix: fixture.prefix,
    resolver: fixture.resolver,
    budget: budget(maxTotalBytes),
  });
}

function assertIndexMatches(
  index: Awaited<ReturnType<typeof buildVerifiedCanonicalPayloadIndexV1>>,
  fixture: CompleteFixture,
  fullPrefix: readonly RunJournalEnvelopeV1[],
  expectedBudget = budget(1_000_000),
): void {
  assertVerifiedCanonicalPayloadIndexMatchesV1(index, {
    fullPrefix,
    identity: fixture.resolver.readCanonicalPayloadIdentity(),
    budget: expectedBudget,
  });
}

function budget(maxTotalBytes: number) {
  return {
    policyVersion: VERIFIED_CANONICAL_PAYLOAD_BUDGET_POLICY_VERSION_V1,
    maxTotalBytes,
  } as const;
}

function uniqueBindingBytes(values: CompleteFixture["values"]): number {
  let total = 0;
  for (const value of Object.values(values)) {
    total += new TextEncoder().encode(canonicalJson(value)).length;
  }
  return total;
}

function minimalAttachmentPrefix(
  payload: DurableJsonPayloadV1,
): readonly RunJournalEnvelopeV1[] {
  return [
    envelope(1, { kind: "input_fact", fact: attempt() }),
    envelope(2, {
      kind: "input_fact",
      fact: {
        type: "input.promoted",
        inputId: "input-1",
        delivery: "initial",
        content: "goal",
        contentHash: "goal-hash",
        attachments: [attachment("attachment-1", payload)],
      },
    }),
  ];
}

function sessionSnapshot(
  prefix: readonly RunJournalEnvelopeV1[],
): SessionInputSnapshot<InputFactV1> {
  const entries = prefix.flatMap((entry) =>
    entry.record.kind === "input_fact"
      ? [{ seq: entry.seq, fact: entry.record.fact }]
      : [],
  );
  return {
    entries,
    tailSeq: prefix.at(-1)?.seq ?? 0,
    latestInputSeq: entries.at(-1)?.seq ?? 0,
  };
}

function attempt(): InputFactV1 {
  return {
    type: "attempt.started",
    goalHash: "goal-hash",
    configHash: "config-hash",
  };
}

function runtimeFailure(message: string): InputFactV1 {
  return {
    type: "runtime.failed",
    area: "runtime",
    errorCode: "E_RUNTIME",
    message,
    retryable: false,
  };
}

function nativeCall(callId: string, sourceIndex: number, args: JsonValue) {
  return {
    callId,
    name: "workspace.read_file",
    args,
    rawArguments: canonicalJson(args),
    sourceIndex,
    argumentsValid: true,
  };
}

function modelResponse(toolCalls: readonly ReturnType<typeof nativeCall>[]) {
  return {
    schemaVersion: "paw.model-response.v1" as const,
    providerProtocol: "openai-compatible" as const,
    assistantContent: "",
    toolCalls,
  };
}

function taskCheckpoint(sourceSeqs: readonly number[]) {
  return {
    schemaVersion: "paw.task-checkpoint.v1" as const,
    confirmedFacts: [{ statement: "fact", sourceSeqs }],
    currentHypotheses: [],
    ruledOut: [],
    changedFiles: [],
    verification: [],
    unresolved: [],
  };
}

function inline(value: JsonValue): DurableJsonPayloadV1 {
  return { kind: "inline", value: clone(value), hash: hashJson(value) };
}

function attachment(attachmentId: string, content: DurableJsonPayloadV1) {
  return {
    attachmentId,
    type: "file" as const,
    name: `${attachmentId}.txt`,
    content,
  };
}

function envelope(
  seq: number,
  record: RunJournalEnvelopeV1["record"],
): RunJournalEnvelopeV1 {
  return {
    schemaVersion: RUN_JOURNAL_SCHEMA_VERSION_V1,
    sessionId: "session-1",
    runId: "run-1",
    seq,
    ts: seq,
    record,
  };
}

function hashJson(value: JsonValue): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Readonly<Record<string, JsonValue>>;
  return `{${Object.keys(record)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson(record[key] as JsonValue)}`,
    )
    .join(",")}}`;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function assertRecursivelyFrozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBeTrue();
  for (const item of Object.values(value)) assertRecursivelyFrozen(item);
}

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-verified-index-"));
  roots.push(root);
  return root;
}

function acquireLease(root: string): FileSessionExecutionLeaseV1 {
  ownerSequence += 1;
  const result = acquireFileSessionExecutionLeaseV1({
    workspaceRoot: root,
    sessionId: "session-1",
    runId: "run-1",
    ownerId: `verified-index-owner-${ownerSequence}`,
    ttlMs: 1_000_000,
    baseTailSeq: 0,
    basePrefixHash: EMPTY_RUN_JOURNAL_PREFIX_HASH_V1,
    clock: () => 42,
  });
  if (result.status !== "acquired") {
    throw new Error(`lease acquisition failed: ${result.status}`);
  }
  return result.lease;
}

function onlyPayloadArtifact(root: string): string {
  const files = walkFiles(root).filter((item) =>
    item.includes(`${path.sep}durable-json-payloads${path.sep}`),
  );
  if (files.length !== 1 || !files[0]) {
    throw new Error(`expected one payload artifact, got ${files.length}`);
  }
  return files[0];
}

function walkFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) files.push(target);
    }
  };
  visit(root);
  return files.sort();
}

function rawTree(root: string): readonly string[] {
  return walkFiles(root).map((file) => {
    const relative = path.relative(root, file).replaceAll("\\", "/");
    const bytes = fs.readFileSync(file);
    return `${relative}:${hashJson(bytes.toString("base64"))}:${bytes.length}`;
  });
}
