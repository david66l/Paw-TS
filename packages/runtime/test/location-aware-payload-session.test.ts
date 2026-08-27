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
  parseRunJournalPrefixV1,
} from "@paw/protocol";
import {
  DEFAULT_FILE_DURABLE_JSON_PAYLOAD_POLICY_V1,
  type DurableJsonPayloadBindingV1,
  EMPTY_RUN_JOURNAL_PREFIX_HASH_V1,
  FileRunSessionV1,
  type FileSessionExecutionLeaseV1,
  type LocationAwarePayloadMaterializerV1,
  type LocationAwarePayloadSessionSourceV1,
  SessionExecutionLeaseLostError,
  VERIFIED_CANONICAL_PAYLOAD_BUDGET_POLICY_VERSION_V1,
  acquireFileSessionExecutionLeaseV1,
  createFileDurableJsonPayloadWriterV1,
  createLocationAwarePayloadSessionV1,
  validateCanonicalDurableJsonPayloadPrefixV1,
} from "@paw/runtime";

const roots: string[] = [];
let ownerSequence = 0;
const TEST_PAYLOAD_BUDGET = Object.freeze({
  policyVersion: VERIFIED_CANONICAL_PAYLOAD_BUDGET_POLICY_VERSION_V1,
  maxTotalBytes: 1_000_000,
});

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("location-aware payload Session memory contract", () => {
  test("enforces exact N/N-1 on the full inline candidate before prepare", async () => {
    const value = "inline budget value";
    const exactBytes = payloadBytes(value);

    const allowedSource = new MemorySource();
    const allowedMaterializer = new MemoryMaterializer();
    const allowed = wrapWithBudget(
      allowedSource,
      allowedMaterializer,
      exactBytes,
    );
    expect(
      await allowed.commitInputFacts(0, [
        promotedWithAttachment("budget-allowed", value),
      ]),
    ).toBe("committed");
    expect(allowedMaterializer.prepareCalls).toBe(1);
    expect(allowedSource.inputCommitCalls).toBe(1);

    const deniedSource = new MemorySource();
    const deniedMaterializer = new MemoryMaterializer();
    const denied = wrapWithBudget(
      deniedSource,
      deniedMaterializer,
      exactBytes - 1,
    );
    await expect(
      denied.commitInputFacts(0, [
        promotedWithAttachment("budget-denied", value),
      ]),
    ).rejects.toThrow("total byte budget exceeded");
    expect(deniedMaterializer.prepareCalls).toBe(0);
    expect(deniedSource.inputCommitCalls).toBe(0);
  });

  test("counts legal binding reuse once and equal values at distinct bindings twice", async () => {
    const value = "same budgeted value";
    const exactBytes = payloadBytes(value);

    const reusedSource = new MemorySource();
    const reusedMaterializer = new MemoryMaterializer();
    const reused = wrapWithBudget(reusedSource, reusedMaterializer, exactBytes);
    expect(
      await reused.commitInputFacts(0, [
        acceptedWithAttachment("input-reused", value),
        promotedWithAttachment("input-reused", value, "steer"),
      ]),
    ).toBe("committed");

    const distinctSource = new MemorySource();
    const distinctMaterializer = new MemoryMaterializer();
    const distinct = wrapWithBudget(
      distinctSource,
      distinctMaterializer,
      exactBytes,
    );
    await expect(
      distinct.commitInputFacts(0, [
        promotedWithAttachment("binding-a", value),
        promotedWithAttachment("binding-b", value),
      ]),
    ).rejects.toThrow("total byte budget exceeded");
    expect(distinctMaterializer.prepareCalls).toBe(0);
    expect(distinctSource.inputCommitCalls).toBe(0);

    const twiceSource = new MemorySource();
    const twiceMaterializer = new MemoryMaterializer();
    const twice = wrapWithBudget(
      twiceSource,
      twiceMaterializer,
      exactBytes * 2,
    );
    expect(
      await twice.commitInputFacts(0, [
        promotedWithAttachment("binding-a", value),
        promotedWithAttachment("binding-b", value),
      ]),
    ).toBe("committed");
  });

  test("reapplies the same budget after artifact replacement before commit", async () => {
    const value = "small";
    const largerValue = "a much larger hostile resolved artifact value";
    const source = new MemorySource();
    const materializer = new MemoryMaterializer();
    materializer.resolveValues.push(value, largerValue);
    materializer.hashOverride = hashJson(value);
    const session = wrapWithBudget(source, materializer, payloadBytes(value));

    await expect(
      session.commitInputFacts(0, [
        promotedWithAttachment("post-materialize-budget", value),
      ]),
    ).rejects.toThrow("total byte budget exceeded");
    expect(materializer.prepareCalls).toBe(1);
    expect(materializer.prepared).toHaveLength(1);
    expect(source.inputCommitCalls).toBe(0);
    expect(source.prefix).toHaveLength(0);
  });

  test("revalidates the whole budget after append CAS moves the tail", async () => {
    const value = "retry budget";
    const source = new MemorySource();
    source.inputResults.push("conflict");
    source.onInputConflict = () => {
      source.insertFacts([acceptedWithAttachment("conflicting-input", value)]);
    };
    const materializer = new MemoryMaterializer();
    const session = wrapWithBudget(source, materializer, payloadBytes(value));

    await expect(
      session.appendInputFacts([
        promotedWithAttachment("retried-input", value),
      ]),
    ).rejects.toThrow("total byte budget exceeded");
    expect(source.inputCommitCalls).toBe(1);
    expect(materializer.prepareCalls).toBe(1);
    expect(source.prefix).toHaveLength(1);
    expect(lastFactsFromPrefix(source.prefix)[0]).toMatchObject({
      type: "input.accepted",
      inputId: "conflicting-input",
    });
  });

  test("requires, validates, and freezes one explicit budget before touching ports", async () => {
    let externalGetterReads = 0;
    const hostileSource = Object.create(
      null,
    ) as LocationAwarePayloadSessionSourceV1;
    const hostileMaterializer = Object.create(
      null,
    ) as LocationAwarePayloadMaterializerV1;
    for (const [target, names] of [
      [
        hostileSource,
        [
          "readCanonicalJournalIdentity",
          "readCanonicalPrefix",
          "readInputSnapshot",
          "appendInputFacts",
          "commitInputFacts",
          "commitDerivedDecision",
          "commitDecisionAndInputFacts",
        ],
      ],
      [
        hostileMaterializer,
        ["readCanonicalPayloadIdentity", "prepare", "resolve", "hash"],
      ],
    ] as const) {
      for (const name of names) {
        Object.defineProperty(target, name, {
          configurable: true,
          get() {
            externalGetterReads += 1;
            throw new Error("hostile port getter was touched");
          },
        });
      }
    }
    expect(() =>
      createLocationAwarePayloadSessionV1({
        source: hostileSource,
        sessionId: "session-1",
        runId: "run-1",
        materializer: hostileMaterializer,
        budget: {
          policyVersion: VERIFIED_CANONICAL_PAYLOAD_BUDGET_POLICY_VERSION_V1,
          maxTotalBytes: 0,
        },
      }),
    ).toThrow("positive safe integer");
    expect(externalGetterReads).toBe(0);

    const value = "frozen budget";
    const mutableBudget = {
      policyVersion: VERIFIED_CANONICAL_PAYLOAD_BUDGET_POLICY_VERSION_V1,
      maxTotalBytes: payloadBytes(value),
    };
    const source = new MemorySource();
    const materializer = new MemoryMaterializer();
    const session = createLocationAwarePayloadSessionV1({
      source,
      sessionId: "session-1",
      runId: "run-1",
      materializer,
      budget: mutableBudget,
    });
    mutableBudget.maxTotalBytes = 1;
    expect(
      await session.commitInputFacts(0, [
        promotedWithAttachment("frozen-budget", value),
      ]),
    ).toBe("committed");

    const prefix = [
      inputEnvelope(1, promotedWithAttachment("validator-budget", value)),
    ];
    await expect(
      validateCanonicalDurableJsonPayloadPrefixV1({
        fullPrefix: prefix,
        materializer: new MemoryMaterializer(),
        budget: {
          policyVersion: VERIFIED_CANONICAL_PAYLOAD_BUDGET_POLICY_VERSION_V1,
          maxTotalBytes: payloadBytes(value),
        },
      }),
    ).resolves.toBeUndefined();
    await expect(
      validateCanonicalDurableJsonPayloadPrefixV1({
        fullPrefix: prefix,
        materializer: new MemoryMaterializer(),
        budget: {
          policyVersion: VERIFIED_CANONICAL_PAYLOAD_BUDGET_POLICY_VERSION_V1,
          maxTotalBytes: payloadBytes(value) - 1,
        },
      }),
    ).rejects.toThrow("total byte budget exceeded");

    const compileOnlyBudgetRequirement = () => {
      // @ts-expect-error Location-aware Session budget is intentionally required.
      createLocationAwarePayloadSessionV1({
        source,
        sessionId: "session-1",
        runId: "run-1",
        materializer,
      });
      // @ts-expect-error Prefix validation budget is intentionally required.
      return validateCanonicalDurableJsonPayloadPrefixV1({
        fullPrefix: prefix,
        materializer,
      });
    };
    expect(compileOnlyBudgetRequirement).toBeFunction();
  });

  test("uses empty and decision-separated real journal offsets", async () => {
    const empty = new MemorySource();
    const emptyMaterializer = new MemoryMaterializer();
    const emptySession = wrap(empty, emptyMaterializer);

    await emptySession.appendInputFacts([
      promotedWithAttachment("input-empty", "empty"),
    ]);
    expect(emptyMaterializer.prepared.map((item) => item.binding)).toEqual([
      {
        originSeq: 1,
        field: {
          kind: "input_attachment",
          inputId: "input-empty",
          attachmentId: "attachment-input-empty",
        },
      },
    ]);

    const full = new MemorySource(prefixWithDecisionGap());
    const fullMaterializer = new MemoryMaterializer();
    const fullSession = wrap(full, fullMaterializer);
    const decision = controlDecision(3, "decision-with-fact");
    expect(
      await fullSession.commitDecisionAndInputFacts(3, decision, [
        promotedWithAttachment("input-after-decision", "later"),
      ]),
    ).toBe("committed");
    expect(fullMaterializer.prepared[0]?.binding.originSeq).toBe(5);
    expect(full.prefix[3]?.record.kind).toBe("derived_decision");
    expect(full.prefix[4]?.record.kind).toBe("input_fact");
  });

  test("clones nested facts and decisions synchronously before any await", async () => {
    const source = new MemorySource(modelDispatchPrefix());
    const materializer = new MemoryMaterializer();
    const session = wrap(source, materializer);
    const args = { path: "before.ts", nested: { line: 1 } };
    const call = nativeCall("call-1", 0, args);
    const response = modelResponse([call]);
    const settled = modelSettled(response, true);
    const observed = observedCall(call);

    const commit = session.commitInputFacts(source.tailSeq, [
      settled,
      observed,
    ]);
    args.path = "after.ts";
    args.nested.line = 999;
    (response.toolCalls[0] as { name: string }).name = "mutated.tool";
    (observed.args as { path: string }).path = "mutated-observed.ts";

    expect(await commit).toBe("committed");
    expect(materializer.prepared[0]?.value).toMatchObject({
      toolCalls: [{ name: "workspace.read_file", args: { path: "before.ts" } }],
    });
    expect(lastFacts(source)[1]).toMatchObject({
      type: "tool.call_observed",
      tool: "workspace.read_file",
      args: { path: "before.ts", nested: { line: 1 } },
    });

    const decisionSource = new MemorySource(prefixWithDecisionGap());
    const decisionSession = wrap(decisionSource, new MemoryMaterializer());
    const decision = controlDecision(3, "before_reason");
    const failure: InputFactV1 = {
      type: "runtime.failed",
      area: "runtime",
      errorCode: "E_BEFORE",
      message: "before message",
      retryable: false,
    };
    const decisionCommit = decisionSession.commitDecisionAndInputFacts(
      3,
      decision,
      [failure],
    );
    (decision.action as { reasonCode: string }).reasonCode = "after_reason";
    (failure as { message: string }).message = "after message";
    expect(await decisionCommit).toBe("committed");
    expect(decisionSource.prefix[3]?.record).toMatchObject({
      kind: "derived_decision",
      decision: { action: { reasonCode: "before_reason" } },
    });
    expect(decisionSource.prefix[4]?.record).toMatchObject({
      kind: "input_fact",
      fact: { message: "before message" },
    });
  });

  test("validates existing artifacts before preparing or committing new inline payloads", async () => {
    const materializer = new MemoryMaterializer();
    const binding = attachmentBinding(1, "input-old");
    const oldPayload = materializer.seed("old", binding);
    const source = new MemorySource([
      inputEnvelope(1, promotedWithPayload("input-old", oldPayload)),
    ]);
    materializer.resolveError = new Error("existing artifact is corrupt");
    const session = wrap(source, materializer);

    await expect(
      session.commitInputFacts(1, [promotedWithAttachment("input-new", "new")]),
    ).rejects.toThrow("existing artifact is corrupt");
    expect(materializer.prepared).toHaveLength(0);
    expect(source.inputCommitCalls).toBe(0);
  });

  test("fails semantic payload and native model identity gates before commit", async () => {
    const attachmentSource = new MemorySource();
    const attachmentMaterializer = new MemoryMaterializer();
    const attachmentSession = wrap(attachmentSource, attachmentMaterializer);
    const badAttachment = promotedWithPayload("bad-attachment", {
      kind: "inline",
      value: { not: "text" },
      hash: hashJson({ not: "text" }),
    });
    expect(() =>
      attachmentSession.commitInputFacts(0, [badAttachment]),
    ).toThrow("inline attachment content must be a string");
    expect(attachmentMaterializer.prepared).toHaveLength(0);
    expect(attachmentSource.inputCommitCalls).toBe(0);

    for (const drift of [
      "count",
      "id",
      "name",
      "order",
      "args",
      "argumentsValid",
    ] as const) {
      const source = new MemorySource(modelDispatchPrefix());
      const materializer = new MemoryMaterializer();
      const session = wrap(source, materializer);
      const calls = [
        nativeCall("call-1", 0, { path: "a" }),
        nativeCall("call-2", 1, { path: "b" }),
      ];
      const observations = calls.map(observedCall);
      if (drift === "count") observations.pop();
      if (drift === "id") {
        (observations[0] as { callId: string }).callId = "wrong-id";
      }
      if (drift === "name") {
        (observations[0] as { tool: string }).tool = "wrong.tool";
      }
      if (drift === "order") {
        (observations[0] as { order: number }).order = 1;
      }
      if (drift === "args") {
        (observations[0] as { args: JsonValue }).args = { path: "wrong" };
      }
      if (drift === "argumentsValid") {
        const invalidCall = calls[0];
        if (!invalidCall) throw new Error("invalid call fixture is missing");
        invalidCall.argumentsValid = false;
        invalidCall.args = {};
        invalidCall.rawArguments = "not-json";
      }

      await expect(
        session.commitInputFacts(source.tailSeq, [
          modelSettled(modelResponse(calls), true),
          ...observations,
        ]),
      ).rejects.toThrow();
      expect(materializer.prepared).toHaveLength(0);
      expect(source.inputCommitCalls).toBe(0);
    }

    const checkpointSource = new MemorySource([inputEnvelope(1, attempt())]);
    const checkpointMaterializer = new MemoryMaterializer();
    const checkpointSession = wrap(checkpointSource, checkpointMaterializer);
    expect(() =>
      checkpointSession.commitInputFacts(1, [
        checkpointRecorded("checkpoint-bad", taskCheckpoint([99]), 1, 1),
      ]),
    ).toThrow("outside its covered range");
    expect(checkpointMaterializer.prepared).toHaveLength(0);
    expect(checkpointSource.inputCommitCalls).toBe(0);
  });

  test("materializes equal values separately for different bindings", async () => {
    const source = new MemorySource();
    const materializer = new MemoryMaterializer();
    const session = wrap(source, materializer);

    expect(
      await session.commitInputFacts(0, [
        promotedWithAttachment("input-a", "same"),
        promotedWithAttachment("input-b", "same"),
      ]),
    ).toBe("committed");
    expect(materializer.prepared).toHaveLength(2);
    expect(materializer.prepared[0]?.payload.artifactRef).not.toBe(
      materializer.prepared[1]?.payload.artifactRef,
    );
    expect(lastFacts(source).map(attachmentRef)).toEqual(
      materializer.prepared.map((item) => item.payload.artifactRef),
    );
  });

  test("rejects a self-consistent prepared artifact that changes the inline draft value", async () => {
    const source = new MemorySource();
    const materializer = new MemoryMaterializer();
    materializer.replacePreparedValue = "hostile replacement";
    const session = wrap(source, materializer);

    await expect(
      session.commitInputFacts(0, [
        promotedWithAttachment("input-honest", "honest attachment"),
      ]),
    ).rejects.toThrow();
    expect(materializer.prepareCalls).toBe(1);
    expect(source.inputCommitCalls).toBe(0);
    expect(source.prefix).toHaveLength(0);
  });

  test("keeps accepted/promotion and distilled/recorded reuse on one binding and ref", async () => {
    const inputSource = new MemorySource();
    const inputMaterializer = new MemoryMaterializer();
    const inputSession = wrap(inputSource, inputMaterializer);
    const accepted = acceptedWithAttachment("input-1", "same attachment");
    const promoted = promotedWithAttachment(
      "input-1",
      "same attachment",
      "steer",
    );

    expect(await inputSession.commitInputFacts(0, [accepted, promoted])).toBe(
      "committed",
    );
    expect(inputMaterializer.prepared).toHaveLength(2);
    expect(inputMaterializer.prepared[0]?.binding).toEqual(
      inputMaterializer.prepared[1]?.binding,
    );
    expect(attachmentRef(lastFacts(inputSource)[0])).toBe(
      attachmentRef(lastFacts(inputSource)[1]),
    );

    const claim = checkpointClaim("claim-1", "checkpoint-1", 1, 1);
    const checkpointSource = new MemorySource([
      inputEnvelope(1, attempt()),
      inputEnvelope(2, claim),
    ]);
    const checkpointMaterializer = new MemoryMaterializer();
    const checkpointSession = wrap(checkpointSource, checkpointMaterializer);
    const checkpoint = taskCheckpoint([1]);
    expect(
      await checkpointSession.commitInputFacts(2, [
        {
          type: "context.checkpoint_distillation_settled",
          claimId: "claim-1",
          status: "completed",
          checkpoint: inline(checkpoint),
        },
        {
          ...checkpointRecorded("checkpoint-1", checkpoint, 1, 1),
          distillationClaimId: "claim-1",
        },
      ]),
    ).toBe("committed");
    expect(checkpointMaterializer.prepared[0]?.binding).toEqual(
      checkpointMaterializer.prepared[1]?.binding,
    );
    const checkpointFacts = lastFacts(checkpointSource);
    expect(checkpointRef(checkpointFacts[0])).toBe(
      checkpointRef(checkpointFacts[1]),
    );
  });

  test("explicit CAS conflicts do not prepare or retry", async () => {
    const source = new MemorySource([inputEnvelope(1, attempt())]);
    const materializer = new MemoryMaterializer();
    const session = wrap(source, materializer);
    expect(
      await session.commitInputFacts(0, [
        promotedWithAttachment("input-stale", "stale"),
      ]),
    ).toBe("conflict");
    expect(
      await session.commitDecisionAndInputFacts(
        0,
        controlDecision(1, "stale"),
        [promotedWithAttachment("input-stale-2", "stale")],
      ),
    ).toBe("conflict");
    expect(materializer.prepared).toHaveLength(0);
    expect(source.inputCommitCalls).toBe(0);
    expect(source.decisionAndFactsCommitCalls).toBe(0);

    source.inputResults.push("conflict");
    expect(
      await session.commitInputFacts(1, [
        promotedWithAttachment("input-race", "race"),
      ]),
    ).toBe("conflict");
    expect(materializer.prepared).toHaveLength(1);
    expect(source.inputCommitCalls).toBe(1);
  });

  test("append retries only a CAS conflict with a new origin and leaves the old ref orphaned", async () => {
    const source = new MemorySource();
    source.inputResults.push("conflict", "committed");
    source.onInputConflict = () => source.insertFacts([attempt()]);
    const materializer = new MemoryMaterializer();
    const session = wrap(source, materializer);

    await session.appendInputFacts([
      promotedWithAttachment("input-retry", "retry"),
    ]);
    expect(source.inputCommitCalls).toBe(2);
    expect(source.readPrefixCalls).toBe(2);
    expect(materializer.prepared.map((item) => item.binding.originSeq)).toEqual(
      [1, 2],
    );
    const [oldPreparation, newPreparation] = materializer.prepared;
    if (!oldPreparation || !newPreparation) {
      throw new Error("expected both conflict preparations");
    }
    expect(oldPreparation.payload.artifactRef).not.toBe(
      newPreparation.payload.artifactRef,
    );
    expect(attachmentRef(lastFacts(source)[0])).toBe(
      newPreparation.payload.artifactRef,
    );
    expect(JSON.stringify(source.prefix)).not.toContain(
      oldPreparation?.payload.artifactRef ?? "missing-old-ref",
    );
  });

  test("prepare, resolve, abort, and lease-like commit errors are never retried", async () => {
    const prepareSource = new MemorySource();
    const prepareMaterializer = new MemoryMaterializer();
    prepareMaterializer.prepareError = new Error("prepare failed");
    await expect(
      wrap(prepareSource, prepareMaterializer).appendInputFacts([
        promotedWithAttachment("prepare-error", "value"),
      ]),
    ).rejects.toThrow("prepare failed");
    expect(prepareMaterializer.prepareCalls).toBe(1);
    expect(prepareSource.inputCommitCalls).toBe(0);

    const abortSource = new MemorySource();
    const abortMaterializer = new MemoryMaterializer();
    const controller = new AbortController();
    controller.abort(new Error("aborted"));
    await expect(
      wrap(abortSource, abortMaterializer, controller.signal).appendInputFacts([
        promotedWithAttachment("abort", "value"),
      ]),
    ).rejects.toThrow("aborted");
    expect(abortMaterializer.prepareCalls).toBe(0);
    expect(abortSource.inputCommitCalls).toBe(0);

    const leaseSource = new MemorySource();
    leaseSource.inputResults.push(new Error("lease lost"));
    const leaseMaterializer = new MemoryMaterializer();
    await expect(
      wrap(leaseSource, leaseMaterializer).appendInputFacts([
        promotedWithAttachment("lease", "value"),
      ]),
    ).rejects.toThrow("lease lost");
    expect(leaseMaterializer.prepareCalls).toBe(1);
    expect(leaseSource.inputCommitCalls).toBe(1);
  });

  test("commits model observations and multiple tool settlements as all-or-nothing batches", async () => {
    const modelSource = new MemorySource(modelDispatchPrefix());
    const modelMaterializer = new MemoryMaterializer();
    const modelSession = wrap(modelSource, modelMaterializer);
    const calls = [
      nativeCall("call-1", 0, { path: "a" }),
      nativeCall("call-2", 1, { path: "b" }),
    ];
    expect(
      await modelSession.commitInputFacts(modelSource.tailSeq, [
        modelSettled(modelResponse(calls), true),
        ...calls.map(observedCall),
      ]),
    ).toBe("committed");
    expect(modelSource.committedInputBatches.at(-1)).toHaveLength(3);

    const toolSource = new MemorySource(dispatchedToolPrefix(calls));
    const toolMaterializer = new MemoryMaterializer();
    const toolSession = wrap(toolSource, toolMaterializer);
    expect(
      await toolSession.commitInputFacts(toolSource.tailSeq, [
        toolSettled("call-1", { result: "a" }),
        toolSettled("call-2", { result: "b" }),
      ]),
    ).toBe("committed");
    expect(toolSource.committedInputBatches.at(-1)).toHaveLength(2);
    expect(toolMaterializer.prepared.map((item) => item.binding.field)).toEqual(
      [
        { kind: "tool_observation", callId: "call-1" },
        { kind: "tool_observation", callId: "call-2" },
      ],
    );

    const failingSource = new MemorySource(dispatchedToolPrefix(calls));
    const failingMaterializer = new MemoryMaterializer();
    failingMaterializer.prepareErrorAt = 2;
    await expect(
      wrap(failingSource, failingMaterializer).commitInputFacts(
        failingSource.tailSeq,
        [
          toolSettled("call-1", { result: "a" }),
          toolSettled("call-2", { result: "b" }),
        ],
      ),
    ).rejects.toThrow("prepare failed");
    expect(failingSource.inputCommitCalls).toBe(0);
  });

  test("retains decision idempotency, drift rejection, and derived-tail guards", async () => {
    const source = new MemorySource([inputEnvelope(1, attempt())]);
    const materializer = new MemoryMaterializer();
    const session = wrap(source, materializer);
    const decision = controlDecision(1, "same");
    expect(await session.commitDerivedDecision(1, decision)).toBe("committed");
    expect(await session.commitDerivedDecision(2, decision)).toBe("committed");
    await expect(
      session.commitDerivedDecision(2, controlDecision(1, "drift")),
    ).rejects.toThrow("conflicting derived decision");
    await expect(
      session.commitDecisionAndInputFacts(2, decision, [
        promotedWithAttachment("after-derived", "blocked"),
      ]),
    ).rejects.toThrow("derived decision must immediately follow an input fact");
    expect(materializer.prepared).toHaveLength(0);
    expect(source.decisionAndFactsCommitCalls).toBe(0);
  });

  test("binds identity, captures source methods, validates reads, and hides the raw source", async () => {
    const emptyMismatch = new MemorySource([], "other-session", "run-1");
    const emptyMaterializer = new MemoryMaterializer();
    expect(() => wrap(emptyMismatch, emptyMaterializer)).toThrow(
      "identity mismatch",
    );
    expect(emptyMismatch.identityReads).toBe(1);
    expect(emptyMaterializer.prepareCalls).toBe(0);
    expect(emptyMismatch.inputCommitCalls).toBe(0);

    const nonempty = new MemorySource([
      inputEnvelope(1, attempt(), "other-session", "run-1"),
    ]);
    const nonemptySession = wrap(nonempty, new MemoryMaterializer());
    await expect(nonemptySession.readCanonicalPrefix()).rejects.toThrow(
      "identity mismatch",
    );

    const source = new MemorySource();
    const materializer = new MemoryMaterializer();
    const session = wrap(source, materializer);
    let shadowReads = 0;
    let shadowCommits = 0;
    let shadowSourceIdentityReads = 0;
    let shadowPayloadIdentityReads = 0;
    source.readCanonicalPrefix = async () => {
      shadowReads += 1;
      throw new Error("shadow read must not run");
    };
    source.commitInputFacts = async () => {
      shadowCommits += 1;
      throw new Error("shadow commit must not run");
    };
    source.readCanonicalJournalIdentity = () => {
      shadowSourceIdentityReads += 1;
      return {
        workspaceRoot: "memory://shadow-source",
        sessionId: "session-shadow",
        runId: "run-shadow",
      };
    };
    materializer.readCanonicalPayloadIdentity = () => {
      shadowPayloadIdentityReads += 1;
      return {
        workspaceRoot: "memory://shadow-payload",
        sessionId: "session-shadow",
        runId: "run-shadow",
      };
    };
    expect(
      await session.commitInputFacts(0, [
        promotedWithAttachment("captured", "captured"),
      ]),
    ).toBe("committed");
    expect(shadowReads).toBe(0);
    expect(shadowCommits).toBe(0);
    expect(shadowSourceIdentityReads).toBe(0);
    expect(shadowPayloadIdentityReads).toBe(0);
    expect(Object.keys(session).sort()).toEqual([
      "appendInputFacts",
      "commitDecisionAndInputFacts",
      "commitDerivedDecision",
      "commitInputFacts",
      "readCanonicalPrefix",
      "readCoordinatorOwnershipIdentity",
      "readInputSnapshot",
    ]);
    expect("source" in session).toBeFalse();
    expect("rawSession" in session).toBeFalse();
  });

  test("detaches prepared payloads and source prefix views across async validation", async () => {
    const source = new MemorySource();
    const materializer = new MemoryMaterializer();
    materializer.mutatePreparedDuringResolve = true;
    const session = wrap(source, materializer);
    expect(
      await session.commitInputFacts(0, [
        promotedWithAttachment("toctou-prepared", "stable"),
      ]),
    ).toBe("committed");
    const committedRef = attachmentRef(lastFacts(source)[0]);
    if (!materializer.originalPreparedRef) {
      throw new Error("expected the original prepared ref");
    }
    expect(committedRef).toBe(materializer.originalPreparedRef);
    expect(committedRef).not.toBe(materializer.mutatedPreparedRef);

    const prefixMaterializer = new MemoryMaterializer();
    const oldBinding = attachmentBinding(1, "input-old");
    const oldPayload = prefixMaterializer.seed("old", oldBinding);
    const prefixSource = new MemorySource([
      inputEnvelope(1, promotedWithPayload("input-old", oldPayload)),
    ]);
    prefixSource.returnMutableView = true;
    prefixMaterializer.onResolve = () => prefixSource.mutateLastReadView();
    const prefixSession = wrap(prefixSource, prefixMaterializer);
    expect(
      await prefixSession.commitInputFacts(1, [runtimeFailure("new fact")]),
    ).toBe("committed");
    expect(prefixSource.inputCommitCalls).toBe(1);
    expect(prefixSource.prefix[0]?.record).toMatchObject({
      kind: "input_fact",
      fact: { type: "input.promoted", content: "initial-input-old" },
    });
  });
});

describe("location-aware payload Session with FileRunSession", () => {
  test("rejects a real payload writer bound to another canonical owner before publication", async () => {
    const cases = [
      {
        label: "workspace",
        sourceRoot: tempRoot(),
        payloadRoot: tempRoot(),
        sourceSessionId: "session-a",
        payloadSessionId: "session-a",
        sourceRunId: "run-a",
        payloadRunId: "run-a",
      },
      {
        label: "session",
        sourceRoot: tempRoot(),
        payloadRoot: undefined,
        sourceSessionId: "session-a",
        payloadSessionId: "session-b",
        sourceRunId: "run-a",
        payloadRunId: "run-a",
      },
      {
        label: "run",
        sourceRoot: tempRoot(),
        payloadRoot: undefined,
        sourceSessionId: "session-a",
        payloadSessionId: "session-a",
        sourceRunId: "run-a",
        payloadRunId: "run-b",
      },
    ] as const;

    for (const fixture of cases) {
      const payloadRoot = fixture.payloadRoot ?? fixture.sourceRoot;
      const payloadLease = acquireLease(
        payloadRoot,
        fixture.payloadSessionId,
        fixture.payloadRunId,
      );
      const writer = createFileDurableJsonPayloadWriterV1({
        workspaceRoot: payloadRoot,
        sessionId: fixture.payloadSessionId,
        runId: fixture.payloadRunId,
        executionLease: payloadLease,
        policy: DEFAULT_FILE_DURABLE_JSON_PAYLOAD_POLICY_V1,
      });
      if (
        fixture.sourceRoot === payloadRoot &&
        fixture.sourceSessionId === fixture.payloadSessionId
      ) {
        expect(await payloadLease.release()).toBe("released");
      }

      const sourceLease = acquireLease(
        fixture.sourceRoot,
        fixture.sourceSessionId,
        fixture.sourceRunId,
      );
      const source = new FileRunSessionV1({
        workspaceRoot: fixture.sourceRoot,
        sessionId: fixture.sourceSessionId,
        runId: fixture.sourceRunId,
        executionLease: sourceLease,
        clock: () => 42,
      });

      expect(() =>
        createLocationAwarePayloadSessionV1({
          source,
          sessionId: fixture.sourceSessionId,
          runId: fixture.sourceRunId,
          materializer: writer,
          budget: TEST_PAYLOAD_BUDGET,
        }),
      ).toThrow("owner identity mismatch");
      expect(await source.readCanonicalPrefix(), fixture.label).toEqual([]);
      expect(
        fs.existsSync(
          path.join(payloadRoot, ".paw", "paw-next", "durable-json-payloads"),
        ),
        fixture.label,
      ).toBeFalse();

      source.close();
      await sourceLease.release();
      if (
        fixture.sourceRoot !== payloadRoot ||
        fixture.sourceSessionId !== fixture.payloadSessionId
      ) {
        await payloadLease.release();
      }
    }
  });

  test("captures a real writer identity capability against later public shadowing", async () => {
    const root = tempRoot();
    const lease = acquireLease(root);
    const source = new FileRunSessionV1({
      workspaceRoot: root,
      sessionId: "session-1",
      runId: "run-1",
      executionLease: lease,
      clock: () => 42,
    });
    const writer = createFileDurableJsonPayloadWriterV1({
      workspaceRoot: root,
      sessionId: "session-1",
      runId: "run-1",
      executionLease: lease,
      policy: DEFAULT_FILE_DURABLE_JSON_PAYLOAD_POLICY_V1,
    });
    const publicIdentity = writer.readCanonicalPayloadIdentity();
    expect(Object.isFrozen(publicIdentity)).toBeTrue();
    expect(
      Reflect.set(publicIdentity as object, "runId", "shadow-run"),
    ).toBeFalse();

    const mutableFacade: LocationAwarePayloadMaterializerV1 = {
      readCanonicalPayloadIdentity: writer.readCanonicalPayloadIdentity,
      prepare: writer.prepare,
      resolve: writer.resolve,
      hash: writer.hash,
    };
    const session = createLocationAwarePayloadSessionV1({
      source,
      sessionId: "session-1",
      runId: "run-1",
      materializer: mutableFacade,
      budget: TEST_PAYLOAD_BUDGET,
    });
    let shadowIdentityReads = 0;
    mutableFacade.readCanonicalPayloadIdentity = () => {
      shadowIdentityReads += 1;
      return {
        workspaceRoot: root,
        sessionId: "shadow-session",
        runId: "shadow-run",
      };
    };

    expect(
      await session.commitInputFacts(0, [
        promotedWithAttachment("identity-shadow", "stable"),
      ]),
    ).toBe("committed");
    expect(shadowIdentityReads).toBe(0);
    expect((await source.readCanonicalPrefix()).at(-1)?.seq).toBe(1);
    source.close();
    await lease.release();
  });

  test("recovers one artifact-bearing fact committed before an in-memory crash", async () => {
    const root = tempRoot();
    const lease = acquireLease(root);
    const crashedSource = new FileRunSessionV1({
      workspaceRoot: root,
      sessionId: "session-1",
      runId: "run-1",
      executionLease: lease,
      clock: () => 42,
      commitHooks: {
        afterJournalLinearized() {
          throw new Error("simulated crash after fact authority commit");
        },
      },
    });
    const writer = createFileDurableJsonPayloadWriterV1({
      workspaceRoot: root,
      sessionId: "session-1",
      runId: "run-1",
      executionLease: lease,
      policy: DEFAULT_FILE_DURABLE_JSON_PAYLOAD_POLICY_V1,
    });
    const crashed = createLocationAwarePayloadSessionV1({
      source: crashedSource,
      sessionId: "session-1",
      runId: "run-1",
      materializer: writer,
      budget: TEST_PAYLOAD_BUDGET,
    });
    await expect(
      crashed.appendInputFacts([
        promotedWithAttachment("input-crash", "durable"),
      ]),
    ).rejects.toBeInstanceOf(SessionExecutionLeaseLostError);

    const recoveredSource = new FileRunSessionV1({
      workspaceRoot: root,
      sessionId: "session-1",
      runId: "run-1",
      executionLease: lease,
      clock: () => 42,
    });
    const recovered = createLocationAwarePayloadSessionV1({
      source: recoveredSource,
      sessionId: "session-1",
      runId: "run-1",
      materializer: writer,
      budget: TEST_PAYLOAD_BUDGET,
    });
    const prefix = await recovered.readCanonicalPrefix();
    expect(prefix).toHaveLength(1);
    expect(prefix[0]?.record).toMatchObject({
      kind: "input_fact",
      fact: { type: "input.promoted", inputId: "input-crash" },
    });
    expect(attachmentRef(lastFactsFromPrefix(prefix)[0])).toMatch(
      /^paw-payload:v1:[0-9a-f]{64}$/,
    );
    recoveredSource.close();
  });
});

class MemorySource implements LocationAwarePayloadSessionSourceV1 {
  prefix: RunJournalEnvelopeV1[];
  identityReads = 0;
  readPrefixCalls = 0;
  inputCommitCalls = 0;
  decisionAndFactsCommitCalls = 0;
  committedInputBatches: InputFactV1[][] = [];
  inputResults: Array<"committed" | "conflict" | Error> = [];
  onInputConflict?: () => void;
  returnMutableView = false;
  lastReadView?: RunJournalEnvelopeV1[];

  constructor(
    prefix: readonly RunJournalEnvelopeV1[] = [],
    readonly sessionId = "session-1",
    readonly runId = "run-1",
    readonly workspaceRoot = "memory://workspace",
  ) {
    this.prefix = [...clone(prefix)];
  }

  get tailSeq(): number {
    return this.prefix.at(-1)?.seq ?? 0;
  }

  readCanonicalJournalIdentity() {
    this.identityReads += 1;
    return {
      workspaceRoot: this.workspaceRoot,
      sessionId: this.sessionId,
      runId: this.runId,
    };
  }

  readCoordinatorOwnershipIdentity(): string {
    return `${this.sessionId}:${this.runId}`;
  }

  async readCanonicalPrefix(): Promise<readonly RunJournalEnvelopeV1[]> {
    this.readPrefixCalls += 1;
    if (!this.returnMutableView) return this.prefix;
    this.lastReadView = clone(this.prefix);
    return this.lastReadView;
  }

  mutateLastReadView(): void {
    const envelope = this.lastReadView?.[0];
    if (
      envelope?.record.kind === "input_fact" &&
      envelope.record.fact.type === "input.promoted"
    ) {
      (envelope.record.fact as { content: string }).content =
        "hostile mutation";
    }
  }

  async readInputSnapshot(): Promise<SessionInputSnapshot<InputFactV1>> {
    const entries = this.prefix.flatMap((item) =>
      item.record.kind === "input_fact"
        ? [{ seq: item.seq, fact: item.record.fact }]
        : [],
    );
    return {
      entries,
      tailSeq: this.tailSeq,
      latestInputSeq: entries.at(-1)?.seq ?? 0,
    };
  }

  async appendInputFacts(facts: readonly InputFactV1[]): Promise<void> {
    const status = await this.commitInputFacts(this.tailSeq, facts);
    if (status === "conflict") throw new Error("source append conflict");
  }

  async commitInputFacts(
    expectedTailSeq: number,
    facts: readonly InputFactV1[],
  ): Promise<"committed" | "conflict"> {
    this.inputCommitCalls += 1;
    this.committedInputBatches.push([...clone(facts)]);
    const next = this.inputResults.shift();
    if (next instanceof Error) throw next;
    if (this.tailSeq !== expectedTailSeq || next === "conflict") {
      this.onInputConflict?.();
      this.onInputConflict = undefined;
      return "conflict";
    }
    this.insertFacts(facts);
    return "committed";
  }

  async commitDerivedDecision(
    expectedTailSeq: number,
    decision: DerivedDecisionV1,
  ): Promise<"committed" | "conflict"> {
    if (this.tailSeq !== expectedTailSeq) return "conflict";
    const latest = this.prefix.at(-1);
    if (latest?.record.kind === "derived_decision") {
      if (
        canonicalJson(latest.record.decision as unknown as JsonValue) ===
        canonicalJson(decision as unknown as JsonValue)
      ) {
        return "committed";
      }
      throw new Error("tail has a conflicting derived decision");
    }
    this.insertRecords([{ kind: "derived_decision", decision }]);
    return "committed";
  }

  async commitDecisionAndInputFacts(
    expectedTailSeq: number,
    decision: DerivedDecisionV1,
    facts: readonly InputFactV1[],
  ): Promise<"committed" | "conflict"> {
    this.decisionAndFactsCommitCalls += 1;
    if (this.tailSeq !== expectedTailSeq) return "conflict";
    this.insertRecords([
      { kind: "derived_decision", decision },
      ...facts.map((fact) => ({ kind: "input_fact" as const, fact })),
    ]);
    return "committed";
  }

  insertFacts(facts: readonly InputFactV1[]): void {
    this.insertRecords(
      facts.map((fact) => ({ kind: "input_fact" as const, fact })),
    );
  }

  private insertRecords(
    records: readonly RunJournalEnvelopeV1["record"][],
  ): void {
    const appended = records.map((record, index) =>
      journalEnvelope(
        this.tailSeq + index + 1,
        record,
        this.sessionId,
        this.runId,
      ),
    );
    this.prefix = [
      ...clone(parseRunJournalPrefixV1([...this.prefix, ...appended])),
    ];
  }
}

class MemoryMaterializer implements LocationAwarePayloadMaterializerV1 {
  readonly stored = new Map<
    string,
    { value: JsonValue; binding: DurableJsonPayloadBindingV1 }
  >();
  readonly prepared: Array<{
    value: JsonValue;
    binding: DurableJsonPayloadBindingV1;
    payload: Extract<DurableJsonPayloadV1, { kind: "artifact_ref" }>;
  }> = [];
  prepareCalls = 0;
  resolveCalls = 0;
  prepareError?: Error;
  resolveError?: Error;
  prepareErrorAt?: number;
  onResolve?: () => void;
  mutatePreparedDuringResolve = false;
  replacePreparedValue?: JsonValue;
  readonly resolveValues: JsonValue[] = [];
  hashOverride?: string;
  mutablePrepared?: {
    kind: "artifact_ref";
    artifactRef: string;
    hash: string;
  };
  originalPreparedRef?: string;
  mutatedPreparedRef = `paw-payload:v1:${"f".repeat(64)}`;

  readCanonicalPayloadIdentity() {
    return {
      workspaceRoot: "memory://workspace",
      sessionId: "session-1",
      runId: "run-1",
    };
  }

  async prepare(
    value: JsonValue,
    binding: DurableJsonPayloadBindingV1,
  ): Promise<DurableJsonPayloadV1> {
    this.prepareCalls += 1;
    if (
      this.prepareError ||
      (this.prepareErrorAt !== undefined &&
        this.prepareCalls === this.prepareErrorAt)
    ) {
      throw this.prepareError ?? new Error("prepare failed");
    }
    const storedValue = this.replacePreparedValue ?? value;
    const payload = this.store(storedValue, binding);
    this.prepared.push({
      value: clone(storedValue),
      binding: clone(binding),
      payload,
    });
    if (!this.mutatePreparedDuringResolve) return payload;
    this.mutablePrepared = { ...payload };
    this.originalPreparedRef = payload.artifactRef;
    return this.mutablePrepared;
  }

  async resolve(
    payload: DurableJsonPayloadV1,
    expectedBinding: DurableJsonPayloadBindingV1,
  ): Promise<JsonValue> {
    this.resolveCalls += 1;
    this.onResolve?.();
    this.onResolve = undefined;
    if (this.mutatePreparedDuringResolve && this.mutablePrepared) {
      this.mutablePrepared.artifactRef = this.mutatedPreparedRef;
      this.mutablePrepared.hash = "e".repeat(64);
    }
    if (this.resolveError) throw this.resolveError;
    if (payload.kind !== "artifact_ref") throw new Error("expected artifact");
    const item = this.stored.get(payload.artifactRef);
    if (!item) throw new Error("artifact is missing");
    if (
      canonicalJson(item.binding as unknown as JsonValue) !==
      canonicalJson(expectedBinding as unknown as JsonValue)
    ) {
      throw new Error("artifact binding mismatch");
    }
    return clone(this.resolveValues.shift() ?? item.value);
  }

  hash(value: JsonValue): string {
    return this.hashOverride ?? hashJson(value);
  }

  seed(
    value: JsonValue,
    binding: DurableJsonPayloadBindingV1,
  ): Extract<DurableJsonPayloadV1, { kind: "artifact_ref" }> {
    return this.store(value, binding);
  }

  private store(
    value: JsonValue,
    binding: DurableJsonPayloadBindingV1,
  ): Extract<DurableJsonPayloadV1, { kind: "artifact_ref" }> {
    const artifactHash = hashJson({ binding, value } as unknown as JsonValue);
    const payload = {
      kind: "artifact_ref" as const,
      artifactRef: `paw-payload:v1:${artifactHash}`,
      hash: hashJson(value),
    };
    this.stored.set(payload.artifactRef, {
      value: clone(value),
      binding: clone(binding),
    });
    return payload;
  }
}

function wrap(
  source: MemorySource,
  materializer: MemoryMaterializer,
  signal?: AbortSignal,
) {
  return createLocationAwarePayloadSessionV1({
    source,
    sessionId: "session-1",
    runId: "run-1",
    materializer,
    budget: TEST_PAYLOAD_BUDGET,
    ...(signal ? { signal } : {}),
  });
}

function wrapWithBudget(
  source: MemorySource,
  materializer: MemoryMaterializer,
  maxTotalBytes: number,
) {
  return createLocationAwarePayloadSessionV1({
    source,
    sessionId: "session-1",
    runId: "run-1",
    materializer,
    budget: {
      policyVersion: VERIFIED_CANONICAL_PAYLOAD_BUDGET_POLICY_VERSION_V1,
      maxTotalBytes,
    },
  });
}

function inputEnvelope(
  seq: number,
  fact: InputFactV1,
  sessionId = "session-1",
  runId = "run-1",
): RunJournalEnvelopeV1 {
  return journalEnvelope(seq, { kind: "input_fact", fact }, sessionId, runId);
}

function journalEnvelope(
  seq: number,
  record: RunJournalEnvelopeV1["record"],
  sessionId = "session-1",
  runId = "run-1",
): RunJournalEnvelopeV1 {
  return {
    schemaVersion: RUN_JOURNAL_SCHEMA_VERSION_V1,
    sessionId,
    runId,
    seq,
    ts: seq,
    record,
  };
}

function prefixWithDecisionGap(): readonly RunJournalEnvelopeV1[] {
  return [
    inputEnvelope(1, attempt()),
    journalEnvelope(2, {
      kind: "derived_decision",
      decision: controlDecision(1, "earlier"),
    }),
    inputEnvelope(3, runtimeFailure("tail input")),
  ];
}

function modelDispatchPrefix(): readonly RunJournalEnvelopeV1[] {
  return [
    inputEnvelope(1, attempt()),
    inputEnvelope(2, {
      type: "model.dispatch_recorded",
      modelCallId: "model-1",
      turn: 1,
      requestHash: "request-hash",
    }),
  ];
}

function dispatchedToolPrefix(
  calls: readonly ReturnType<typeof nativeCall>[],
): readonly RunJournalEnvelopeV1[] {
  const facts: InputFactV1[] = [
    attempt(),
    {
      type: "model.dispatch_recorded",
      modelCallId: "model-1",
      turn: 1,
      requestHash: "request-hash",
    },
    modelSettled(modelResponse(calls), true),
    ...calls.map(observedCall),
    ...calls.map(
      (call): InputFactV1 => ({
        type: "tool.dispatch_recorded",
        callId: call.callId,
        turn: 1,
        sourceIndex: call.sourceIndex,
        batchId: "batch-1",
        mode: "parallel",
      }),
    ),
    ...calls.map(
      (call): InputFactV1 => ({
        type: "tool.permission_resolved",
        turn: 1,
        sourceIndex: call.sourceIndex,
        callId: call.callId,
        tool: call.name,
        policyVersion: "policy-v1",
        resolution: "allow_once",
        source: "base_policy",
      }),
    ),
  ];
  return facts.map((fact, index) => inputEnvelope(index + 1, fact));
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

function acceptedWithAttachment(inputId: string, value: string): InputFactV1 {
  return {
    type: "input.accepted",
    inputId,
    delivery: "steer",
    content: `initial-${inputId}`,
    contentHash: `hash-${inputId}`,
    callerId: "caller-1",
    attachments: [attachment(inputId, inline(value))],
  };
}

function promotedWithAttachment(
  inputId: string,
  value: string,
  delivery: "initial" | "steer" = "initial",
): InputFactV1 {
  return {
    type: "input.promoted",
    inputId,
    delivery,
    content: `initial-${inputId}`,
    contentHash: `hash-${inputId}`,
    attachments: [attachment(inputId, inline(value))],
  };
}

function promotedWithPayload(
  inputId: string,
  payload: DurableJsonPayloadV1,
): InputFactV1 {
  return {
    type: "input.promoted",
    inputId,
    delivery: "initial",
    content: `initial-${inputId}`,
    contentHash: `hash-${inputId}`,
    attachments: [attachment(inputId, payload)],
  };
}

function attachment(inputId: string, content: DurableJsonPayloadV1) {
  return {
    attachmentId: `attachment-${inputId}`,
    type: "file" as const,
    name: `${inputId}.txt`,
    content,
  };
}

function attachmentBinding(originSeq: number, inputId: string) {
  return {
    originSeq,
    field: {
      kind: "input_attachment" as const,
      inputId,
      attachmentId: `attachment-${inputId}`,
    },
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

function modelSettled(
  response: ReturnType<typeof modelResponse>,
  hasToolCalls: boolean,
): InputFactV1 {
  return {
    type: "model.settled",
    modelCallId: "model-1",
    turn: 1,
    status: "completed",
    hasToolCalls,
    hasVisibleOutput: false,
    response: inline(response),
  };
}

function observedCall(
  call: ReturnType<typeof nativeCall>,
): Extract<InputFactV1, { type: "tool.call_observed" }> {
  return {
    type: "tool.call_observed",
    callId: call.callId,
    modelCallId: "model-1",
    turn: 1,
    tool: call.name,
    args: call.args,
    order: call.sourceIndex,
  };
}

function toolSettled(callId: string, value: JsonValue): InputFactV1 {
  return {
    type: "tool.settled",
    callId,
    status: "completed",
    observation: {
      schemaVersion: "paw.tool-observation.v1",
      summary: callId,
      isError: false,
      payload: inline(value),
    },
  };
}

function checkpointClaim(
  claimId: string,
  checkpointId: string,
  sourceFromSeq: number,
  sourceThroughSeq: number,
): InputFactV1 {
  return {
    type: "context.checkpoint_distillation_claimed",
    claimId,
    checkpointId,
    boundary: "after_model_turn_without_tool_calls",
    policyVersion: "checkpoint-policy-v1",
    sourceFromSeq,
    sourceThroughSeq,
    sourceInputHash: "source-hash",
  };
}

function checkpointRecorded(
  checkpointId: string,
  checkpoint: ReturnType<typeof taskCheckpoint>,
  sourceFromSeq: number,
  sourceThroughSeq: number,
): Extract<InputFactV1, { type: "context.checkpoint_recorded" }> {
  return {
    type: "context.checkpoint_recorded",
    checkpointId,
    policyVersion: "checkpoint-policy-v1",
    sourceFromSeq,
    sourceThroughSeq,
    sourceInputHash: "source-hash",
    checkpoint: inline(checkpoint),
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
  return { kind: "inline", value, hash: hashJson(value) };
}

function controlDecision(
  inputThroughSeq: number,
  reasonCode: string,
): DerivedDecisionV1 {
  return {
    type: "control.decided",
    reducerVersion: "test-reducer-v1",
    inputThroughSeq,
    stateHash: `state-${inputThroughSeq}`,
    action: { kind: "continue", reasonCode },
  };
}

function lastFacts(source: MemorySource): readonly InputFactV1[] {
  return source.committedInputBatches.at(-1) ?? [];
}

function lastFactsFromPrefix(
  prefix: readonly RunJournalEnvelopeV1[],
): readonly InputFactV1[] {
  return prefix.flatMap((item) =>
    item.record.kind === "input_fact" ? [item.record.fact] : [],
  );
}

function attachmentRef(fact: InputFactV1 | undefined): string {
  if (
    !fact ||
    (fact.type !== "input.promoted" && fact.type !== "input.accepted")
  ) {
    throw new Error("expected input attachment fact");
  }
  const payload = fact.attachments?.[0]?.content;
  if (payload?.kind !== "artifact_ref") throw new Error("expected artifact");
  return payload.artifactRef;
}

function checkpointRef(fact: InputFactV1 | undefined): string {
  if (
    !fact ||
    (fact.type !== "context.checkpoint_distillation_settled" &&
      fact.type !== "context.checkpoint_recorded")
  ) {
    throw new Error("expected checkpoint fact");
  }
  const payload = fact.checkpoint;
  if (payload?.kind !== "artifact_ref") throw new Error("expected artifact");
  return payload.artifactRef;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function hashJson(value: JsonValue): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function payloadBytes(value: JsonValue): number {
  return Buffer.byteLength(canonicalJson(value), "utf8");
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

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-location-session-"));
  roots.push(root);
  return root;
}

function acquireLease(
  root: string,
  sessionId = "session-1",
  runId = "run-1",
): FileSessionExecutionLeaseV1 {
  ownerSequence += 1;
  const result = acquireFileSessionExecutionLeaseV1({
    workspaceRoot: root,
    sessionId,
    runId,
    ownerId: `location-owner-${ownerSequence}`,
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
