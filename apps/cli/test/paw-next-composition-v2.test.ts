import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import { createInteractiveControlReducerV2 } from "@paw/agent-loop";
import {
  createAdaptiveCollaborationLauncherV1,
  createBoundedSubAgentLauncherV1,
  createDurableCollaborationCoordinatorV1,
  normalizeCollaborationDelegationV1,
  parseCollaborationAgentSpecV1,
} from "@paw/collaboration";
import {
  COMPLETION_REVIEWER_POLICY_VERSION_V1,
  COMPLETION_REVIEW_FEEDBACK_CALLER_ID_V1,
  completionReviewFeedbackInputIdV1,
  createCompletionReviewFeedbackV1,
} from "@paw/completion-review";
import { CostTracker } from "@paw/core";
import type { SubAgentLauncher } from "@paw/harness";
import {
  type MemoryToolEventV1,
  PAW_NEXT_MEMORY_PLUGIN_POLICY_VERSION_V1,
  PAW_NEXT_MEMORY_V2_PROVIDER_VERSION_V1,
} from "@paw/memory-plugin";
import type {
  ChatMessage,
  LanguageModel,
  ModelCompleteOptions,
  ModelCompletionResult,
  NativeToolCall,
} from "@paw/models";
import {
  COMPLETION_REVIEW_POLICY_VERSION_V1,
  type InputFactV1,
  WORK_SEGMENT_POLICY_VERSION_V1,
} from "@paw/protocol";
import {
  CANONICAL_DURABLE_JSON_PAYLOAD_BINDING_VERSION_V1,
  FILE_DURABLE_JSON_PAYLOAD_CODEC_V1,
  FILE_DURABLE_JSON_PAYLOAD_POLICY_VERSION_V1,
  FileRunSessionV1,
  LOCATION_AWARE_PAYLOAD_MATERIALIZER_VERSION_V1,
  LOCATION_AWARE_PAYLOAD_SESSION_VERSION_V1,
  type SessionLeaseScheduledTaskV1,
  type SessionLeaseSchedulerV1,
  VERIFIED_CANONICAL_PAYLOAD_BUDGET_POLICY_VERSION_V1,
  acquireFileSessionExecutionLeaseV1,
  createFileDurableJsonPayloadReaderV1,
  createFileDurableJsonPayloadWriterV1,
  createLocationAwarePayloadSessionV1,
  projectCanonicalDurableJsonPayloadBindingsV1,
  readCommittedFileRunPrefixV1,
  readFileSessionJournalCommitIndexV1,
} from "@paw/runtime";

import { loadPawNextCollaborationRosterV1 } from "../src/paw-next/collaboration-roster-adapter.js";
import {
  type PawModelSettlementTelemetryV1,
  classifyPawNextExistingPrefixV3,
  preparePawNextProductRuntimeV1,
  runExistingPawNextTaskV2,
  runExistingPawNextTaskV3,
  runExistingPawNextWorkSegmentV3,
  runFreshPawNextTaskV1,
  runFreshPawNextTaskV2,
  runFreshPawNextTaskV3,
  runPawNextChildV3,
  runPawNextReadOnlyChildV3,
} from "../src/paw-next/composition.js";
import { runPawNextNewWorkCliV3 } from "../src/paw-next/new-work-cli-v3.js";
import {
  hashCanonicalJsonV1,
  toFrozenJsonValueV1,
} from "../src/paw-next/product-manifest.js";
import { createPawNextProductProfileCatalogV3 } from "../src/paw-next/product-profile-catalog-v3.js";
import {
  type BuiltPawNextTaskProfileV2,
  DEFAULT_PAW_NEXT_PRODUCT_PROFILE_FILE_V2,
  PAW_NEXT_PRODUCT_PROFILE_SCHEMA_VERSION_V2,
  buildPawNextTaskProfileV2,
} from "../src/paw-next/product-profile-v2.js";
import {
  type BuiltPawNextTaskProfileV3,
  DEFAULT_PAW_NEXT_PRODUCT_PROFILE_FILE_V3,
  PAW_NEXT_PRODUCT_PROFILE_SCHEMA_VERSION_V3,
  buildPawNextTaskProfileV3,
} from "../src/paw-next/product-profile-v3.js";
import {
  DEFAULT_PAW_NEXT_PRODUCT_PROFILE_FILE_V1,
  PAW_NEXT_PRODUCT_PROFILE_SCHEMA_VERSION_V1,
  buildPawNextTaskOptionsFromProfileV1,
} from "../src/paw-next/product-profile.js";
import { runPawNextStartupCliV2 } from "../src/paw-next/startup-cli-v2.js";
import { runPawNextStartupCliV3 } from "../src/paw-next/startup-cli-v3.js";
import { scanAndResumePawNextRunsWithCatalogV1 } from "../src/paw-next/startup-scan.js";

const roots: string[] = [];
const API_KEY = "test-profile-secret";

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("Paw Next V2 Fresh composition", () => {
  test("materializes model and tool evidence at canonical locations and replays the same Context", async () => {
    const root = workspace();
    fs.writeFileSync(path.join(root, "evidence.txt"), "artifact-evidence\n");
    const identity = taskIdentity(root, "artifact-roundtrip");
    const v2Model = new ScriptedModel([
      toolResponse("read-evidence", "workspace_read_file", {
        path: "evidence.txt",
      }),
      finalResponse("artifact final"),
    ]);
    const resolution = resolutionWithModel(identity, v2Model);

    const result = await runFreshPawNextTaskV2({ resolution });
    expect(result.state.decision.kind).toBe("completed");
    expect(result.assistantText).toBe("artifact final");
    expect(v2Model.requests).toHaveLength(2);
    expect(attemptConfigHash(result.inputFacts)).toBe(resolution.configHash);

    const prefix = committedPrefix(identity);
    const occurrences = projectCanonicalDurableJsonPayloadBindingsV1(prefix);
    const modelResponses = occurrences.filter(
      (item) => item.location.kind === "model_response",
    );
    const toolObservations = occurrences.filter(
      (item) => item.location.kind === "tool_observation",
    );
    expect(modelResponses).toHaveLength(2);
    expect(toolObservations).toHaveLength(1);
    expect([...modelResponses, ...toolObservations]).toSatisfy(
      (items: typeof occurrences) =>
        items.every(
          (item) =>
            item.payload.kind === "artifact_ref" &&
            item.binding.originSeq === item.location.carrierSeq,
        ),
    );
    expect(
      occurrences.some(
        (item) =>
          (item.location.kind === "model_response" ||
            item.location.kind === "tool_observation") &&
          item.payload.kind === "inline",
      ),
    ).toBeFalse();

    const reopened = createFileDurableJsonPayloadReaderV1({
      workspaceRoot: root,
      sessionId: identity.sessionId,
      runId: identity.runId,
      policy: resolution.taskOptions.payloadRuntime.storePolicy,
    });
    for (const occurrence of [...modelResponses, ...toolObservations]) {
      const value = await reopened.resolve(
        occurrence.payload,
        occurrence.binding,
      );
      expect(value).toBeDefined();
    }

    const inlineModel = new ScriptedModel(
      [
        toolResponse("read-evidence", "workspace_read_file", {
          path: "evidence.txt",
        }),
        finalResponse("artifact final"),
      ],
      resolution.taskOptions.model,
    );
    const task = resolution.taskOptions;
    await runFreshPawNextTaskV1({
      workspaceRoot: root,
      sessionId: "session-inline-equivalent",
      runId: "run-inline-equivalent",
      inputId: "input-inline-equivalent",
      goal: identity.goal,
      model: inlineModel,
      profileIdentity: task.profileIdentity,
      credentialBindingHash: task.credentialBindingHash,
      providerProtocol: task.providerProtocol,
      transport: task.transport,
      permissionConfig: task.permissionConfig,
      systemPrompt: task.systemPrompt,
      maxModelTurns: task.maxModelTurns,
      naturalStop: task.naturalStop,
      contextWindowTokens: task.contextWindowTokens,
      reservedOutputTokens: task.reservedOutputTokens,
      estimationMarginTokens: task.estimationMarginTokens,
      estimatorId: task.estimatorId,
      estimatorVersion: task.estimatorVersion,
      heartbeatPolicy: task.heartbeatPolicy,
    });
    expect(v2Model.requests[1]).toEqual(inlineModel.requests[1]);
  }, 15_000);

  test("rejects invalid store and read budgets before lease, journal, blob, or model activity", async () => {
    for (const [label, mutate] of [
      [
        "store",
        (resolution: BuiltPawNextTaskProfileV2) => ({
          ...resolution.taskOptions.payloadRuntime,
          storePolicy: {
            ...resolution.taskOptions.payloadRuntime.storePolicy,
            maxArtifactBytes: 0,
          },
        }),
      ],
      [
        "budget",
        (resolution: BuiltPawNextTaskProfileV2) => ({
          ...resolution.taskOptions.payloadRuntime,
          readBudget: {
            ...resolution.taskOptions.payloadRuntime.readBudget,
            maxTotalBytes: 0,
          },
        }),
      ],
    ] as const) {
      const root = workspace();
      const identity = taskIdentity(root, `invalid-${label}`);
      const model = new ScriptedModel([finalResponse("must not run")]);
      const valid = resolutionWithModel(identity, model);
      const invalid = {
        ...valid,
        taskOptions: {
          ...valid.taskOptions,
          payloadRuntime: mutate(valid),
        },
      } as BuiltPawNextTaskProfileV2;
      const before = rawTree(root);

      await expect(
        runFreshPawNextTaskV2({ resolution: invalid }),
      ).rejects.toThrow();
      expect(model.requests).toHaveLength(0);
      expect(rawTree(root)).toEqual(before);
      expect(
        fs.existsSync(
          path.join(root, ".paw", "paw-next", "durable-json-payloads"),
        ),
      ).toBeFalse();
    }
  });

  test("rejects drifted V2 profile and manifest identity before any execution state", async () => {
    for (const [label, drift] of [
      [
        "profile",
        (resolution: BuiltPawNextTaskProfileV2) => ({
          ...resolution,
          profile: {
            ...resolution.profile,
            configHash: "f".repeat(64),
          },
        }),
      ],
      [
        "manifest",
        (resolution: BuiltPawNextTaskProfileV2) => ({
          ...resolution,
          manifest: {
            ...resolution.manifest,
            systemPromptHash: "f".repeat(64),
          },
        }),
      ],
    ] as const) {
      const root = workspace();
      const identity = taskIdentity(root, `drift-${label}`);
      const model = new ScriptedModel([finalResponse("must not run")]);
      const valid = resolutionWithModel(identity, model);
      const before = rawTree(root);

      await expect(
        runFreshPawNextTaskV2({
          resolution: drift(valid) as BuiltPawNextTaskProfileV2,
        }),
      ).rejects.toThrow("V2 product resolution identity mismatch");
      expect(model.requests).toHaveLength(0);
      expect(rawTree(root)).toEqual(before);
    }
  });

  test("closes the raw Session and exposes ordered cleanup failure when the bundle loses its lease", async () => {
    const root = workspace();
    const identity = taskIdentity(root, "bundle-lease-loss");
    const model = new ScriptedModel([finalResponse("must not run")]);
    const resolution = resolutionWithModel(identity, model);
    const scheduler = new ExpireWhenHeartbeatArmsScheduler(90_001);
    let failure: unknown;

    try {
      await runFreshPawNextTaskV2({ resolution, leaseScheduler: scheduler });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    const aggregate = failure as AggregateError;
    expect(aggregate.errors).toHaveLength(2);
    expect((aggregate.errors[0] as Error).message).toContain("lease");
    expect((aggregate.errors[1] as Error).message).toBe(
      "Paw Next execution lease was lost before cleanup",
    );
    expect(model.requests).toHaveLength(0);

    const head = readFileSessionJournalCommitIndexV1(identity).head;
    const reacquired = acquireFileSessionExecutionLeaseV1({
      workspaceRoot: root,
      sessionId: identity.sessionId,
      runId: identity.runId,
      ttlMs: resolution.taskOptions.heartbeatPolicy.ttlMs,
      baseTailSeq: head.tailSeq,
      basePrefixHash: head.prefixHash,
      clock: () => scheduler.now(),
    });
    expect(reacquired.status).toBe("acquired");
    if (reacquired.status !== "acquired") {
      throw new Error("expired V2 Fresh lease was not reclaimable");
    }
    const reopened = new FileRunSessionV1({
      workspaceRoot: root,
      sessionId: identity.sessionId,
      runId: identity.runId,
      executionLease: reacquired.lease,
      clock: () => scheduler.now(),
    });
    expect((await reopened.readInputSnapshot()).tailSeq).toBe(0);
    reopened.close();
    expect(await reacquired.lease.release()).toBe("released");
  });

  test("does not fall back to older assistant text when the latest model settlement has no response", async () => {
    const root = workspace();
    fs.writeFileSync(path.join(root, "latest.txt"), "latest\n");
    const identity = taskIdentity(root, "latest-failed");
    const model = new ScriptedModel([
      {
        ...toolResponse("latest-read", "workspace_read_file", {
          path: "latest.txt",
        }),
        text: "older assistant text",
        nativeAssistantContent: "older assistant text",
      },
      new Error("latest model failed"),
    ]);
    const result = await runFreshPawNextTaskV2({
      resolution: resolutionWithModel(identity, model),
    });

    expect(result.state.decision.kind).toBe("incomplete");
    expect(result.assistantText).toBeUndefined();
    expect(model.requests).toHaveLength(2);
  });
});

describe("Paw Next V2 Existing composition", () => {
  test("reopens a terminal artifact run without another model call or journal mutation", async () => {
    const root = workspace();
    const identity = taskIdentity(root, "terminal-reopen");
    const freshModel = new ScriptedModel([finalResponse("terminal artifact")]);
    const freshResolution = resolutionWithModel(identity, freshModel);
    const fresh = await runFreshPawNextTaskV2({ resolution: freshResolution });
    const before = committedPrefix(identity);
    const probe = new ScriptedModel([]);
    const existingResolution = resolutionWithReplacementModel(
      freshResolution,
      probe,
    );

    const first = await runExistingPawNextTaskV2({
      resolution: existingResolution,
    });
    const second = await runExistingPawNextTaskV2({
      resolution: existingResolution,
    });

    expect(first.assistantText).toBe("terminal artifact");
    expect(second.assistantText).toBe("terminal artifact");
    expect(first.tailSeq).toBe(fresh.tailSeq);
    expect(second.tailSeq).toBe(fresh.tailSeq);
    expect(probe.requests).toHaveLength(0);
    expect(committedPrefix(identity)).toEqual(before);
  });

  test("repairs only the missing artifact-backed tool result and does not replay an effect or model", async () => {
    const root = workspace();
    fs.writeFileSync(path.join(root, "partial-a.txt"), "a\n");
    fs.writeFileSync(path.join(root, "partial-b.txt"), "b\n");
    const identity = taskIdentity(root, "partial-tool-repair");
    const freshModel = new ScriptedModel([finalResponse("seed terminal")]);
    const resolution = resolutionWithModel(identity, freshModel);
    await runFreshPawNextTaskV2({ resolution });
    await appendV2Facts(resolution, [
      modelDispatch(2),
      completedToolModelSettlement(2, [
        toolCall("partial-a", "partial-a.txt", 0),
        toolCall("partial-b", "partial-b.txt", 1),
      ]),
      observedTool(2, "partial-a", "partial-a.txt", 0),
      observedTool(2, "partial-b", "partial-b.txt", 1),
      toolDispatch(2, "partial-a", 0),
      toolDispatch(2, "partial-b", 1),
      toolPermission(2, "partial-a", 0),
      toolPermission(2, "partial-b", 1),
      {
        type: "tool.settled",
        callId: "partial-a",
        status: "completed",
        observation: {
          schemaVersion: "paw.tool-observation.v1",
          summary: "historical first result",
          isError: false,
          payload: inlinePayload({ content: "a\n" }),
        },
      },
      accepted("pending-after-partial"),
    ]);
    const probe = new ScriptedModel([]);
    const existing = resolutionWithReplacementModel(resolution, probe);

    await expect(
      runExistingPawNextTaskV2({ resolution: existing }),
    ).rejects.toThrow(/pending accepted input/i);
    const repaired = committedPrefix(identity);
    expect(probe.requests).toHaveLength(0);
    expect(
      inputFacts(repaired).filter(
        (fact) =>
          fact.type === "tool.settled" &&
          fact.callId === "partial-a" &&
          fact.status === "completed",
      ),
    ).toHaveLength(1);
    expect(
      inputFacts(repaired).filter(
        (fact) =>
          fact.type === "tool.settled" &&
          fact.callId === "partial-b" &&
          fact.status === "unknown",
      ),
    ).toHaveLength(1);
    const repairedTail = repaired.length;

    await expect(
      runExistingPawNextTaskV2({ resolution: existing }),
    ).rejects.toThrow(/pending accepted input/i);
    expect(committedPrefix(identity)).toHaveLength(repairedTail);
    expect(probe.requests).toHaveLength(0);
  });

  test("repairs an open model once against artifact history before pending input blocks execution", async () => {
    const root = workspace();
    const identity = taskIdentity(root, "open-model-repair");
    const resolution = resolutionWithModel(
      identity,
      new ScriptedModel([finalResponse("historical artifact")]),
    );
    await runFreshPawNextTaskV2({ resolution });
    await appendRawFacts(resolution, [
      modelDispatch(2),
      accepted("pending-after-open-model"),
    ]);
    const probe = new ScriptedModel([]);
    const existing = resolutionWithReplacementModel(resolution, probe);

    await expect(
      runExistingPawNextTaskV2({ resolution: existing }),
    ).rejects.toThrow(/pending accepted input/i);
    const repaired = committedPrefix(identity);
    expect(
      inputFacts(repaired).filter(
        (fact) =>
          fact.type === "model.settled" &&
          fact.modelCallId === "model-2" &&
          fact.status === "unknown",
      ),
    ).toHaveLength(1);
    expect(probe.requests).toHaveLength(0);
    const repairedTail = repaired.length;

    await expect(
      runExistingPawNextTaskV2({ resolution: existing }),
    ).rejects.toThrow(/pending accepted input/i);
    expect(committedPrefix(identity)).toHaveLength(repairedTail);
    expect(probe.requests).toHaveLength(0);
  });

  test("continues after a complete artifact-backed tool turn at the next canonical model turn", async () => {
    const root = workspace();
    fs.writeFileSync(path.join(root, "cursor.txt"), "cursor\n");
    const identity = taskIdentity(root, "tool-cursor");
    const resolution = resolutionWithModel(
      identity,
      new ScriptedModel([finalResponse("seed terminal")]),
    );
    await runFreshPawNextTaskV2({ resolution });
    await appendV2Facts(resolution, [
      modelDispatch(2),
      completedToolModelSettlement(2, [
        toolCall("cursor-read", "cursor.txt", 0),
      ]),
      observedTool(2, "cursor-read", "cursor.txt", 0),
      toolDispatch(2, "cursor-read", 0),
      toolPermission(2, "cursor-read", 0),
      {
        type: "tool.settled",
        callId: "cursor-read",
        status: "completed",
        observation: {
          schemaVersion: "paw.tool-observation.v1",
          summary: "historical cursor result",
          isError: false,
          payload: inlinePayload({ content: "cursor\n" }),
        },
      },
    ]);
    const probe = new ScriptedModel([finalResponse("resumed at turn three")]);

    const result = await runExistingPawNextTaskV2({
      resolution: resolutionWithReplacementModel(resolution, probe),
    });

    expect(result.assistantText).toBe("resumed at turn three");
    expect(probe.requests).toHaveLength(1);
    expect(
      result.inputFacts
        .filter((fact) => fact.type === "model.dispatch_recorded")
        .map((fact) => fact.turn),
    ).toEqual([1, 2, 3]);
    expect(
      result.inputFacts.filter(
        (fact) => fact.type === "tool.settled" && fact.callId === "cursor-read",
      ),
    ).toHaveLength(1);
  });

  test("rejects missing or corrupt historical artifacts before repairing an open model", async () => {
    for (const mode of ["missing", "corrupt"] as const) {
      const root = workspace();
      const identity = taskIdentity(root, `artifact-${mode}`);
      const resolution = resolutionWithModel(
        identity,
        new ScriptedModel([finalResponse("historical artifact")]),
      );
      await runFreshPawNextTaskV2({ resolution });
      await appendRawFacts(resolution, [modelDispatch(2)]);
      const prefix = committedPrefix(identity);
      const occurrence = projectCanonicalDurableJsonPayloadBindingsV1(
        prefix,
      ).find((item) => item.location.kind === "model_response");
      if (!occurrence || occurrence.payload.kind !== "artifact_ref") {
        throw new Error("missing historical model artifact fixture");
      }
      const file = payloadArtifactFile(root, occurrence.payload.artifactRef);
      if (mode === "missing") fs.rmSync(file);
      else fs.appendFileSync(file, " ");
      const before = committedPrefix(identity);
      const probe = new ScriptedModel([]);

      await expect(
        runExistingPawNextTaskV2({
          resolution: resolutionWithReplacementModel(resolution, probe),
        }),
      ).rejects.toThrow();

      expect(probe.requests).toHaveLength(0);
      expect(committedPrefix(identity)).toEqual(before);
      expect(
        inputFacts(committedPrefix(identity)).some(
          (fact) =>
            fact.type === "model.settled" && fact.modelCallId === "model-2",
        ),
      ).toBeFalse();
    }
  });

  test("rejects provider, binding, and budget drift before appending another fact", async () => {
    const providerRoot = workspace();
    const providerIdentity = taskIdentity(providerRoot, "provider-drift");
    const providerResolution = resolutionWithModel(
      providerIdentity,
      new ScriptedModel([finalResponse("provider seed")]),
    );
    await runFreshPawNextTaskV2({ resolution: providerResolution });
    await appendV2Facts(providerResolution, [
      modelDispatch(2),
      completedPlainModelSettlement(2, "anthropic-compatible", "wrong"),
    ]);
    await assertExistingFailureLeavesJournalUnchanged(providerResolution);

    const bindingRoot = workspace();
    const bindingIdentity = taskIdentity(bindingRoot, "binding-drift");
    const bindingResolution = resolutionWithModel(
      bindingIdentity,
      new ScriptedModel([finalResponse("binding seed")]),
    );
    await runFreshPawNextTaskV2({ resolution: bindingResolution });
    const firstPayload = projectCanonicalDurableJsonPayloadBindingsV1(
      committedPrefix(bindingIdentity),
    ).find((item) => item.location.kind === "model_response")?.payload;
    if (!firstPayload || firstPayload.kind !== "artifact_ref") {
      throw new Error("missing binding drift artifact fixture");
    }
    await appendRawFacts(bindingResolution, [
      modelDispatch(2),
      {
        type: "model.settled",
        modelCallId: "model-2",
        turn: 2,
        status: "completed",
        hasToolCalls: false,
        hasVisibleOutput: true,
        finishReason: "stop",
        response: firstPayload,
      },
    ]);
    await assertExistingFailureLeavesJournalUnchanged(bindingResolution);

    const budgetRoot = workspace();
    const budgetIdentity = taskIdentity(budgetRoot, "budget-drift-existing");
    const budgetResolution = resolutionWithModel(
      budgetIdentity,
      new ScriptedModel([finalResponse("budget seed")]),
    );
    await runFreshPawNextTaskV2({ resolution: budgetResolution });
    const driftedBudget = {
      ...budgetResolution,
      taskOptions: {
        ...budgetResolution.taskOptions,
        payloadRuntime: {
          ...budgetResolution.taskOptions.payloadRuntime,
          readBudget: {
            ...budgetResolution.taskOptions.payloadRuntime.readBudget,
            maxTotalBytes:
              budgetResolution.taskOptions.payloadRuntime.readBudget
                .maxTotalBytes - 1,
          },
        },
      },
    } as BuiltPawNextTaskProfileV2;
    await assertExistingFailureLeavesJournalUnchanged(driftedBudget);
  });

  test("rejects a Protocol-valid raw inline model carrier before recovery or execution", async () => {
    const root = workspace();
    const identity = taskIdentity(root, "raw-inline-bypass");
    const resolution = resolutionWithModel(
      identity,
      new ScriptedModel([finalResponse("artifact seed")]),
    );
    await runFreshPawNextTaskV2({ resolution });
    await appendRawFacts(resolution, [
      modelDispatch(2),
      completedPlainModelSettlement(2, "openai-compatible", "raw inline"),
    ]);
    const before = committedPrefix(identity);
    const payloadRoot = path.join(
      root,
      ".paw",
      "paw-next",
      "durable-json-payloads",
    );
    const payloadsBefore = rawTree(payloadRoot);
    const probe = new ScriptedModel([]);

    await expect(
      runExistingPawNextTaskV2({
        resolution: resolutionWithReplacementModel(resolution, probe),
      }),
    ).rejects.toThrow("must use the file codec");

    expect(probe.requests).toHaveLength(0);
    expect(committedPrefix(identity)).toEqual(before);
    expect(rawTree(payloadRoot)).toEqual(payloadsBefore);
  });

  test("uses the latest response-less settlement as final truth instead of older artifact text", async () => {
    const root = workspace();
    const identity = taskIdentity(root, "existing-latest-unknown");
    const resolution = resolutionWithModel(
      identity,
      new ScriptedModel([finalResponse("older artifact text")]),
    );
    await runFreshPawNextTaskV2({ resolution });
    await appendRawFacts(resolution, [
      modelDispatch(2),
      {
        type: "model.settled",
        modelCallId: "model-2",
        turn: 2,
        status: "unknown",
        hasToolCalls: false,
        hasVisibleOutput: false,
        errorCode: "RecoveredUnknown",
      },
    ]);
    const probe = new ScriptedModel([]);

    const result = await runExistingPawNextTaskV2({
      resolution: resolutionWithReplacementModel(resolution, probe),
    });

    expect(result.assistantText).toBeUndefined();
    expect(result.state.decision.kind).toBe("incomplete");
    expect(probe.requests).toHaveLength(0);
  });

  test("propagates a pre-abort and releases the Existing lease for immediate reclaim", async () => {
    const root = workspace();
    const identity = taskIdentity(root, "existing-preabort");
    const resolution = resolutionWithModel(
      identity,
      new ScriptedModel([finalResponse("abort seed")]),
    );
    await runFreshPawNextTaskV2({ resolution });
    const before = committedPrefix(identity);
    const probe = new ScriptedModel([]);
    const controller = new AbortController();
    const reason = new Error("existing caller aborted");
    controller.abort(reason);

    await expect(
      runExistingPawNextTaskV2({
        resolution: resolutionWithReplacementModel(resolution, probe),
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    expect(probe.requests).toHaveLength(0);
    expect(committedPrefix(identity)).toEqual(before);

    const head = readFileSessionJournalCommitIndexV1(identity).head;
    const reacquired = acquireFileSessionExecutionLeaseV1({
      workspaceRoot: root,
      sessionId: identity.sessionId,
      runId: identity.runId,
      ttlMs: resolution.taskOptions.heartbeatPolicy.ttlMs,
      baseTailSeq: head.tailSeq,
      basePrefixHash: head.prefixHash,
    });
    expect(reacquired.status).toBe("acquired");
    if (reacquired.status !== "acquired") {
      throw new Error("aborted Existing lease was not reclaimable");
    }
    expect(await reacquired.lease.release()).toBe("released");
  });
});

describe("Paw Next programmatic product-catalog startup scanner", () => {
  test("runs the V2-only CLI over real terminal and pending catalog entries without changing authority bytes", async () => {
    const root = workspace();
    const terminalIdentity = taskIdentity(root, "cli-terminal");
    const pendingIdentity = taskIdentity(root, "cli-pending");
    const terminal = resolutionWithModel(
      terminalIdentity,
      new ScriptedModel([finalResponse("terminal")]),
    );
    const pending = resolutionWithModel(
      pendingIdentity,
      new ScriptedModel([finalResponse("pending")]),
    );
    await runFreshPawNextTaskV2({ resolution: terminal });
    await runFreshPawNextTaskV2({ resolution: pending });
    await appendRawFacts(pending, [accepted("cli-pending-input")]);
    writeProductProfileStores(root, [], [terminal.profile]);
    const before = rawTree(root);

    const first = await runPawNextStartupCliV2([
      "--startup-scan-v2",
      "--root",
      root,
    ]);
    const second = await runPawNextStartupCliV2([
      "--startup-scan-v2",
      "--root",
      root,
    ]);
    const report = JSON.parse(first.text) as {
      readonly runs: readonly {
        readonly runId: string;
        readonly status: string;
      }[];
    };

    expect(first.exitCode).toBe(0);
    expect(second).toEqual(first);
    expect(
      report.runs.find((run) => run.runId === terminalIdentity.runId)?.status,
    ).toBe("terminal");
    expect(
      report.runs.find((run) => run.runId === pendingIdentity.runId)?.status,
    ).toBe("blocked_pending");
    expect(rawTree(root)).toEqual(before);
  });

  test("runs the V3-only CLI twice over terminal, pending, and marker-free histories without writes", async () => {
    const root = workspace();
    const terminalIdentity = taskIdentity(root, "cli-v3-terminal");
    const pendingIdentity = taskIdentity(root, "cli-v3-pending");
    const markerFreeIdentity = taskIdentity(root, "cli-v3-marker-free");
    const terminal = resolutionV3WithModel(
      terminalIdentity,
      new ScriptedModel([finalResponse("terminal")]),
    );
    const pending = resolutionV3WithModel(
      pendingIdentity,
      new ScriptedModel([finalResponse("pending")]),
    );
    const markerFree = resolutionV3WithModel(
      markerFreeIdentity,
      new ScriptedModel([]),
    );
    await runFreshPawNextTaskV3({ resolution: terminal });
    await runFreshPawNextTaskV3({ resolution: pending });
    await appendRawV3Facts(pending, [accepted("cli-v3-pending-input")]);
    await seedV3Run(markerFree, []);
    writeProductProfileStores(root, [], [], [terminal.profile]);
    const before = rawTree(root);

    const first = await runPawNextStartupCliV3([
      "--startup-scan-v3",
      "--root",
      root,
    ]);
    const second = await runPawNextStartupCliV3([
      "--startup-scan-v3",
      "--root",
      root,
    ]);
    const report = JSON.parse(first.text) as {
      readonly runs: readonly {
        readonly runId: string;
        readonly status: string;
      }[];
    };

    expect(first.exitCode).toBe(0);
    expect(second).toEqual(first);
    expect(first.text).not.toContain(root);
    expect(
      report.runs.find((run) => run.runId === terminalIdentity.runId)?.status,
    ).toBe("terminal");
    expect(
      report.runs.find((run) => run.runId === pendingIdentity.runId)?.status,
    ).toBe("blocked_pending");
    expect(
      report.runs.find((run) => run.runId === markerFreeIdentity.runId)?.status,
    ).toBe("deferred");
    expect(rawTree(root)).toEqual(before);
  });

  test("uses the real V2 catalog scanner to repair an open model without provider network access", async () => {
    const root = workspace();
    const identity = taskIdentity(root, "cli-open-model");
    const resolution = resolutionWithModel(
      identity,
      new ScriptedModel([finalResponse("historical terminal")]),
    );
    await runFreshPawNextTaskV2({ resolution });
    await appendRawFacts(resolution, [
      modelDispatch(2),
      accepted("cli-pending-after-open-model"),
    ]);
    writeProductProfileStores(root, [], [resolution.profile]);

    const first = await runPawNextStartupCliV2([
      "--startup-scan-v2",
      "--root",
      root,
    ]);
    const repaired = committedPrefix(identity);
    const repairedTail = repaired.length;
    expect(JSON.parse(first.text)).toMatchObject({
      runs: [{ runId: identity.runId, status: "blocked_pending" }],
    });
    expect(
      inputFacts(repaired).filter(
        (fact) =>
          fact.type === "model.settled" &&
          fact.modelCallId === "model-2" &&
          fact.status === "unknown",
      ),
    ).toHaveLength(1);

    const second = await runPawNextStartupCliV2([
      "--startup-scan-v2",
      "--root",
      root,
    ]);
    expect(second).toEqual(first);
    expect(committedPrefix(identity)).toHaveLength(repairedTail);
  });

  test("classifies terminal and pending runs twice without a lease or byte mutation", async () => {
    const root = workspace();
    const terminalIdentity = taskIdentity(root, "scan-terminal");
    const pendingIdentity = taskIdentity(root, "scan-pending");
    const terminal = resolutionWithModel(
      terminalIdentity,
      new ScriptedModel([finalResponse("terminal")]),
    );
    const pending = resolutionWithModel(
      pendingIdentity,
      new ScriptedModel([finalResponse("pending seed")]),
    );
    await runFreshPawNextTaskV2({ resolution: terminal });
    await runFreshPawNextTaskV2({ resolution: pending });
    await appendRawFacts(pending, [accepted("scan-pending-input")]);
    const terminalProbe = new ScriptedModel([]);
    const pendingProbe = new ScriptedModel([]);
    const products = new Map([
      [
        terminalIdentity.runId,
        resolutionWithReplacementModel(terminal, terminalProbe),
      ],
      [
        pendingIdentity.runId,
        resolutionWithReplacementModel(pending, pendingProbe),
      ],
    ]);
    const before = rawTree(root);
    const scan = () =>
      scanAndResumePawNextRunsWithCatalogV1({
        workspaceRoot: root,
        resolveProduct: (identity) => products.get(identity.runId),
      });

    const first = await scan();
    const second = await scan();

    expect(statusOf(first, terminalIdentity)).toBe("terminal");
    expect(statusOf(first, pendingIdentity)).toBe("blocked_pending");
    expect(second).toEqual(first);
    expect(terminalProbe.requests).toHaveLength(0);
    expect(pendingProbe.requests).toHaveLength(0);
    expect(rawTree(root)).toEqual(before);
  });

  test("stably executes only the first V2 actionable run through discovered anchors", async () => {
    const root = workspace();
    const firstIdentity = taskIdentity(root, "action-a");
    const secondIdentity = taskIdentity(root, "action-b");
    const first = await actionableToolResolution(firstIdentity, "first.txt");
    const second = await actionableToolResolution(secondIdentity, "second.txt");
    const firstProbe = new ScriptedModel([finalResponse("first resumed")]);
    const secondProbe = new ScriptedModel([finalResponse("second resumed")]);
    const products = new Map([
      [firstIdentity.runId, resolutionWithReplacementModel(first, firstProbe)],
      [
        secondIdentity.runId,
        resolutionWithReplacementModel(second, secondProbe),
      ],
    ]);

    const report = await scanAndResumePawNextRunsWithCatalogV1({
      workspaceRoot: root,
      resolveProduct: (identity) => products.get(identity.runId),
    });

    expect(statusOf(report, firstIdentity)).toBe("resumed");
    expect(statusOf(report, secondIdentity)).toBe("deferred");
    expect(firstProbe.requests).toHaveLength(1);
    expect(secondProbe.requests).toHaveLength(0);
    expect(
      inputFacts(committedPrefix(firstIdentity))
        .filter((fact) => fact.type === "model.dispatch_recorded")
        .map((fact) => fact.turn),
    ).toEqual([1, 2, 3]);
  });

  test("reports same-run head and sibling inventory drift after async product resolution without scanner writes", async () => {
    const headRoot = workspace();
    const headIdentity = taskIdentity(headRoot, "scan-head-drift");
    const headProduct = resolutionWithModel(
      headIdentity,
      new ScriptedModel([finalResponse("head seed")]),
    );
    await runFreshPawNextTaskV2({ resolution: headProduct });
    const headProbe = new ScriptedModel([]);
    let headTreeAfterMutation: readonly string[] | undefined;
    const headReport = await scanAndResumePawNextRunsWithCatalogV1({
      workspaceRoot: headRoot,
      async resolveProduct() {
        await appendRawFacts(headProduct, [accepted("head-drift-input")]);
        headTreeAfterMutation = rawTree(headRoot);
        return resolutionWithReplacementModel(headProduct, headProbe);
      },
    });
    expect(statusOf(headReport, headIdentity)).toBe("anchor_conflict");
    expect(headProbe.requests).toHaveLength(0);
    if (!headTreeAfterMutation) throw new Error("head mutation did not run");
    expect(rawTree(headRoot)).toEqual(headTreeAfterMutation);

    const inventoryRoot = workspace();
    const targetIdentity = taskIdentity(inventoryRoot, "scan-inventory-target");
    const target = resolutionWithModel(
      targetIdentity,
      new ScriptedModel([finalResponse("inventory seed")]),
    );
    await runFreshPawNextTaskV2({ resolution: target });
    const targetProbe = new ScriptedModel([]);
    let inventoryTreeAfterMutation: readonly string[] | undefined;
    const inventoryReport = await scanAndResumePawNextRunsWithCatalogV1({
      workspaceRoot: inventoryRoot,
      async resolveProduct() {
        const siblingIdentity = {
          ...taskIdentity(inventoryRoot, "scan-inventory-sibling"),
          sessionId: targetIdentity.sessionId,
        };
        await runFreshPawNextTaskV2({
          resolution: resolutionWithModel(
            siblingIdentity,
            new ScriptedModel([finalResponse("sibling")]),
          ),
        });
        inventoryTreeAfterMutation = rawTree(inventoryRoot);
        return resolutionWithReplacementModel(target, targetProbe);
      },
    });
    expect(statusOf(inventoryReport, targetIdentity)).toBe("inventory_stale");
    expect(targetProbe.requests).toHaveLength(0);
    if (!inventoryTreeAfterMutation) {
      throw new Error("inventory mutation did not run");
    }
    expect(rawTree(inventoryRoot)).toEqual(inventoryTreeAfterMutation);
  });

  test("isolates a corrupt V3 artifact Session and resumes a healthy V3 Session", async () => {
    const root = workspace();
    const corruptIdentity = taskIdentity(root, "a-corrupt-session");
    const healthyIdentity = taskIdentity(root, "b-healthy-session");
    const corrupt = resolutionV3WithModel(
      corruptIdentity,
      new ScriptedModel([finalResponse("corrupt seed")]),
    );
    await runFreshPawNextTaskV3({ resolution: corrupt });
    const corruptOccurrence = projectCanonicalDurableJsonPayloadBindingsV1(
      committedPrefix(corruptIdentity),
    ).find((item) => item.location.kind === "model_response");
    if (
      !corruptOccurrence ||
      corruptOccurrence.payload.kind !== "artifact_ref"
    ) {
      throw new Error("missing corrupt scanner fixture");
    }
    fs.rmSync(payloadArtifactFile(root, corruptOccurrence.payload.artifactRef));
    const healthy = resolutionV3WithModel(
      healthyIdentity,
      new ScriptedModel([finalResponse("healthy seed")]),
    );
    await runFreshPawNextTaskV3({ resolution: healthy });
    await startV3FixtureSegment(healthy, "healthy-q1", "healthy-q2");
    const corruptProbe = new ScriptedModel([]);
    const healthyProbe = new ScriptedModel([finalResponse("healthy resumed")]);

    const report = await scanAndResumePawNextRunsWithCatalogV1({
      workspaceRoot: root,
      resolveProduct(identity) {
        if (identity.runId === corruptIdentity.runId) {
          return resolutionV3WithReplacementModel(corrupt, corruptProbe);
        }
        if (identity.runId === healthyIdentity.runId) {
          return resolutionV3WithReplacementModel(healthy, healthyProbe);
        }
        return undefined;
      },
    });

    expect(statusOf(report, corruptIdentity)).toBe("invalid");
    expect(statusOf(report, healthyIdentity)).toBe("resumed");
    expect(corruptProbe.requests).toHaveLength(0);
    expect(healthyProbe.requests).toHaveLength(1);
    expect(JSON.stringify(report)).not.toContain(API_KEY);
    expect(JSON.stringify(report)).not.toContain(root);
  });

  test("sanitizes V3 resolver failures and never reports catalog secrets or product bodies", async () => {
    const root = workspace();
    const identity = taskIdentity(root, "secret-report");
    const resolution = resolutionV3WithModel(
      identity,
      new ScriptedModel([finalResponse("secret seed")]),
    );
    await runFreshPawNextTaskV3({ resolution });
    const before = rawTree(root);

    const report = await scanAndResumePawNextRunsWithCatalogV1({
      workspaceRoot: root,
      resolveProduct() {
        throw new Error(`raw ${API_KEY} ${root} ${JSON.stringify(resolution)}`);
      },
    });
    const serialized = JSON.stringify(report);

    expect(statusOf(report, identity)).toBe("invalid");
    expect(report.runs[0]?.reason).toBe("startup_resolve_failed");
    expect(serialized).not.toContain(API_KEY);
    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain("payloadRuntime");
    expect(serialized).not.toContain("credentialBindingHash");
    expect(rawTree(root)).toEqual(before);
  });

  test("blocks a real-catalog mixed V1/V2/V3 actionable Session and never falls back for missing V3 config", async () => {
    const root = workspace();
    const v2Identity = taskIdentity(root, "mixed-v2");
    const v2 = await actionableToolResolution(v2Identity, "mixed-v2.txt");
    const v1Identity = {
      ...taskIdentity(root, "mixed-v1"),
      sessionId: v2Identity.sessionId,
    };
    const { payloadRuntime: _payloadRuntime, ...v1SeedProfile } = profileV2();
    const v1Descriptor = {
      ...v1SeedProfile,
      profileId: "composition-v1",
      configHash: "0".repeat(64),
    };
    const v1Built = buildPawNextTaskOptionsFromProfileV1({
      identity: v1Identity,
      profile: v1Descriptor,
      apiKey: API_KEY,
    });
    const v1Profile = {
      ...v1Descriptor,
      configHash: preparePawNextProductRuntimeV1(v1Built).configHash,
    };
    const v1ProductOptions = buildPawNextTaskOptionsFromProfileV1({
      identity: v1Identity,
      profile: v1Profile,
      apiKey: API_KEY,
    });
    const v1SeedModel = new ScriptedModel([finalResponse("v1 seed")]);
    v1SeedModel.copyIdentity(v1ProductOptions.model);
    const v1Options = { ...v1ProductOptions, model: v1SeedModel };
    await runFreshPawNextTaskV1(v1Options);
    await appendRawIdentityFacts(v1Options, [
      modelDispatch(2),
      completedToolModelSettlement(2, [
        toolCall("mixed-v1-read", "mixed-v2.txt", 0),
      ]),
      observedTool(2, "mixed-v1-read", "mixed-v2.txt", 0),
      toolDispatch(2, "mixed-v1-read", 0),
      toolPermission(2, "mixed-v1-read", 0),
      {
        type: "tool.settled",
        callId: "mixed-v1-read",
        status: "completed",
        observation: {
          schemaVersion: "paw.tool-observation.v1",
          summary: "mixed V1 historical result",
          isError: false,
          payload: inlinePayload({ content: "mixed-v2.txt\n" }),
        },
      },
    ]);
    const v3Identity = {
      ...taskIdentity(root, "mixed-v3"),
      sessionId: v2Identity.sessionId,
    };
    const v3 = resolutionV3WithModel(
      v3Identity,
      new ScriptedModel([finalResponse("v3 seed")]),
    );
    await runFreshPawNextTaskV3({ resolution: v3 });
    await startV3FixtureSegment(v3, "mixed-v3-q1", "mixed-v3-q2");
    writeProductProfileStores(root, [v1Profile], [v2.profile], [v3.profile]);
    const catalog = createPawNextProductProfileCatalogV3({
      workspaceRoot: root,
      v1: {},
      v2: {},
      v3: {},
    });
    const v1Before = readFileSessionJournalCommitIndexV1(v1Identity).head;
    const v2Before = readFileSessionJournalCommitIndexV1(v2Identity).head;
    const v3Before = readFileSessionJournalCommitIndexV1(v3Identity).head;

    const ambiguous = await scanAndResumePawNextRunsWithCatalogV1({
      workspaceRoot: root,
      resolveProduct: catalog,
    });
    expect(statusOf(ambiguous, v1Identity)).toBe("ambiguous_session");
    expect(statusOf(ambiguous, v2Identity)).toBe("ambiguous_session");
    expect(statusOf(ambiguous, v3Identity)).toBe("ambiguous_session");
    expect(readFileSessionJournalCommitIndexV1(v1Identity).head).toEqual(
      v1Before,
    );
    expect(readFileSessionJournalCommitIndexV1(v2Identity).head).toEqual(
      v2Before,
    );
    expect(readFileSessionJournalCommitIndexV1(v3Identity).head).toEqual(
      v3Before,
    );

    const missingRoot = workspace();
    const missingIdentity = taskIdentity(missingRoot, "missing-v3");
    const missingV3 = resolutionV3WithModel(
      missingIdentity,
      new ScriptedModel([finalResponse("missing V3 seed")]),
    );
    await runFreshPawNextTaskV3({ resolution: missingV3 });
    await startV3FixtureSegment(missingV3, "missing-v3-q1", "missing-v3-q2");
    writeProductProfileStores(missingRoot, [v1Profile], [v2.profile]);
    const legacyOnlyCatalog = createPawNextProductProfileCatalogV3({
      workspaceRoot: missingRoot,
      v1: {},
      v2: {},
    });
    const missingBefore = rawTree(missingRoot);
    const unavailable = await scanAndResumePawNextRunsWithCatalogV1({
      workspaceRoot: missingRoot,
      resolveProduct: legacyOnlyCatalog,
    });
    expect(statusOf(unavailable, missingIdentity)).toBe("config_unavailable");
    expect(rawTree(missingRoot)).toEqual(missingBefore);
  }, 20_000);

  test("allows at most one concurrent V3 scanner to enter an active segment", async () => {
    const root = workspace();
    const identity = taskIdentity(root, "concurrent-v3-scan");
    const resolution = resolutionV3WithModel(
      identity,
      new ScriptedModel([finalResponse("concurrent seed")]),
    );
    await runFreshPawNextTaskV3({ resolution });
    await startV3FixtureSegment(resolution, "concurrent-q1", "concurrent-q2");
    const blocking = new BlockingScriptedModel();
    const product = resolutionV3WithReplacementModel(resolution, blocking);
    const scan = () =>
      scanAndResumePawNextRunsWithCatalogV1({
        workspaceRoot: root,
        resolveProduct: () => product,
      });

    const first = scan();
    await blocking.started;
    const second = scan();
    blocking.finish(finalResponse("single scanner winner"));
    const reports = await Promise.all([first, second]);
    const statuses = reports.map((report) => statusOf(report, identity));

    expect(statuses.filter((status) => status === "resumed")).toHaveLength(1);
    expect(
      statuses.filter(
        (status) => status === "busy" || status === "anchor_conflict",
      ),
    ).toHaveLength(1);
    expect(blocking.requests).toHaveLength(1);
  });

  test("classifies all terminal V3 pending forms twice without a lease, marker, or byte mutation", async () => {
    const root = workspace();
    const terminalIdentity = taskIdentity(root, "v3-scan-terminal");
    const acceptedIdentity = taskIdentity(root, "v3-scan-accepted");
    const promotedIdentity = taskIdentity(root, "v3-scan-promoted");
    const terminal = resolutionV3WithModel(
      terminalIdentity,
      new ScriptedModel([finalResponse("terminal")]),
    );
    const acceptedRun = resolutionV3WithModel(
      acceptedIdentity,
      new ScriptedModel([finalResponse("accepted seed")]),
    );
    const promotedRun = resolutionV3WithModel(
      promotedIdentity,
      new ScriptedModel([finalResponse("promoted seed")]),
    );
    await runFreshPawNextTaskV3({ resolution: terminal });
    await runFreshPawNextTaskV3({ resolution: acceptedRun });
    await runFreshPawNextTaskV3({ resolution: promotedRun });
    const acceptedInput = accepted("v3-scan-pending-q1");
    const promotedInput = accepted("v3-scan-unconsumed-q1");
    await appendRawV3Facts(acceptedRun, [acceptedInput]);
    await appendRawV3Facts(promotedRun, [
      promotedInput,
      {
        type: "input.promoted",
        inputId: promotedInput.inputId,
        delivery: promotedInput.delivery,
        content: promotedInput.content,
        contentHash: promotedInput.contentHash,
      },
    ]);
    const terminalProbe = new ScriptedModel([]);
    const acceptedProbe = new ScriptedModel([]);
    const promotedProbe = new ScriptedModel([]);
    const products = new Map([
      [
        terminalIdentity.runId,
        resolutionV3WithReplacementModel(terminal, terminalProbe),
      ],
      [
        acceptedIdentity.runId,
        resolutionV3WithReplacementModel(acceptedRun, acceptedProbe),
      ],
      [
        promotedIdentity.runId,
        resolutionV3WithReplacementModel(promotedRun, promotedProbe),
      ],
    ]);
    const before = rawTree(root);
    const scan = () =>
      scanAndResumePawNextRunsWithCatalogV1({
        workspaceRoot: root,
        resolveProduct: (identity) => products.get(identity.runId),
      });

    const first = await scan();
    const second = await scan();

    expect(statusOf(first, terminalIdentity)).toBe("terminal");
    expect(statusOf(first, acceptedIdentity)).toBe("blocked_pending");
    expect(statusOf(first, promotedIdentity)).toBe("blocked_unconsumed");
    expect(second).toEqual(first);
    expect(terminalProbe.requests).toHaveLength(0);
    expect(acceptedProbe.requests).toHaveLength(0);
    expect(promotedProbe.requests).toHaveLength(0);
    expect(rawTree(root)).toEqual(before);
    for (const identity of [acceptedIdentity, promotedIdentity]) {
      expect(
        inputFacts(committedPrefix(identity)).filter(
          (fact) => fact.type === "work.segment_started",
        ),
      ).toHaveLength(0);
    }
  });

  test("resumes one durable V3 active segment and leaves its next queued input pending", async () => {
    const root = workspace();
    const identity = taskIdentity(root, "v3-scan-active-marker");
    const resolution = resolutionV3WithModel(
      identity,
      new ScriptedModel([finalResponse("segment zero")]),
    );
    await runFreshPawNextTaskV3({ resolution });
    await startV3FixtureSegment(resolution, "v3-active-q1", "v3-pending-q2");
    const probe = new ScriptedModel([finalResponse("segment one final")]);
    const product = resolutionV3WithReplacementModel(resolution, probe);
    const scan = () =>
      scanAndResumePawNextRunsWithCatalogV1({
        workspaceRoot: root,
        resolveProduct: () => product,
      });

    const first = await scan();

    expect(statusOf(first, identity)).toBe("resumed");
    expect(probe.requests).toHaveLength(1);
    const afterFirst = committedPrefix(identity);
    const q2Facts = inputFacts(afterFirst).filter(
      (fact) =>
        (fact.type === "input.accepted" || fact.type === "input.promoted") &&
        fact.inputId === "v3-pending-q2",
    );
    expect(q2Facts.map((fact) => fact.type)).toEqual(["input.accepted"]);
    expect(
      inputFacts(afterFirst).filter(
        (fact) => fact.type === "work.segment_started",
      ),
    ).toHaveLength(1);
    const beforeSecond = rawTree(root);

    const second = await scan();

    expect(statusOf(second, identity)).toBe("blocked_pending");
    expect(probe.requests).toHaveLength(1);
    expect(rawTree(root)).toEqual(beforeSecond);
  });

  test("repairs an open V3 segment model exactly once before honoring its pending queue", async () => {
    const root = workspace();
    const identity = taskIdentity(root, "v3-scan-open-model");
    const resolution = resolutionV3WithModel(
      identity,
      new ScriptedModel([finalResponse("segment zero")]),
    );
    await runFreshPawNextTaskV3({ resolution });
    await startV3FixtureSegment(resolution, "v3-open-q1", "v3-open-q2");
    await appendRawV3Facts(resolution, [modelDispatch(2)]);
    const probe = new ScriptedModel([]);
    const product = resolutionV3WithReplacementModel(resolution, probe);
    const scan = () =>
      scanAndResumePawNextRunsWithCatalogV1({
        workspaceRoot: root,
        resolveProduct: () => product,
      });

    const first = await scan();
    const repaired = committedPrefix(identity);

    expect(statusOf(first, identity)).toBe("blocked_pending");
    expect(probe.requests).toHaveLength(0);
    expect(
      inputFacts(repaired).filter(
        (fact) =>
          fact.type === "model.settled" &&
          fact.modelCallId === "model-2" &&
          fact.status === "unknown",
      ),
    ).toHaveLength(1);
    expect(
      inputFacts(repaired).filter(
        (fact) =>
          fact.type === "input.promoted" && fact.inputId === "v3-open-q2",
      ),
    ).toHaveLength(0);
    const beforeSecond = rawTree(root);

    const second = await scan();

    expect(statusOf(second, identity)).toBe("blocked_pending");
    expect(probe.requests).toHaveLength(0);
    expect(rawTree(root)).toEqual(beforeSecond);
  });

  test("rejects V3 run-head and same-Session inventory drift before lease or model entry", async () => {
    const headRoot = workspace();
    const headIdentity = taskIdentity(headRoot, "v3-scan-head-drift");
    const headResolution = resolutionV3WithModel(
      headIdentity,
      new ScriptedModel([finalResponse("head seed")]),
    );
    await runFreshPawNextTaskV3({ resolution: headResolution });
    await startV3FixtureSegment(headResolution, "head-q1", "head-q2");
    const headProbe = new ScriptedModel([]);
    let headTreeAfterMutation: readonly string[] | undefined;
    const headReport = await scanAndResumePawNextRunsWithCatalogV1({
      workspaceRoot: headRoot,
      async resolveProduct() {
        await appendRawV3Facts(headResolution, [accepted("head-q3")]);
        headTreeAfterMutation = rawTree(headRoot);
        return resolutionV3WithReplacementModel(headResolution, headProbe);
      },
    });

    expect(statusOf(headReport, headIdentity)).toBe("anchor_conflict");
    expect(headProbe.requests).toHaveLength(0);
    if (!headTreeAfterMutation) throw new Error("head mutation did not run");
    expect(rawTree(headRoot)).toEqual(headTreeAfterMutation);

    const inventoryRoot = workspace();
    const targetIdentity = taskIdentity(
      inventoryRoot,
      "v3-scan-inventory-target",
    );
    const target = resolutionV3WithModel(
      targetIdentity,
      new ScriptedModel([finalResponse("inventory seed")]),
    );
    await runFreshPawNextTaskV3({ resolution: target });
    await startV3FixtureSegment(target, "inventory-q1", "inventory-q2");
    const targetProbe = new ScriptedModel([]);
    let inventoryTreeAfterMutation: readonly string[] | undefined;
    const inventoryReport = await scanAndResumePawNextRunsWithCatalogV1({
      workspaceRoot: inventoryRoot,
      async resolveProduct() {
        const siblingIdentity = {
          ...taskIdentity(inventoryRoot, "v3-scan-inventory-sibling"),
          sessionId: targetIdentity.sessionId,
        };
        await runFreshPawNextTaskV3({
          resolution: resolutionV3WithModel(
            siblingIdentity,
            new ScriptedModel([finalResponse("sibling")]),
          ),
        });
        inventoryTreeAfterMutation = rawTree(inventoryRoot);
        return resolutionV3WithReplacementModel(target, targetProbe);
      },
    });

    expect(statusOf(inventoryReport, targetIdentity)).toBe("inventory_stale");
    expect(targetProbe.requests).toHaveLength(0);
    if (!inventoryTreeAfterMutation) {
      throw new Error("inventory mutation did not run");
    }
    expect(rawTree(inventoryRoot)).toEqual(inventoryTreeAfterMutation);
  });

  test("stably resumes only the first V3 active Session in one scan", async () => {
    const root = workspace();
    const firstIdentity = taskIdentity(root, "a-v3-active");
    const secondIdentity = taskIdentity(root, "b-v3-active");
    const first = resolutionV3WithModel(
      firstIdentity,
      new ScriptedModel([finalResponse("first seed")]),
    );
    const second = resolutionV3WithModel(
      secondIdentity,
      new ScriptedModel([finalResponse("second seed")]),
    );
    await runFreshPawNextTaskV3({ resolution: first });
    await runFreshPawNextTaskV3({ resolution: second });
    await startV3FixtureSegment(first, "first-q1", "first-q2");
    await startV3FixtureSegment(second, "second-q1", "second-q2");
    const firstProbe = new ScriptedModel([finalResponse("first resumed")]);
    const secondProbe = new ScriptedModel([finalResponse("second resumed")]);
    const products = new Map([
      [
        firstIdentity.runId,
        resolutionV3WithReplacementModel(first, firstProbe),
      ],
      [
        secondIdentity.runId,
        resolutionV3WithReplacementModel(second, secondProbe),
      ],
    ]);

    const report = await scanAndResumePawNextRunsWithCatalogV1({
      workspaceRoot: root,
      resolveProduct: (identity) => products.get(identity.runId),
    });

    expect(statusOf(report, firstIdentity)).toBe("resumed");
    expect(statusOf(report, secondIdentity)).toBe("deferred");
    expect(firstProbe.requests).toHaveLength(1);
    expect(secondProbe.requests).toHaveLength(0);
  });

  test("keeps the shared scanner and main free of implicit work admission seams", () => {
    const sources = ["../src/paw-next/startup-scan.ts", "../src/main.ts"].map(
      (relative) =>
        fs.readFileSync(path.resolve(import.meta.dir, relative), "utf8"),
    );
    const forbidden = [
      "acceptQueuedWorkSegmentInputV1",
      "startWorkSegmentV1",
      "runExistingPawNextWorkSegmentV3",
    ];

    for (const source of sources) {
      for (const symbol of forbidden) expect(source).not.toContain(symbol);
    }
  });
});

describe("Paw Next V3 Fresh and Existing composition skeleton", () => {
  test("adapts the built-in write-capable AgentSpecs into the V3 roster", () => {
    const roster = loadPawNextCollaborationRosterV1(workspace());
    const codingAgent = roster.agents.find((agent) => agent.id === "bianmu");
    const testingAgent = roster.agents.find((agent) => agent.id === "buou");

    expect(codingAgent?.childPolicy).toBe("read_write");
    expect(codingAgent?.effect).toBe("mutate");
    expect(codingAgent?.capabilities).toContain("implementation");
    expect(codingAgent?.capabilities).toContain("integration");
    expect(codingAgent?.tools).toContain("workspace.write_file");
    expect(codingAgent?.tools).toContain("workspace.run_shell");
    expect(codingAgent?.canSpawn).toBe(false);
    expect(testingAgent?.capabilities).toContain("testing");
    expect(testingAgent?.childPolicy).toBe("read_only");
    expect(testingAgent?.effect).toBe("execute");
    expect(testingAgent?.tools).toContain("workspace.run_shell");
    expect(testingAgent?.tools).not.toContain("workspace.write_file");
  });

  test("keeps mutation and recursive dispatch outside the V3 child registry", async () => {
    const root = workspace();
    const identity = {
      ...taskIdentity(root, "v3-child-read-only"),
      goal: "Parent task",
    };
    const model = new ScriptedModel([
      toolResponse("forbidden-write", "workspace_write_file", {
        path: "forbidden.txt",
        content: "must not exist",
      }),
      toolResponse("forbidden-child", "workspace_delegate", {
        goal: "Spawn recursively",
      }),
      finalResponse("Neither forbidden capability was available."),
    ]);
    const resolution = resolutionV3WithModel(identity, model);

    const result = await runPawNextReadOnlyChildV3({
      parentOptions: resolution.taskOptions,
      parentTaskOptions: resolution.taskOptions,
      callId: "read-only-child-call",
      goal: "Verify the available read-only surface.",
      maxModelTurns: 4,
    });

    expect(result.status).toBe("completed");
    expect(fs.existsSync(path.join(root, "forbidden.txt"))).toBeFalse();
    const observed = model.requests
      .flat()
      .flatMap((message) => message.nativeToolTurn?.results ?? [])
      .map((item) => item.content)
      .join("\n");
    expect(observed).toContain("Unknown runtime tool: workspace_write_file");
    expect(observed).toContain("Unknown runtime tool: workspace_delegate");
  });

  test("reopens one terminal V3 child journal without another model call", async () => {
    const root = workspace();
    const identity = {
      ...taskIdentity(root, "v3-child-recovery"),
      goal: "Parent task",
    };
    const model = new ScriptedModel([
      finalResponse("The child found the requested symbol in source.ts."),
    ]);
    const resolution = resolutionV3WithModel(identity, model);
    const childInput = {
      parentOptions: resolution.taskOptions,
      parentTaskOptions: resolution.taskOptions,
      callId: "stable-child-call",
      goal: "Locate the requested symbol.",
      maxModelTurns: 4,
    };

    const first = await runPawNextReadOnlyChildV3(childInput);
    const second = await runPawNextReadOnlyChildV3(childInput);

    expect(first).toEqual(second);
    expect(first.status).toBe("completed");
    expect(first.childRun).toMatchObject({
      runtime: "paw_next_v3",
      parentCallId: childInput.callId,
    });
    expect(model.requests).toHaveLength(1);
    const childKey = createHash("sha256")
      .update(
        JSON.stringify([
          resolution.taskOptions.sessionId,
          resolution.taskOptions.runId,
          childInput.callId,
        ]),
      )
      .digest("hex")
      .slice(0, 32);
    const childHead = readFileSessionJournalCommitIndexV1({
      workspaceRoot: root,
      sessionId: `child-session-${childKey}`,
      runId: `child-run-${childKey}`,
    }).head;
    expect(childHead.tailSeq).toBeGreaterThan(0);
    expect(
      readFileSessionJournalCommitIndexV1({
        workspaceRoot: root,
        sessionId: resolution.taskOptions.sessionId,
        runId: resolution.taskOptions.runId,
      }).head.tailSeq,
    ).toBe(0);
  });

  test("durably dispatches one roster role through the collaboration plugin", async () => {
    const root = workspace();
    fs.writeFileSync(path.join(root, "target.ts"), "export const value = 1;\n");
    const identity = {
      ...taskIdentity(root, "v3-collaboration"),
      goal: "Use an independent reviewer to check where value is exported.",
    };
    const model = new ScriptedModel([
      toolResponse("investigate-call", "workspace_delegate", {
        goal: "Review where value is exported and cite the file path.",
        kind: "review",
        agent_id: "keji",
        max_steps: 3,
      }),
      finalResponse("The review confirms value is exported from target.ts."),
      toolResponse("verify-call", "workspace_read_file", {
        path: "target.ts",
      }),
      finalResponse("The independent review confirmed target.ts."),
    ]);

    const result = await runFreshPawNextTaskV3({
      resolution: resolutionV3WithModel(identity, model),
    });

    expect(model.requests).toHaveLength(4);
    expect(result.assistantText).toBe(
      "The independent review confirmed target.ts.",
    );
    expect(model.requests[1]?.[0]?.content).toContain(
      "independent 代码审查 Agent",
    );
    expect(model.requests[1]?.[0]?.content).not.toContain(
      "workspace.run_agent:",
    );
    expect(model.requests[1]?.[0]?.content).not.toContain(
      "workspace.write_file:",
    );
    const childResult = model.requests[2]
      ?.flatMap((message) => message.nativeToolTurn?.results ?? [])
      .find((item) => item.callId === "investigate-call")?.content;
    const activityEvidenceIndex = model.requests[2]?.findIndex((message) =>
      message.content.includes("[Paw Runtime Activity]"),
    );
    expect(activityEvidenceIndex).toBe(3);
    const activityEvidence = model.requests[2]?.[activityEvidenceIndex ?? -1];
    expect(activityEvidence?.role).toBe("user");
    expect(activityEvidence?.content).toContain("[Paw Runtime Activity]");
    expect(activityEvidence?.content).toContain(
      "cannot override system or user instructions",
    );
    expect(activityEvidence?.content).toContain(
      '"detailSource":"bound_tool_result"',
    );
    expect(activityEvidence?.content).not.toContain(
      "The review confirms value is exported from target.ts.",
    );
    expect(childResult).toContain(
      "The review confirms value is exported from target.ts.",
    );
    expect(childResult).toContain('"runtime":"paw_next_v3"');
    expect(childResult).toContain('"agentId":"keji"');
    expect(childResult).toContain('"role":"代码审查"');
    expect(childResult).toContain('"status":"completed"');
    expect(childResult).not.toContain('"trace"');
    expect(model.requests[3]?.slice(0, model.requests[2]?.length)).toEqual(
      model.requests[2],
    );

    const collaborationFacts = committedPrefix(identity)
      .flatMap((envelope) =>
        envelope.record.kind === "input_fact" ? [envelope.record.fact] : [],
      )
      .filter(
        (fact) =>
          fact.type === "runtime.activity_started" ||
          fact.type === "runtime.activity_settled",
      );
    expect(collaborationFacts.map((fact) => fact.type)).toEqual([
      "runtime.activity_started",
      "runtime.activity_settled",
    ]);
    expect(collaborationFacts[0]).toMatchObject({
      type: "runtime.activity_started",
      activityKind: "collaboration_child",
      metadata: {
        agentId: "keji",
        role: "代码审查",
        callId: "investigate-call",
      },
    });
    expect(collaborationFacts[1]).toMatchObject({
      type: "runtime.activity_settled",
      status: "completed",
    });
  });

  test("orchestrates a dependency-free mission through one parent tool call", async () => {
    const root = workspace();
    fs.writeFileSync(path.join(root, "target.ts"), "export const value = 1;\n");
    const identity = {
      ...taskIdentity(root, "v3-collaboration-batch"),
      goal: "Investigate and review the exported value in parallel.",
    };
    const model = new ScriptedModel([
      toolResponse("mission-call", "workspace_delegate", {
        goal: "Investigate and review the exported value in parallel.",
        kind: "integration",
        tasks: [
          {
            id: "investigate",
            goal: "Trace the exported value to its definition.",
            kind: "investigation",
            agent_id: "bige",
            max_steps: 3,
          },
          {
            id: "review",
            goal: "Review the exported value for an obvious regression.",
            kind: "review",
            agent_id: "keji",
            max_steps: 3,
          },
        ],
      }),
      finalResponse("The definition is in target.ts."),
      finalResponse("No obvious regression is present."),
      finalResponse("Both independent tasks completed."),
    ]);

    const result = await runFreshPawNextTaskV3({
      resolution: resolutionV3WithModel(identity, model),
    });

    expect(result.assistantText).toBe("Both independent tasks completed.");
    const childPrompts = model.requests
      .slice(1, 3)
      .map((request) => request[0]?.content ?? "")
      .join("\n");
    expect(childPrompts).toContain("independent 代码调查 Agent");
    expect(childPrompts).toContain("independent 代码审查 Agent");
    const parentResults = model.requests[3]
      ?.flatMap((message) => message.nativeToolTurn?.results ?? [])
      .filter((item) => item.callId === "mission-call");
    expect(parentResults).toHaveLength(1);
    expect(parentResults?.[0]?.content).toContain(
      "Mission completed: Investigate and review the exported value in parallel.",
    );
    expect(parentResults?.[0]?.content).toContain(
      "[investigate/bige/completed]",
    );
    expect(parentResults?.[0]?.content).toContain("[review/keji/completed]");

    const activityFacts = committedPrefix(identity).flatMap((envelope) =>
      envelope.record.kind === "input_fact" &&
      (envelope.record.fact.type === "runtime.activity_started" ||
        envelope.record.fact.type === "runtime.activity_settled")
        ? [envelope.record.fact]
        : [],
    );
    const starts = activityFacts.filter(
      (fact) => fact.type === "runtime.activity_started",
    );
    const settlements = activityFacts.filter(
      (fact) => fact.type === "runtime.activity_settled",
    );
    expect(starts).toHaveLength(2);
    expect(settlements).toHaveLength(2);
    expect(new Set(starts.map((fact) => fact.activityId)).size).toBe(2);
    expect(new Set(settlements.map((fact) => fact.activityId))).toEqual(
      new Set(starts.map((fact) => fact.activityId)),
    );
    expect(
      starts.map((fact) =>
        fact.type === "runtime.activity_started"
          ? (fact.metadata as { callId?: string } | undefined)?.callId
          : undefined,
      ),
    ).toEqual(["mission-call:investigate", "mission-call:review"]);
  });

  test("rebuilds a partial mission and runs only the child missing from durable V3 state", async () => {
    const root = workspace();
    const identity = {
      ...taskIdentity(root, "v3-collaboration-partial-recovery"),
      goal: "Recover an interrupted investigation and review mission.",
    };
    const model = new ScriptedModel([
      finalResponse("The investigation completed before the interruption."),
      finalResponse("The remaining review completed after recovery."),
    ]);
    const resolution = resolutionV3WithModel(identity, model);
    const roster = loadPawNextCollaborationRosterV1(root);
    const investigator = roster.agents.find((agent) => agent.id === "bige");
    if (!investigator) throw new Error("Missing investigation AgentSpec");

    const parentCallId = "recover-mission";
    await runPawNextChildV3({
      parentOptions: resolution.taskOptions,
      parentTaskOptions: resolution.taskOptions,
      callId: `${parentCallId}:inspect`,
      goal: "Inspect the target before review.",
      agent: investigator,
      maxModelTurns: 3,
    });
    expect(model.requests).toHaveLength(1);

    const parentFacts: InputFactV1[] = [];
    const nativeChild: SubAgentLauncher = {
      launch(goal, maxSteps, options) {
        const callId = options?.agentId;
        if (!callId) throw new Error("Missing stable child call id");
        return runPawNextChildV3({
          parentOptions: resolution.taskOptions,
          parentTaskOptions: resolution.taskOptions,
          callId,
          goal,
          agent: parseCollaborationAgentSpecV1(options?.args?.agent_spec),
          maxModelTurns: maxSteps ?? 3,
          signal: options?.signal,
        });
      },
      launchStreaming(options) {
        return this.launch(options.goal, options.maxSteps, options);
      },
    };
    const coordinated = createDurableCollaborationCoordinatorV1({
      delegate: nativeChild,
      roster,
      journal: {
        readFacts: () => parentFacts,
        async record(facts) {
          parentFacts.push(...facts);
        },
      },
    });
    const launcher = createAdaptiveCollaborationLauncherV1({
      roster,
      delegate: createBoundedSubAgentLauncherV1({
        delegate: coordinated,
        roster,
      }),
    });
    const plan = normalizeCollaborationDelegationV1({
      roster,
      args: {
        goal: "Inspect and review the target.",
        kind: "integration",
        tasks: [
          {
            id: "inspect",
            goal: "Inspect the target before review.",
            kind: "investigation",
            agent_id: "bige",
            max_steps: 3,
          },
          {
            id: "review",
            goal: "Review the recovered investigation.",
            kind: "review",
            agent_id: "keji",
            depends_on: ["inspect"],
            max_steps: 3,
          },
        ],
      },
    });

    const result = await launcher.launch(plan.goal, undefined, {
      parentRunId: identity.runId,
      agentId: parentCallId,
      args: { delegation_plan: plan },
    });

    expect(result.status).toBe("completed");
    expect(model.requests).toHaveLength(2);
    expect(result.findings).toContain(
      "[inspect/bige/completed] The investigation completed before the interruption.",
    );
    expect(result.findings).toContain(
      "[review/keji/completed] The remaining review completed after recovery.",
    );
    expect(
      parentFacts.filter((fact) => fact.type === "runtime.activity_started"),
    ).toHaveLength(2);
    expect(
      parentFacts.filter((fact) => fact.type === "runtime.activity_settled"),
    ).toHaveLength(2);
  });

  test("renews a child with recent evidence and stops a stalled child at the soft checkpoint", async () => {
    const progressingRoot = workspace();
    fs.writeFileSync(path.join(progressingRoot, "evidence.txt"), "ready\n");
    const progressingIdentity = {
      ...taskIdentity(progressingRoot, "child-soft-renew-progress"),
      goal: "Read evidence and finish.",
    };
    const progressingModel = new ScriptedModel([
      toolResponse("read-progress", "workspace_read_file", {
        path: "evidence.txt",
      }),
      finalResponse("Evidence confirmed after renewal."),
    ]);
    const progressingResolution = resolutionV3WithModel(
      progressingIdentity,
      progressingModel,
    );
    const investigator = loadPawNextCollaborationRosterV1(
      progressingRoot,
    ).agents.find((agent) => agent.id === "bige");
    if (!investigator) throw new Error("Missing investigation AgentSpec");

    const progressed = await runPawNextChildV3({
      parentOptions: progressingResolution.taskOptions,
      parentTaskOptions: progressingResolution.taskOptions,
      callId: "soft-renew-progress",
      goal: "Read evidence and finish.",
      agent: investigator,
      maxModelTurns: 3,
      softModelTurns: 1,
    });
    expect(progressed.status).toBe("completed");
    expect(progressingModel.requests).toHaveLength(2);

    const stalledRoot = workspace();
    const stalledIdentity = {
      ...taskIdentity(stalledRoot, "child-soft-renew-stalled"),
      goal: "Try missing evidence.",
    };
    const stalledModel = new ScriptedModel([
      toolResponse("read-missing", "workspace_read_file", {
        path: "missing.txt",
      }),
      finalResponse("must not run"),
    ]);
    const stalledResolution = resolutionV3WithModel(
      stalledIdentity,
      stalledModel,
    );
    const stalled = await runPawNextChildV3({
      parentOptions: stalledResolution.taskOptions,
      parentTaskOptions: stalledResolution.taskOptions,
      callId: "soft-renew-stalled",
      goal: "Try missing evidence.",
      agent: investigator,
      maxModelTurns: 3,
      softModelTurns: 1,
    });
    expect(stalled.status).toBe("failed");
    expect(stalledModel.requests).toHaveLength(1);
  });

  test("projects delegated test execution into parent verification evidence", async () => {
    const root = workspace();
    fs.writeFileSync(
      path.join(root, "delegated.test.js"),
      'const test = require("node:test");\nconst assert = require("node:assert/strict");\ntest("delegated", () => assert.equal(2 + 2, 4));\n',
    );
    initializeGitWorkspace(root);
    const identity = {
      ...taskIdentity(root, "v3-collaboration-testing"),
      goal: "Delegate the focused existing test and report its real result.",
    };
    const model = new ScriptedModel([
      toolResponse("testing-call", "workspace_delegate", {
        goal: "Run the focused delegated.test.js test and report the result.",
        kind: "testing",
        agent_id: "buou",
        max_steps: 3,
      }),
      toolResponse("forbidden-test-write", "workspace_write_file", {
        path: "forbidden-from-verifier.txt",
        content: "must not exist",
      }),
      toolResponse("child-test", "workspace_run_shell", {
        command: 'node --test "delegated.test.js"',
      }),
      finalResponse("The delegated test passed."),
      finalResponse("The focused delegated test passed."),
    ]);

    const result = await runFreshPawNextTaskV3({
      resolution: resolutionV3WithModel(identity, model),
    });

    expect(result.assistantText).toBe("The focused delegated test passed.");
    expect(model.requests[1]?.[0]?.content).toContain(
      "independent 验收测试 Agent",
    );
    expect(
      fs.existsSync(path.join(root, "forbidden-from-verifier.txt")),
    ).toBeFalse();
    expect(
      model.requests
        .flat()
        .flatMap((message) => message.nativeToolTurn?.results ?? [])
        .find((item) => item.callId === "forbidden-test-write")?.content,
    ).toContain("Unknown runtime tool: workspace_write_file");
    const parentResult = model.requests
      .flat()
      .flatMap((message) => message.nativeToolTurn?.results ?? [])
      .find((item) => item.callId === "testing-call")?.content;
    expect(parentResult).toContain('"agentId":"buou"');
    expect(parentResult).toContain('"testsRun"');
    expect(parentResult).toContain('"passed":true');
    expect(parentResult).toContain('"exitCode":0');
    expect(parentResult).toContain('"timedOut":false');
    expect(parentResult).toContain('"effectProfile":"execute"');
    expect(parentResult).toContain('"verdict":"pass"');
    expect(
      result.inputFacts.some(
        (fact) => fact.type === "completion.review_claimed",
      ),
    ).toBeFalse();
    const childWorktrees = path.join(
      root,
      ".paw",
      "collaboration",
      "worktrees",
    );
    expect(
      fs.existsSync(childWorktrees)
        ? fs
            .readdirSync(childWorktrees)
            .filter((entry) => !entry.endsWith(".json"))
        : [],
    ).toEqual([]);
  });

  test("keeps command completion distinct from a delegated test failure", async () => {
    const root = workspace();
    fs.writeFileSync(
      path.join(root, "delegated-failure.test.js"),
      'const test = require("node:test");\nconst assert = require("node:assert/strict");\ntest("fails", () => assert.equal(1, 2));\n',
    );
    const identity = {
      ...taskIdentity(root, "v3-collaboration-testing-failure"),
      goal: "Delegate the focused failing test and preserve its real result.",
    };
    const model = new ScriptedModel([
      toolResponse("testing-failure-call", "workspace_delegate", {
        goal: "Run delegated-failure.test.js and report the exact result.",
        kind: "testing",
        agent_id: "buou",
        max_steps: 3,
      }),
      toolResponse("child-failing-test", "workspace_run_shell", {
        command: 'node --test "delegated-failure.test.js"',
      }),
      finalResponse("The command finished."),
      finalResponse("The delegated command completed."),
    ]);

    const result = await runFreshPawNextTaskV3({
      resolution: resolutionV3WithModel(identity, model),
    });
    const parentResult = model.requests
      .flat()
      .flatMap((message) => message.nativeToolTurn?.results ?? [])
      .find((item) => item.callId === "testing-failure-call")?.content;

    expect(result.assistantText).toBe("The delegated command completed.");
    expect(parentResult).toContain('"status":"completed"');
    expect(parentResult).toContain('"exitCode":1');
    expect(parentResult).toContain('"passed":false');
    expect(parentResult).toContain('"verdict":"fail"');
  });

  test("materializes a registered read-write AgentSpec in a native V3 child", async () => {
    const root = workspace();
    const agents = path.join(root, ".paw", "agents");
    fs.mkdirSync(agents, { recursive: true });
    fs.writeFileSync(
      path.join(agents, "writer.md"),
      `---
id: writer
name: Writer
role: code implementation
description: Writes one assigned file and verifies the result
capabilities: implementation
tools: read_file, write_file
childPolicy: read_write
model: inherit
outputFormat: Return changed files and verification evidence.
canSpawn: false
maxSteps: 4
kind: worker
---
Implement only the assigned file. Keep the change minimal.
`,
    );
    const identity = {
      ...taskIdentity(root, "v3-collaboration-writer"),
      goal: "Delegate creation of generated.ts to the registered writer.",
    };
    const model = new ScriptedModel([
      toolResponse("writer-call", "workspace_delegate", {
        goal: "Create generated.ts exporting value 42.",
        kind: "implementation",
        agent_id: "writer",
        max_steps: 4,
      }),
      toolResponse("forbidden-shell", "workspace_run_shell", {
        command: "echo must-not-run",
      }),
      toolResponse("child-write", "workspace_write_file", {
        path: "generated.ts",
        content: "export const value = 42;\n",
      }),
      finalResponse("Created generated.ts with the requested export."),
      finalResponse("The registered writer completed the delegated change."),
      finalResponse(
        JSON.stringify({
          decision: "allow",
          reasonCode: "evidence_sufficient",
          summary: "The delegated file change is present in child evidence.",
        }),
      ),
    ]);

    const result = await runFreshPawNextTaskV3({
      resolution: resolutionV3WithModel(identity, model),
    });

    expect(result.assistantText).toBe(
      "The registered writer completed the delegated change.",
    );
    expect(fs.readFileSync(path.join(root, "generated.ts"), "utf8")).toBe(
      "export const value = 42;\n",
    );
    expect(model.requests[1]?.[0]?.content).toContain(
      "independent code implementation Agent",
    );
    expect(model.requests[1]?.[0]?.content).toContain(
      "You may modify workspace files",
    );
    expect(
      model.requests[2]
        ?.flatMap((message) => message.nativeToolTurn?.results ?? [])
        .find((item) => item.callId === "forbidden-shell")?.content,
    ).toContain("Unknown runtime tool: workspace_run_shell");
    const parentResult = model.requests
      .flat()
      .flatMap((message) => message.nativeToolTurn?.results ?? [])
      .find((item) => item.callId === "writer-call")?.content;
    expect(parentResult).toContain('"agentId":"writer"');
    expect(parentResult).toContain('"childPolicy":"read_write"');
    expect(parentResult).toContain('"runtime":"paw_next_v3"');
    expect(parentResult).toContain('"changedFiles":["generated.ts"]');
    expect(
      result.inputFacts.some(
        (fact) => fact.type === "completion.review_claimed",
      ),
    ).toBeTrue();

    const started = committedPrefix(identity)
      .flatMap((envelope) =>
        envelope.record.kind === "input_fact" ? [envelope.record.fact] : [],
      )
      .find(
        (fact) =>
          fact.type === "runtime.activity_started" &&
          fact.activityKind === "collaboration_child",
      );
    expect(started).toMatchObject({
      type: "runtime.activity_started",
      metadata: {
        agentId: "writer",
        childPolicy: "read_write",
        callId: "writer-call",
      },
    });
  });

  test("injects replayable advice after four read-only turns without blocking tools", async () => {
    const root = workspace();
    for (let index = 1; index <= 5; index += 1) {
      fs.writeFileSync(path.join(root, `evidence-${index}.txt`), `${index}\n`);
    }
    const identity = {
      ...taskIdentity(root, "v3-progress-advisor"),
      goal: "Inspect the repository and report the relevant finding.",
    };
    const model = new ScriptedModel([
      toolResponse("read-1", "workspace_read_file", {
        path: "evidence-1.txt",
      }),
      toolResponse("read-2", "workspace_read_file", {
        path: "evidence-2.txt",
      }),
      toolResponse("read-3", "workspace_read_file", {
        path: "evidence-3.txt",
      }),
      toolResponse("read-4", "workspace_read_file", {
        path: "evidence-4.txt",
      }),
      toolResponse("read-5", "workspace_read_file", {
        path: "evidence-5.txt",
      }),
      finalResponse("The repository evidence has been inspected."),
    ]);

    const result = await runFreshPawNextTaskV3({
      resolution: resolutionV3WithModel(identity, model),
    });

    expect(result.assistantText).toBe(
      "The repository evidence has been inspected.",
    );
    expect(model.requests).toHaveLength(6);
    const firstAdviceIndex = model.requests[4]?.findIndex(
      (message) =>
        message.role === "user" &&
        message.content.includes("[Paw Progress Advice]") &&
        message.content.includes(
          "4 model turns have produced no source mutation or verification result",
        ),
    );
    const nextAdviceIndex = model.requests[5]?.findIndex((message) =>
      message.content.includes("[Paw Progress Advice]"),
    );
    expect(firstAdviceIndex).toBeGreaterThanOrEqual(0);
    expect(nextAdviceIndex).toBe(firstAdviceIndex);
    expect(model.requests[5]?.[nextAdviceIndex ?? -1]).toEqual(
      model.requests[4]?.[firstAdviceIndex ?? -1],
    );
    expect(model.requests[5]?.length).toBeGreaterThan(
      model.requests[4]?.length ?? 0,
    );
  });

  test("requires a decisive hard-stall replan while preserving the main Agent's choice", async () => {
    const root = workspace();
    for (let index = 1; index <= 16; index += 1) {
      fs.writeFileSync(path.join(root, `stall-${index}.txt`), `${index}\n`);
    }
    const identity = {
      ...taskIdentity(root, "v3-progress-advisor-delegation-gate"),
      goal: "Investigate until a materially different evidence path is needed.",
    };
    const responses = Array.from({ length: 16 }, (_, index) =>
      toolResponse(`stall-read-${index + 1}`, "workspace_read_file", {
        path: `stall-${index + 1}.txt`,
      }),
    );
    const model = new ScriptedModel([
      ...responses,
      toolResponse("blocked-stall-read", "workspace_read_file", {
        path: "stall-1.txt",
      }),
      toolResponse("replanned-shell", "workspace_run_shell", {
        command: 'node -e "process.exit(0)"',
      }),
      finalResponse("Stopped after the bounded replan checkpoint."),
    ]);

    const result = await runFreshPawNextTaskV3({
      resolution: resolutionV3WithModel(
        identity,
        model,
        { maxModelTurns: 20, maxTotalModelTurns: 24 },
        false,
        true,
      ),
    });

    expect(result.assistantText).toBe(
      "Stopped after the bounded replan checkpoint.",
    );
    expect(model.requestOptions[16]?.toolNames).toEqual(
      expect.arrayContaining([
        "workspace_read_file",
        "workspace_write_file",
        "workspace_run_shell",
        "workspace_delegate",
      ]),
    );
    expect(model.requestOptions[17]?.toolNames).toEqual(
      expect.arrayContaining([
        "workspace_read_file",
        "workspace_write_file",
        "workspace_run_shell",
        "workspace_delegate",
      ]),
    );
    expect(
      model.requests[17]
        ?.flatMap((message) => message.nativeToolTurn?.results ?? [])
        .find((item) => item.callId === "blocked-stall-read")?.content,
    ).toContain("E_BOUNDED_REPLAN_GATE");
    expect(
      model.requests[16]?.some(
        (message) =>
          message.role === "user" &&
          message.content.includes("recommendedAction=main_owned_replan"),
      ),
    ).toBeTrue();
    expect(
      model.requests[18]
        ?.flatMap((message) => message.nativeToolTurn?.results ?? [])
        .find((item) => item.callId === "replanned-shell")?.content,
    ).toContain('"exit_code":0');
  }, 60_000);

  test("routes failed verification to one semantic review", async () => {
    const root = workspace();
    const identity = {
      ...taskIdentity(root, "v3-deterministic-completion-gate"),
      goal: "Implement the requested source change.",
    };
    const model = new ScriptedModel([
      toolResponse("write-source", "workspace_write_file", {
        path: "a.ts",
        content: "export const value = 1;\n",
      }),
      toolResponse("failed-test", "workspace_run_shell", {
        command: 'node --test "missing.test.js"',
      }),
      finalResponse("The source change is complete."),
      finalResponse(
        JSON.stringify({
          decision: "continue",
          reasonCode: "unresolved_failure",
          summary: "Create the missing focused test and run it again.",
        }),
      ),
      toolResponse("write-test", "workspace_write_file", {
        path: "missing.test.js",
        content:
          'const test = require("node:test");\nconst assert = require("node:assert/strict");\ntest("value", () => assert.equal(1, 1));\n',
      }),
      toolResponse("passing-test", "workspace_run_shell", {
        command: 'node --test "missing.test.js"',
      }),
      finalResponse("The source change now has passing verification."),
      finalResponse(
        JSON.stringify({
          decision: "allow",
          reasonCode: "evidence_sufficient",
          summary: "The failed target now passes after the source mutation.",
        }),
      ),
    ]);

    const result = await runFreshPawNextTaskV3({
      resolution: resolutionV3WithModel(identity, model, {}, true, true),
    });

    expect(result.assistantText).toBe(
      "The source change now has passing verification.",
    );
    expect(model.requests).toHaveLength(8);
    expect(
      result.inputFacts
        .filter((fact) => fact.type === "completion.review_claimed")
        .at(0)?.reviewerId,
    ).toBe(COMPLETION_REVIEWER_POLICY_VERSION_V1);
    expect(
      result.inputFacts
        .filter((fact) => fact.type === "completion.review_settled")
        .map((fact) => ({ verdict: fact.verdict, reasonCode: fact.reasonCode }))
        .at(0),
    ).toEqual({
      verdict: "block",
      reasonCode: "unresolved_failure",
    });
    expect(
      result.inputFacts.filter((fact) => fact.type === "work.segment_started"),
    ).toHaveLength(1);
  }, 30_000);

  test("continues source work once when model review stays truncated", async () => {
    const root = workspace();
    const identity = {
      ...taskIdentity(root, "v3-completion-review-unavailable"),
      goal: "Implement the requested source change.",
    };
    const model = new ScriptedModel([
      toolResponse("write-source", "workspace_write_file", {
        path: "a.test.js",
        content: 'import test from "node:test";\ntest("value", () => {});\n',
      }),
      finalResponse("Initial answer without reliable verification."),
      truncatedResponse(),
      truncatedResponse(),
      toolResponse("passing-test", "workspace_run_shell", {
        command: 'node --test "a.test.js"',
      }),
      finalResponse("Rechecked the diff and ran focused verification."),
      finalResponse(
        JSON.stringify({
          decision: "allow",
          reasonCode: "evidence_sufficient",
          summary: "The focused verification passed after the source change.",
        }),
      ),
    ]);

    const result = await runFreshPawNextTaskV3({
      resolution: resolutionV3WithModel(identity, model, {}, true, true),
    });

    expect(result.assistantText).toBe(
      "Rechecked the diff and ran focused verification.",
    );
    expect(
      result.inputFacts
        .filter((fact) => fact.type === "completion.review_settled")
        .map((fact) => ({ status: fact.status, verdict: fact.verdict })),
    ).toEqual([
      { status: "unknown", verdict: "unknown" },
      { status: "completed", verdict: "allow" },
    ]);
    expect(
      result.inputFacts.filter((fact) => fact.type === "work.segment_started"),
    ).toHaveLength(1);
    expect(model.requestOptions.slice(2, 4)).toEqual([
      { maxOutputTokens: 4_096, thinkingEnabled: false, toolNames: [] },
      { maxOutputTokens: 4_096, thinkingEnabled: false, toolNames: [] },
    ]);
  });

  test("runs completion review outside the loop and resumes blocked work as one durable segment", async () => {
    const root = workspace();
    const identity = {
      ...taskIdentity(root, "v3-completion-review"),
      goal: "Verify the requested result before delivery.",
    };
    const model = new ScriptedModel([
      responseWithUsage(finalResponse("Initial answer without evidence."), 100),
      responseWithUsage(
        finalResponse(
          JSON.stringify({
            decision: "continue",
            reasonCode: "missing_verification",
            summary: "Run a focused verification and report its result.",
          }),
        ),
        200,
      ),
      responseWithUsage(
        finalResponse("Verified answer with focused evidence."),
        300,
      ),
      responseWithUsage(
        finalResponse(
          JSON.stringify({
            decision: "allow",
            reasonCode: "evidence_sufficient",
            summary:
              "The revised delivery addresses the requested verification.",
          }),
        ),
        400,
      ),
    ]);
    const costTracker = new CostTracker();
    const settlements: PawModelSettlementTelemetryV1[] = [];

    const result = await runFreshPawNextTaskV3({
      resolution: resolutionV3WithModel(identity, model),
      costTracker,
      onModelSettlement: (event) => settlements.push(event),
    });

    expect(result.assistantText).toBe("Verified answer with focused evidence.");
    expect(model.requests).toHaveLength(4);
    expect(costTracker.snapshot().promptTokens).toBe(1_000);
    expect(settlements.map((event) => event.phase)).toEqual([
      "agent_loop",
      "completion_review",
      "agent_loop",
      "completion_review",
    ]);
    expect(
      result.inputFacts.filter(
        (fact) => fact.type === "completion.review_claimed",
      ),
    ).toHaveLength(2);
    expect(
      result.inputFacts
        .filter((fact) => fact.type === "completion.review_settled")
        .map((fact) => fact.verdict),
    ).toEqual(["block", "allow"]);
    expect(
      result.inputFacts.filter((fact) => fact.type === "work.segment_started"),
    ).toHaveLength(1);
    expect(result.state).toMatchObject({
      segmentIndex: 1,
      totalModelTurns: 2,
      decision: { kind: "completed" },
    });
  });

  test("recovers blocking review feedback from accepted and refreshed-decision crash windows", async () => {
    for (const window of ["accepted", "decision"] as const) {
      const root = workspace();
      const identity = taskIdentity(root, `v3-review-recovery-${window}`);
      const seed = resolutionV3WithModel(
        identity,
        new ScriptedModel([finalResponse("Initial delivery.")]),
      );
      await runFreshPawNextTaskV3({ resolution: seed });
      await appendBlockingReviewFeedback(seed, window);

      const model = new ScriptedModel([
        finalResponse(`Recovered ${window} feedback.`),
        finalResponse(
          JSON.stringify({
            decision: "allow",
            reasonCode: "evidence_sufficient",
            summary: "The recovered work segment addressed the feedback.",
          }),
        ),
      ]);
      const recovered = resolutionV3WithReplacementModel(seed, model);
      if (window === "accepted") {
        const report = await scanAndResumePawNextRunsWithCatalogV1({
          workspaceRoot: root,
          resolveProduct: () => recovered,
        });
        expect(statusOf(report, identity)).toBe("resumed");
      } else {
        await runExistingPawNextTaskV3({ resolution: recovered });
      }
      const prefix = committedPrefix(identity);
      const facts = inputFacts(prefix);

      expect(model.requests).toHaveLength(2);
      expect(
        facts.filter((fact) => fact.type === "work.segment_started"),
      ).toHaveLength(1);
      expect(
        facts.filter(
          (fact) =>
            fact.type === "input.promoted" &&
            fact.inputId.startsWith("completion-review-feedback-"),
        ),
      ).toHaveLength(1);
    }
  });

  test("distills artifact-backed history through the external context plugin", async () => {
    const root = workspace();
    fs.writeFileSync(path.join(root, "compact-evidence.txt"), "compact\n");
    const identity = taskIdentity(root, "v3-context-compaction");
    const model = new DynamicCompactionModel();
    const seed = {
      ...profileV3(),
      budget: {
        ...profileV3().budget,
        contextWindowTokens: 8_000,
        reservedOutputTokens: 1_000,
        estimationMarginTokens: 256,
      },
    };
    const first = buildPawNextTaskProfileV3({
      identity,
      profile: seed,
      apiKey: API_KEY,
    });
    model.copyIdentity(first.taskOptions.model);
    const built = buildPawNextTaskProfileV3({
      identity,
      profile: { ...seed, configHash: first.configHash },
      apiKey: API_KEY,
    });
    const resolution = Object.freeze({
      ...built,
      taskOptions: Object.freeze({ ...built.taskOptions, model }),
    });

    const result = await runFreshPawNextTaskV3({ resolution });

    expect(result.assistantText).toBe("compaction complete");
    expect(model.agentCalls).toBe(8);
    expect(model.distillerCalls).toBe(1);
    expect(model.verifierCalls).toBe(1);
    expect(model.distillerSawResolvedText).toBeTrue();
    expect(
      result.inputFacts.filter(
        (fact) => fact.type === "context.checkpoint_recorded",
      ),
    ).toHaveLength(1);
    expect(
      result.inputFacts.filter(
        (fact) => fact.type === "context.checkpoint_distillation_claimed",
      ),
    ).toHaveLength(1);
  }, 20_000);

  test("runs segment zero through real file evidence and returns reducer-v2 state", async () => {
    const root = workspace();
    fs.writeFileSync(path.join(root, "v3-evidence.txt"), "v3 evidence\n");
    const identity = taskIdentity(root, "v3-fresh");
    const model = new ScriptedModel([
      toolResponse("v3-read", "workspace_read_file", {
        path: "v3-evidence.txt",
      }),
      finalResponse("v3 final"),
    ]);
    const resolution = resolutionV3WithModel(identity, model);

    const result = await runFreshPawNextTaskV3({ resolution });

    expect(result.assistantText).toBe("v3 final");
    expect(result.state).toMatchObject({
      reducerVersion: "paw.interactive-control.v2",
      segmentIndex: 0,
      segmentModelTurns: 2,
      totalModelTurns: 2,
      segmentSettledToolCalls: 1,
      totalSettledToolCalls: 1,
      decision: { kind: "completed" },
    });
    expect(Object.isFrozen(result.state)).toBeTrue();
    expect(Object.isFrozen(result.state.decision)).toBeTrue();
    expect(attemptConfigHash(result.inputFacts)).toBe(resolution.configHash);
    expect(
      result.inputFacts.filter((fact) => fact.type === "work.segment_started"),
    ).toHaveLength(0);
    const occurrences = projectCanonicalDurableJsonPayloadBindingsV1(
      committedPrefix(identity),
    ).filter(
      (item) =>
        item.location.kind === "model_response" ||
        item.location.kind === "tool_observation",
    );
    expect(occurrences).toHaveLength(3);
    expect(
      occurrences.every((item) => item.payload.kind === "artifact_ref"),
    ).toBeTrue();

    const before = committedPrefix(identity);
    const probe = new ScriptedModel([]);
    const reopened = await runExistingPawNextTaskV3({
      resolution: resolutionV3WithReplacementModel(resolution, probe),
    });
    expect(reopened.assistantText).toBe("v3 final");
    expect(reopened.state).toEqual(result.state);
    expect(probe.requests).toHaveLength(0);
    expect(committedPrefix(identity)).toEqual(before);
  });

  test("installs the root memory plugin and durably records explicit off mode", async () => {
    const root = workspace();
    const identity = taskIdentity(root, "v3-memory-off");
    const model = new ScriptedModel([finalResponse("memory-off complete")]);
    const seed = {
      ...profileV3(),
      memory: {
        policyVersion: PAW_NEXT_MEMORY_PLUGIN_POLICY_VERSION_V1,
        mode: "off" as const,
        providerVersion: PAW_NEXT_MEMORY_V2_PROVIDER_VERSION_V1,
        scope: {
          tenantId: "tenant-a",
          userId: "user-a",
          workspaceId: "workspace-a",
          repositoryId: "repo-a",
        },
        maxCards: 3,
        maxInjectedTokens: 512,
      },
    };
    const first = buildPawNextTaskProfileV3({
      identity,
      profile: seed,
      apiKey: API_KEY,
    });
    model.copyIdentity(first.taskOptions.model);
    const built = buildPawNextTaskProfileV3({
      identity,
      profile: { ...seed, configHash: first.configHash },
      apiKey: API_KEY,
    });
    const resolution = Object.freeze({
      ...built,
      taskOptions: Object.freeze({ ...built.taskOptions, model }),
    });

    const result = await runFreshPawNextTaskV3({ resolution });
    const receipts = result.inputFacts.filter(
      (fact) => fact.type === "memory.retrieval_settled",
    );

    expect(result.assistantText).toBe("memory-off complete");
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      trigger: "task_start",
      status: "disabled",
      cards: [],
      reasonCode: "memory_disabled_by_profile",
    });
    expect(
      model.requests[0]?.some((message) =>
        message.content.includes("[Paw Memory Evidence]"),
      ),
    ).toBeFalse();
  });

  test("executes scope-bound memory search through the V3 plugin and journals the result", async () => {
    const root = workspace();
    const identity = {
      ...taskIdentity(root, "v3-memory-tool"),
      goal: "为什么后来更换了部署方式？",
    };
    const model = new ScriptedModel([
      toolResponse("memory-search-1", "memory_search_atoms", {
        query: "更换部署方式的原因",
        max_results: 3,
      }),
      finalResponse("因为原部署方式的维护成本过高。"),
    ]);
    const memory = {
      policyVersion: PAW_NEXT_MEMORY_PLUGIN_POLICY_VERSION_V1,
      mode: "read_only" as const,
      providerVersion: PAW_NEXT_MEMORY_V2_PROVIDER_VERSION_V1,
      scope: {
        tenantId: "tenant-a",
        userId: "user-a",
        workspaceId: "workspace-a",
        repositoryId: "repo-a",
      },
      maxCards: 3,
      maxInjectedTokens: 512,
    };
    const seed = { ...profileV3(), memory };
    const first = buildPawNextTaskProfileV3({
      identity,
      profile: seed,
      apiKey: API_KEY,
    });
    model.copyIdentity(first.taskOptions.model);
    const built = buildPawNextTaskProfileV3({
      identity,
      profile: { ...seed, configHash: first.configHash },
      apiKey: API_KEY,
    });
    const events: MemoryToolEventV1[] = [];
    let retrievals = 0;
    const result = await runFreshPawNextTaskV3({
      resolution: Object.freeze({
        ...built,
        taskOptions: Object.freeze({ ...built.taskOptions, model }),
      }),
      memoryProvider: {
        providerVersion: PAW_NEXT_MEMORY_V2_PROVIDER_VERSION_V1,
        async retrieve(query) {
          retrievals += 1;
          expect(query.scope).toEqual(memory.scope);
          return {
            status: "completed",
            cards: [
              {
                id: "memory-cause-1",
                revision: 1,
                kind: "episodic",
                statement: "因为维护成本过高，用户更换了部署方式。",
                applicability: "reference",
                scope: { repositoryId: "repo-a" },
                sources: [
                  {
                    kind: "memory_store_evidence",
                    ref: "journal:prior#input-7",
                  },
                ],
                confidence: 0.95,
                contentHash: "memory-cause-hash",
              },
            ],
          };
        },
      },
      memoryTopicEvidenceStore: {
        scope: memory.scope,
        async load() {
          return [];
        },
      },
      memoryPersonaStore: {
        scope: memory.scope,
        async load() {
          return [];
        },
      },
      memoryRawEvidenceArchive: {
        scope: memory.scope,
        async put() {},
        async resolve() {
          return [];
        },
      },
      onMemoryToolEvent: (event) => events.push(event),
    });

    expect(result.assistantText).toBe("因为原部署方式的维护成本过高。");
    expect(retrievals).toBe(3); // prewarm + auto-resolved packet + explicit fallback tool
    expect(model.requestOptions[0]?.toolNames).toContain("memory_search_atoms");
    expect(
      model.requests[1]
        ?.flatMap((message) => message.nativeToolTurn?.results ?? [])
        .some((result) => result.content.includes("因为维护成本过高")),
    ).toBeTrue();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tool: "memory.search_atoms",
      status: "completed",
      cacheHit: false,
    });
    expect(
      result.inputFacts.some(
        (fact) =>
          fact.type === "tool.settled" &&
          fact.callId === "memory-search-1" &&
          fact.status === "completed",
      ),
    ).toBeTrue();
  });

  test("routes searchable L0 evidence through the plugin-owned evidence-first resolver", async () => {
    const root = workspace();
    const identity = {
      ...taskIdentity(root, "v3-evidence-first-memory"),
      goal: "Which city did I visit?",
    };
    const model = new ScriptedModel([
      finalResponse(
        JSON.stringify({
          answerShape: "lookup",
          temporalMode: "any",
          roleConstraint: "user",
          requirements: [
            {
              label: "city visited",
              searchText: "Which city did I visit?",
              relation: "direct",
              coverageMode: "any",
              minimumEvidence: 1,
            },
          ],
        }),
      ),
      finalResponse(
        JSON.stringify({
          assessments: [
            {
              requirementId: "requirement-1",
              supportingEvidenceRefs: ["journal:prior#input-7"],
              contradictingEvidenceRefs: [],
              unknownEvidenceRefs: [],
            },
          ],
        }),
      ),
      finalResponse("Kyoto"),
    ]);
    const memory = {
      policyVersion: PAW_NEXT_MEMORY_PLUGIN_POLICY_VERSION_V1,
      mode: "read_only" as const,
      providerVersion: PAW_NEXT_MEMORY_V2_PROVIDER_VERSION_V1,
      scope: {
        tenantId: "tenant-a",
        userId: "user-a",
        workspaceId: "workspace-a",
        repositoryId: "repo-a",
      },
      maxCards: 3,
      maxInjectedTokens: 512,
    };
    const seed = { ...profileV3(), memory };
    const first = buildPawNextTaskProfileV3({
      identity,
      profile: seed,
      apiKey: API_KEY,
    });
    model.copyIdentity(first.taskOptions.model);
    const built = buildPawNextTaskProfileV3({
      identity,
      profile: { ...seed, configHash: first.configHash },
      apiKey: API_KEY,
    });
    let searches = 0;
    const result = await runFreshPawNextTaskV3({
      resolution: Object.freeze({
        ...built,
        taskOptions: Object.freeze({ ...built.taskOptions, model }),
      }),
      memoryProvider: {
        providerVersion: PAW_NEXT_MEMORY_V2_PROVIDER_VERSION_V1,
        async retrieve() {
          return { status: "completed", cards: [] };
        },
      },
      memoryRawEvidenceArchive: {
        scope: memory.scope,
        async put() {},
        async resolve() {
          return [];
        },
        async search() {
          searches += 1;
          return [
            {
              evidenceRef: "journal:prior#input-7",
              sourceKind: "user_input" as const,
              sourceSeq: 7,
              authority: "user_asserted" as const,
              content: "[user_input hit] I visited Kyoto.",
              contentHash: "bundle-hash",
              hitContent: "I visited Kyoto.",
              hitContentHash: "hit-hash",
              createdAt: "2026-08-01T00:00:00.000Z",
            },
          ];
        },
      },
    });

    expect(result.assistantText).toBe("Kyoto");
    expect(searches).toBe(1);
    expect(
      model.requests.some((request) =>
        request.some((message) => message.content.includes("I visited Kyoto.")),
      ),
    ).toBeTrue();
  });

  test("runs the opt-in memory writer after a terminal decision through durable two-phase facts", async () => {
    const root = workspace();
    const identity = {
      ...taskIdentity(root, "v3-memory-write"),
      goal: "以后都使用中文写文档，请记住。",
    };
    const model = new ScriptedModel([
      finalResponse("好的，之后使用中文文档。"),
      finalResponse(
        JSON.stringify({
          atoms: [
            {
              kind: "instruction",
              action: "store",
              statement: "默认使用中文编写文档。",
              keywords: ["中文", "文档"],
              authority: "user_asserted",
              confidence: 0.98,
              priority: 90,
              sourceSeqs: [2],
              targetIds: [],
            },
          ],
        }),
      ),
      finalResponse(
        JSON.stringify({
          topics: [
            {
              topicId: null,
              family: "instruction",
              canonicalName: "文档语言偏好",
              confidence: 0.96,
              members: [
                {
                  memoryId: "semantic-memory-1",
                  role: "primary",
                  confidence: 0.98,
                },
              ],
            },
          ],
        }),
      ),
    ]);
    const seed = {
      ...profileV3(),
      memory: {
        policyVersion: PAW_NEXT_MEMORY_PLUGIN_POLICY_VERSION_V1,
        mode: "read_write" as const,
        providerVersion: PAW_NEXT_MEMORY_V2_PROVIDER_VERSION_V1,
        scope: {
          tenantId: "tenant-a",
          userId: "user-a",
          workspaceId: "workspace-a",
          repositoryId: "repo-a",
        },
        maxCards: 3,
        maxInjectedTokens: 512,
        writer: {
          policyVersion: "paw.memory-writer.v1" as const,
          extractorVersion: "paw.memory-atom-extractor.json.v1" as const,
          maxAtoms: 8,
          maxSourceChars: 24_000,
          topicOrganizer: {
            policyVersion: "paw.memory-topic-organization.v1" as const,
            extractorVersion: "paw.memory-topic-extractor.json.v1" as const,
            maxTopics: 8,
          },
          personaProjector: {
            policyVersion: "paw.memory-persona-evidence-projector.v1" as const,
            maxClaims: 8,
            maxChars: 2_048,
            minimumConfidence: 0.7,
          },
          rawEvidenceResolver: {
            policyVersion: "paw.memory-raw-evidence-resolver.v1" as const,
            maxSpans: 6,
            maxChars: 6_000,
          },
          coveragePlanner: {
            policyVersion: "paw.memory-evidence-coverage-planner.v1" as const,
            extractorVersion:
              "paw.memory-evidence-requirement-planner.json.v1" as const,
            maxRequirements: 4,
            maxExpansionTopics: 3,
            maxSupplementalStates: 8,
            maxSupplementalChars: 4_096,
          },
          evidencePlanner: {
            policyVersion: "paw.memory-topic-evidence-planner.v1" as const,
            maxIndexTopics: 96,
            maxSelectedTopics: 3,
            maxStates: 16,
            maxEvidenceChars: 8_000,
          },
        },
      },
    };
    const first = buildPawNextTaskProfileV3({
      identity,
      profile: seed,
      apiKey: API_KEY,
    });
    model.copyIdentity(first.taskOptions.model);
    const built = buildPawNextTaskProfileV3({
      identity,
      profile: { ...seed, configHash: first.configHash },
      apiKey: API_KEY,
    });
    const resolution = Object.freeze({
      ...built,
      taskOptions: Object.freeze({ ...built.taskOptions, model }),
    });
    let applyCalls = 0;
    let topicApplyCalls = 0;
    let archivedEvidenceSpans = 0;
    const writerEvents: unknown[] = [];
    const result = await runFreshPawNextTaskV3({
      resolution,
      memoryProvider: {
        providerVersion: PAW_NEXT_MEMORY_V2_PROVIDER_VERSION_V1,
        async retrieve() {
          return { status: "completed", cards: [] };
        },
      },
      memoryWriterStore: {
        async recall() {
          return [];
        },
        async apply(input) {
          applyCalls += 1;
          expect(input.atoms[0]).toMatchObject({
            kind: "instruction",
            sourceSeqs: [2],
          });
          return {
            storedIds: ["semantic-memory-1"],
            invalidatedIds: [],
            skippedAtomIds: [],
          };
        },
      },
      memoryTopicOrganizerStore: {
        async prepare(input) {
          expect(input.sourceMemoryIds).toEqual(["semantic-memory-1"]);
          return {
            sourceRevision: "source-revision-1",
            entries: [
              {
                id: "semantic-memory-1",
                kind: "semantic",
                statement: "默认使用中文编写文档。",
                keywords: ["instruction", "中文", "文档"],
                confidence: 0.98,
              },
            ],
            existingTopics: [],
          };
        },
        async apply(input) {
          topicApplyCalls += 1;
          expect(input.proposals[0]).toMatchObject({
            family: "instruction",
            canonicalName: "文档语言偏好",
          });
          return {
            topicIds: ["topic-1"],
            snapshotIds: ["snapshot-1"],
          };
        },
      },
      memoryTopicEvidenceStore: {
        scope: seed.memory.scope,
        async load() {
          return [];
        },
      },
      memoryPersonaStore: {
        scope: seed.memory.scope,
        async load() {
          return [
            {
              id: "profile-memory-1",
              kind: "profile" as const,
              repo: "repo-a",
              created: "2026-08-25T00:00:00.000Z",
              tValid: "2026-08-25T00:00:00.000Z",
              tInvalid: null,
              source: "user_statement" as const,
              confidence: 0.96,
              evidence: ["journal:prior-run#input-fact-2"],
              freq: 0,
              utility: 0,
              insight: "用户偏好使用中文编写文档。",
              supportCount: 3,
            },
          ];
        },
      },
      memoryRawEvidenceArchive: {
        scope: seed.memory.scope,
        async put(spans) {
          archivedEvidenceSpans += spans.length;
          expect(spans[0]).toMatchObject({
            evidenceRef: `journal:${identity.runId}#input-fact-2`,
            sourceKind: "user_input",
          });
        },
        async resolve() {
          return [];
        },
      },
      onMemoryWriterEvent: (event) => writerEvents.push(event),
    });

    expect(model.requests).toHaveLength(3);
    expect(result.assistantText).toBe("好的，之后使用中文文档。");
    expect(model.requests[1]?.[0]?.content).toContain(
      "long-term memory proposal extractor",
    );
    expect(
      model.requests[0]?.some((message) =>
        message.content.includes(
          '"schemaVersion":"paw.memory-persona-evidence.v1"',
        ),
      ),
    ).toBeTrue();
    expect(applyCalls).toBe(1);
    expect(topicApplyCalls).toBe(1);
    expect(archivedEvidenceSpans).toBe(1);
    expect(
      result.inputFacts
        .filter(
          (fact) =>
            fact.type.startsWith("memory.write") ||
            fact.type === "memory.candidate_staged",
        )
        .map((fact) => fact.type),
    ).toEqual([
      "memory.write_claimed",
      "memory.candidate_staged",
      "memory.write_settled",
    ]);
    expect(
      result.inputFacts
        .filter((fact) => fact.type === "memory.topic_evidence_settled")
        .map((fact) => fact.status),
    ).toEqual(["noop"]);
    expect(
      result.inputFacts
        .filter((fact) => fact.type === "memory.persona_projection_settled")
        .map((fact) => fact.status),
    ).toEqual(["completed"]);
    expect(
      result.inputFacts
        .filter((fact) => fact.type === "memory.evidence_coverage_settled")
        .map((fact) => fact.status),
    ).toEqual([]);
    expect(
      model.requests[0]?.some((message) =>
        message.content.includes('"schemaVersion":"paw.memory-tool-guide.v2"'),
      ),
    ).toBeTrue();
    expect(
      result.inputFacts
        .filter((fact) => fact.type.startsWith("memory.topic_"))
        .map((fact) => fact.type),
    ).toEqual([
      "memory.topic_evidence_settled",
      "memory.topic_organization_claimed",
      "memory.topic_candidate_staged",
      "memory.topic_organization_settled",
    ]);
    expect(writerEvents).toHaveLength(6); // claim, stage, L0 archive, relation, apply, settle
    expect(JSON.stringify(writerEvents)).not.toContain("中文");
  });

  test("runs the frozen V3 MCP proxy against a real stdio server and closes it", async () => {
    const root = workspace();
    const lifecycleLog = path.join(root, "mcp-lifecycle.jsonl");
    const identity = taskIdentity(root, "v3-mcp-proxy");
    const model = new ScriptedModel([
      toolResponse("mcp-search", "workspace_use_mcp", {
        action: "search",
        query: "echo",
      }),
      toolResponse("mcp-call", "workspace_use_mcp", {
        action: "call",
        tool: "mcp:fixture/echo",
        arguments: { message: "cache-stable" },
      }),
      finalResponse("MCP echo completed."),
    ]);
    const seed = {
      ...profileV3({}, false, true),
      mcp: {
        policyVersion: "paw.mcp-runtime.v1" as const,
        servers: [
          {
            name: "fixture",
            command: process.execPath,
            args: [
              path.join(import.meta.dir, "fixtures", "mcp-echo-server.ts"),
            ],
            env: { PAW_MCP_FIXTURE_LOG: lifecycleLog },
          },
        ],
        allowedTools: ["mcp:fixture/echo"],
      },
    };
    const first = buildPawNextTaskProfileV3({
      identity,
      profile: seed,
      apiKey: API_KEY,
    });
    model.copyIdentity(first.taskOptions.model);
    const built = buildPawNextTaskProfileV3({
      identity,
      profile: { ...seed, configHash: first.configHash },
      apiKey: API_KEY,
    });
    const resolution = Object.freeze({
      ...built,
      taskOptions: Object.freeze({ ...built.taskOptions, model }),
    });

    const result = await runFreshPawNextTaskV3({ resolution });
    const observations = model.requests
      .flat()
      .flatMap((message) => message.nativeToolTurn?.results ?? []);
    const search = observations.find((item) => item.callId === "mcp-search");
    const call = observations.find((item) => item.callId === "mcp-call");
    const callSettlement = JSON.parse(call?.content ?? "null") as {
      payload?: {
        content?: string;
        provenance?: { instructionAuthority?: string };
      };
    };
    const echoed = JSON.parse(callSettlement.payload?.content ?? "null") as {
      echoed?: string;
    };

    expect(result.assistantText).toBe("MCP echo completed.");
    expect(search?.content).toContain("mcp:fixture/echo");
    expect(search?.content).not.toContain("mcp:fixture/hidden");
    expect(search?.content).toContain('"trust":"external_untrusted_data"');
    expect(echoed.echoed).toBe("cache-stable");
    expect(callSettlement.payload?.provenance?.instructionAuthority).toBe(
      "none",
    );
    expect(
      result.inputFacts.filter(
        (fact) =>
          fact.type === "tool.permission_resolved" &&
          fact.tool === "workspace_use_mcp",
      ),
    ).toHaveLength(2);
    const lifecycle = fs.readFileSync(lifecycleLog, "utf8");
    expect(lifecycle).toContain('"event":"start"');
    expect(lifecycle).toContain('"event":"call","tool":"echo"');
    expect(lifecycle).toContain('"event":"exit"');
  }, 20_000);

  test("rejects unavailable exact MCP targets before the first durable attempt fact", async () => {
    const root = workspace();
    const lifecycleLog = path.join(root, "mcp-missing-lifecycle.jsonl");
    const identity = taskIdentity(root, "v3-mcp-missing-target");
    const model = new ScriptedModel([]);
    const seed = {
      ...profileV3({}, false, true),
      mcp: {
        policyVersion: "paw.mcp-runtime.v1" as const,
        servers: [
          {
            name: "fixture",
            command: process.execPath,
            args: [
              path.join(import.meta.dir, "fixtures", "mcp-echo-server.ts"),
            ],
            env: { PAW_MCP_FIXTURE_LOG: lifecycleLog },
          },
        ],
        allowedTools: ["mcp:fixture/not_present"],
      },
    };
    const first = buildPawNextTaskProfileV3({
      identity,
      profile: seed,
      apiKey: API_KEY,
    });
    model.copyIdentity(first.taskOptions.model);
    const built = buildPawNextTaskProfileV3({
      identity,
      profile: { ...seed, configHash: first.configHash },
      apiKey: API_KEY,
    });
    const resolution = Object.freeze({
      ...built,
      taskOptions: Object.freeze({ ...built.taskOptions, model }),
    });

    await expect(runFreshPawNextTaskV3({ resolution })).rejects.toThrow(
      /targets are unavailable.*mcp:fixture\/not_present/i,
    );
    expect(readFileSessionJournalCommitIndexV1(identity).head.tailSeq).toBe(0);
    const lifecycle = fs.readFileSync(lifecycleLog, "utf8");
    expect(lifecycle).toContain('"event":"start"');
    expect(lifecycle).not.toContain('"event":"call"');
    expect(lifecycle).toContain('"event":"exit"');
  }, 20_000);

  test("recalls a large durable tool output through the external V3 plugin", async () => {
    const root = workspace();
    const tailMarker = "TAIL_OUTPUT_RECALL_SENTINEL";
    fs.writeFileSync(
      path.join(root, "large-output.txt"),
      `${"A".repeat(15_000)}${tailMarker}`,
    );
    const identity = taskIdentity(root, "v3-output-recall");
    const model = new DynamicRecallModel("large-output.txt", tailMarker);
    const resolution = resolutionV3WithModel(identity, model);

    const result = await runFreshPawNextTaskV3({ resolution });

    expect(result.assistantText).toBe("durable recall complete");
    expect(result.state).toMatchObject({
      totalModelTurns: 3,
      totalSettledToolCalls: 2,
      decision: { kind: "completed" },
    });
    expect(model.stubContent).toContain("paw.output-recall-stub.v1");
    expect(model.stubContent).toContain("paw-payload:v1:");
    expect(model.stubContent).not.toContain("A".repeat(12_000));
    expect(model.recallContent).toContain(tailMarker);
    expect(model.recallContent).toContain("[recalled output id=");

    const producer = projectCanonicalDurableJsonPayloadBindingsV1(
      committedPrefix(identity),
    ).find(
      (item) =>
        item.location.kind === "tool_observation" &&
        item.location.callId === "large-read",
    );
    expect(producer?.payload.kind).toBe("artifact_ref");
  });

  test("persists and rereads structured long-task progress through the external V3 plugin", async () => {
    const root = workspace();
    const identity = taskIdentity(root, "v3-task-progress");
    const model = new DynamicTaskProgressModel();
    const resolution = resolutionV3WithModel(identity, model);

    const result = await runFreshPawNextTaskV3({ resolution });

    expect(result.assistantText).toBe("durable progress complete");
    expect(result.state).toMatchObject({
      totalModelTurns: 3,
      totalSettledToolCalls: 2,
      decision: { kind: "completed" },
    });
    expect(model.writeContent).toContain(
      '"schemaVersion":"paw.task-progress.v1"',
    );
    expect(model.writeContent).toContain('"percent":50');
    expect(model.readContent).toContain('"revision":1');
    expect(model.readContent).toContain('"activities":[]');

    const progressSettlements = result.inputFacts.filter(
      (fact) =>
        fact.type === "tool.settled" &&
        (fact.callId === "progress-write" || fact.callId === "progress-read"),
    );
    expect(progressSettlements).toHaveLength(2);
  });

  test("continues the active segment before blocking on a later queued input", async () => {
    const root = workspace();
    const identity = taskIdentity(root, "v3-segment-pending-priority");
    const resolution = resolutionV3WithModel(
      identity,
      new ScriptedModel([finalResponse("segment zero final")]),
    );
    await runFreshPawNextTaskV3({ resolution });
    await startV3FixtureSegment(resolution, "segment-q1", "segment-q2");
    const before = committedPrefix(identity);
    const classification = await classifyPawNextExistingPrefixV3({
      prefix: before,
      resolution,
    });
    expect(classification).toMatchObject({
      status: "actionable_continue",
      state: {
        reducerVersion: "paw.interactive-control.v2",
        segmentIndex: 1,
        segmentModelTurns: 0,
        totalModelTurns: 1,
        decision: { kind: "continue" },
      },
    });

    const probe = new ScriptedModel([finalResponse("segment one final")]);
    const result = await runExistingPawNextTaskV3({
      resolution: resolutionV3WithReplacementModel(resolution, probe),
    });
    expect(result.assistantText).toBe("segment one final");
    expect(probe.requests).toHaveLength(1);
    expect(
      result.inputFacts.filter(
        (fact) =>
          fact.type === "input.promoted" && fact.inputId === "segment-q1",
      ),
    ).toHaveLength(1);
    expect(
      result.inputFacts.filter(
        (fact) =>
          fact.type === "input.promoted" && fact.inputId === "segment-q2",
      ),
    ).toHaveLength(0);
    expect(
      result.inputFacts.filter(
        (fact) =>
          fact.type === "input.accepted" && fact.inputId === "segment-q2",
      ),
    ).toHaveLength(1);

    const terminalWithPending = await classifyPawNextExistingPrefixV3({
      prefix: committedPrefix(identity),
      resolution: resolutionV3WithReplacementModel(
        resolution,
        new ScriptedModel([]),
      ),
    });
    expect(terminalWithPending).toMatchObject({
      status: "blocked_pending",
      inputIds: ["segment-q2"],
      state: {
        segmentIndex: 1,
        decision: { kind: "completed" },
      },
    });
  });

  test("runs the real V3 CLI known-run seam idempotently and rejects content drift or FIFO bypass", async () => {
    const root = workspace();
    const identity = taskIdentity(root, "v3-cli-known-run");
    const resolution = resolutionV3WithModel(
      identity,
      new ScriptedModel([finalResponse("segment zero final")]),
    );
    await runFreshPawNextTaskV3({ resolution });
    const work = {
      inputId: "cli-known-q1",
      callerId: "cli-known-caller",
      content: "exact CLI work body",
    };
    await runExistingPawNextWorkSegmentV3({
      resolution: resolutionV3WithReplacementModel(
        resolution,
        new ScriptedModel([finalResponse("CLI q1 final")]),
      ),
      work,
    });
    writeProductProfileStores(root, [], [], [resolution.profile]);
    const beforeRetry = committedPrefix(identity);

    const retry = await runPawNextNewWorkCliV3(
      newWorkCliArgs(identity, work.inputId, work.callerId),
      { stdin: cliStdin(work.content) },
    );

    expect(retry.exitCode).toBe(0);
    expect(JSON.parse(retry.text)).toMatchObject({
      outcome: "completed",
      inputAcceptance: "already_accepted",
      segmentStart: "already_started",
      controlStatus: "completed",
    });
    expect(committedPrefix(identity)).toEqual(beforeRetry);

    const drift = await runPawNextNewWorkCliV3(
      newWorkCliArgs(identity, work.inputId, work.callerId),
      { stdin: cliStdin("drifted CLI work body") },
    );
    expect(drift.exitCode).toBe(1);
    expect(JSON.parse(drift.text).reasonCode).toBe("runtime_failed");
    expect(committedPrefix(identity)).toEqual(beforeRetry);

    await appendRawV3Facts(resolution, [accepted("cli-known-q2")]);
    const beforeFifo = committedPrefix(identity);
    const fifo = await runPawNextNewWorkCliV3(
      newWorkCliArgs(identity, "cli-known-q3", work.callerId),
      { stdin: cliStdin("must not bypass q2") },
    );
    expect(fifo.exitCode).toBe(1);
    expect(JSON.parse(fifo.text).reasonCode).toBe("runtime_failed");
    expect(committedPrefix(identity)).toEqual(beforeFifo);
    expect(
      inputFacts(beforeFifo).filter(
        (fact) =>
          fact.type === "input.accepted" && fact.inputId === "cli-known-q3",
      ),
    ).toHaveLength(0);
  });

  test("resumes an accepted-tail crash through the CLI without duplicating admission", async () => {
    const root = workspace();
    const identity = taskIdentity(root, "v3-cli-accepted-tail");
    const resolution = resolutionV3WithModel(
      identity,
      new ScriptedModel([finalResponse("segment zero final")]),
    );
    await runFreshPawNextTaskV3({ resolution });
    const acceptedTail = accepted("cli-accepted-tail-q1");
    await appendRawV3Facts(resolution, [acceptedTail]);
    writeProductProfileStores(root, [], [], [resolution.profile]);
    const probe = new ScriptedModel([finalResponse("accepted tail final")]);
    let productCalls = 0;

    const result = await runPawNextNewWorkCliV3(
      newWorkCliArgs(identity, acceptedTail.inputId, acceptedTail.callerId),
      {
        stdin: cliStdin(acceptedTail.content),
        invokeProduct: async (input) => {
          productCalls += 1;
          return runExistingPawNextWorkSegmentV3({
            ...input,
            resolution: resolutionV3WithReplacementModel(resolution, probe),
          });
        },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(productCalls).toBe(1);
    expect(probe.requests).toHaveLength(1);
    expect(JSON.parse(result.text)).toMatchObject({
      outcome: "completed",
      inputAcceptance: "already_accepted",
      segmentStart: "started",
    });
    const facts = inputFacts(committedPrefix(identity));
    expect(
      facts.filter(
        (fact) =>
          fact.type === "input.accepted" &&
          fact.inputId === acceptedTail.inputId,
      ),
    ).toHaveLength(1);
    expect(
      facts.filter(
        (fact) =>
          fact.type === "work.segment_started" &&
          fact.inputId === acceptedTail.inputId,
      ),
    ).toHaveLength(1);
    expect(
      facts.filter(
        (fact) =>
          fact.type === "input.promoted" &&
          fact.inputId === acceptedTail.inputId,
      ),
    ).toHaveLength(1);
  });

  test("admits one exact attachment-backed work item and makes completed retries byte-idempotent", async () => {
    const root = workspace();
    const identity = taskIdentity(root, "v3-explicit-attachment");
    const resolution = resolutionV3WithModel(
      identity,
      new ScriptedModel([finalResponse("segment zero final")]),
    );
    await runFreshPawNextTaskV3({ resolution });
    const attachmentValue = "explicit durable attachment";
    const work = {
      inputId: "explicit-q1",
      callerId: "explicit-caller",
      content: "handle the attached note",
      attachments: [
        {
          attachmentId: "explicit-attachment",
          type: "file" as const,
          name: "note.txt",
          mimeType: "text/plain",
          content: inlinePayload(attachmentValue),
        },
      ],
    };
    const model = new ScriptedModel([finalResponse("explicit q1 final")]);

    const first = await runExistingPawNextWorkSegmentV3({
      resolution: resolutionV3WithReplacementModel(resolution, model),
      work,
    });

    expect(first.inputAcceptance).toEqual({
      status: "accepted",
      inputId: "explicit-q1",
    });
    expect(first.segmentStart).toEqual({
      status: "started",
      inputId: "explicit-q1",
      segmentIndex: 1,
    });
    expect(first.state).toMatchObject({
      segmentIndex: 1,
      segmentModelTurns: 1,
      totalModelTurns: 2,
      decision: { kind: "completed" },
    });
    expect(model.requests).toHaveLength(1);
    const attachmentOccurrences = projectCanonicalDurableJsonPayloadBindingsV1(
      committedPrefix(identity),
    ).filter(
      (item) =>
        item.location.kind === "input_attachment" &&
        item.location.inputId === "explicit-q1",
    );
    expect(attachmentOccurrences).toHaveLength(2);
    expect(
      new Set(
        attachmentOccurrences.map((item) =>
          item.payload.kind === "artifact_ref"
            ? item.payload.artifactRef
            : "inline",
        ),
      ).size,
    ).toBe(1);
    expect(
      attachmentOccurrences.every(
        (item) =>
          item.payload.kind === "artifact_ref" &&
          item.binding.originSeq ===
            attachmentOccurrences[0]?.binding.originSeq,
      ),
    ).toBeTrue();

    const payloadRoot = path.join(
      root,
      ".paw",
      "paw-next",
      "durable-json-payloads",
    );
    const beforePrefix = committedPrefix(identity);
    const beforePayloads = rawTree(payloadRoot);
    const retryProbe = new ScriptedModel([]);
    const retry = await runExistingPawNextWorkSegmentV3({
      resolution: resolutionV3WithReplacementModel(resolution, retryProbe),
      work,
    });
    expect(retry.inputAcceptance.status).toBe("already_accepted");
    expect(retry.segmentStart.status).toBe("already_started");
    expect(retryProbe.requests).toHaveLength(0);
    expect(committedPrefix(identity)).toEqual(beforePrefix);
    expect(rawTree(payloadRoot)).toEqual(beforePayloads);

    const originalAttachment = work.attachments[0];
    if (!originalAttachment) throw new Error("missing attachment fixture");
    await expect(
      runExistingPawNextWorkSegmentV3({
        resolution: resolutionV3WithReplacementModel(
          resolution,
          new ScriptedModel([]),
        ),
        work: { ...work, content: "different content" },
      }),
    ).rejects.toThrow(/conflict|different|mismatch/i);
    await expect(
      runExistingPawNextWorkSegmentV3({
        resolution: resolutionV3WithReplacementModel(
          resolution,
          new ScriptedModel([]),
        ),
        work: {
          ...work,
          attachments: [
            {
              ...originalAttachment,
              content: inlinePayload("different attachment"),
            },
          ],
        },
      }),
    ).rejects.toThrow(/conflict|different|mismatch/i);
    expect(committedPrefix(identity)).toEqual(beforePrefix);
    expect(rawTree(payloadRoot)).toEqual(beforePayloads);
  });

  test("rejects FIFO and stale-segment requests before admitting another input", async () => {
    const fifoRoot = workspace();
    const fifoIdentity = taskIdentity(fifoRoot, "v3-explicit-fifo");
    const fifoResolution = resolutionV3WithModel(
      fifoIdentity,
      new ScriptedModel([finalResponse("segment zero final")]),
    );
    await runFreshPawNextTaskV3({ resolution: fifoResolution });
    await appendRawV3Facts(fifoResolution, [accepted("fifo-q0")]);
    const fifoBefore = committedPrefix(fifoIdentity);
    await expect(
      runExistingPawNextWorkSegmentV3({
        resolution: resolutionV3WithReplacementModel(
          fifoResolution,
          new ScriptedModel([]),
        ),
        work: {
          inputId: "fifo-q1",
          callerId: "test-caller",
          content: "content:fifo-q1",
        },
      }),
    ).rejects.toThrow(/fifo|pending|input/i);
    expect(committedPrefix(fifoIdentity)).toEqual(fifoBefore);
    expect(
      inputFacts(committedPrefix(fifoIdentity)).some(
        (fact) => fact.type === "input.accepted" && fact.inputId === "fifo-q1",
      ),
    ).toBeFalse();

    const staleRoot = workspace();
    const staleIdentity = taskIdentity(staleRoot, "v3-explicit-stale");
    const staleResolution = resolutionV3WithModel(
      staleIdentity,
      new ScriptedModel([finalResponse("segment zero final")]),
    );
    await runFreshPawNextTaskV3({ resolution: staleResolution });
    await runExistingPawNextWorkSegmentV3({
      resolution: resolutionV3WithReplacementModel(
        staleResolution,
        new ScriptedModel([finalResponse("old q1 final")]),
      ),
      work: {
        inputId: "old-q1",
        callerId: "old-caller",
        content: "old q1 content",
      },
    });
    await startV3FixtureSegment(staleResolution, "active-q2", "later-q3");
    const staleBefore = committedPrefix(staleIdentity);
    const staleProbe = new ScriptedModel([]);
    await expect(
      runExistingPawNextWorkSegmentV3({
        resolution: resolutionV3WithReplacementModel(
          staleResolution,
          staleProbe,
        ),
        work: {
          inputId: "old-q1",
          callerId: "old-caller",
          content: "old q1 content",
        },
      }),
    ).rejects.toThrow(/active|segment|input/i);
    expect(staleProbe.requests).toHaveLength(0);
    expect(committedPrefix(staleIdentity)).toEqual(staleBefore);
  });

  test("resumes accepted-tail and marker-tail crash windows without duplicating work", async () => {
    const acceptedRoot = workspace();
    const acceptedIdentity = taskIdentity(acceptedRoot, "v3-accepted-tail");
    const acceptedResolution = resolutionV3WithModel(
      acceptedIdentity,
      new ScriptedModel([finalResponse("segment zero final")]),
    );
    await runFreshPawNextTaskV3({ resolution: acceptedResolution });
    await appendRawV3Facts(acceptedResolution, [accepted("accepted-tail-q1")]);
    const acceptedModel = new ScriptedModel([
      finalResponse("accepted tail final"),
    ]);
    const fromAccepted = await runExistingPawNextWorkSegmentV3({
      resolution: resolutionV3WithReplacementModel(
        acceptedResolution,
        acceptedModel,
      ),
      work: {
        inputId: "accepted-tail-q1",
        callerId: "test-caller",
        content: "content:accepted-tail-q1",
      },
    });
    expect(fromAccepted.inputAcceptance.status).toBe("already_accepted");
    expect(fromAccepted.segmentStart.status).toBe("started");
    expect(acceptedModel.requests).toHaveLength(1);
    expect(
      fromAccepted.inputFacts.filter(
        (fact) =>
          fact.type === "work.segment_started" &&
          fact.inputId === "accepted-tail-q1",
      ),
    ).toHaveLength(1);

    const markerRoot = workspace();
    const markerIdentity = taskIdentity(markerRoot, "v3-marker-tail");
    const markerResolution = resolutionV3WithModel(
      markerIdentity,
      new ScriptedModel([finalResponse("segment zero final")]),
    );
    await runFreshPawNextTaskV3({ resolution: markerResolution });
    await startV3FixtureSegment(
      markerResolution,
      "marker-tail-q1",
      "marker-later",
    );
    const markerModel = new ScriptedModel([finalResponse("marker tail final")]);
    const fromMarker = await runExistingPawNextWorkSegmentV3({
      resolution: resolutionV3WithReplacementModel(
        markerResolution,
        markerModel,
      ),
      work: {
        inputId: "marker-tail-q1",
        callerId: "test-caller",
        content: "content:marker-tail-q1",
      },
    });
    expect(fromMarker.inputAcceptance.status).toBe("already_accepted");
    expect(fromMarker.segmentStart.status).toBe("already_started");
    expect(markerModel.requests).toHaveLength(1);
    expect(
      fromMarker.inputFacts.filter(
        (fact) =>
          fact.type === "input.promoted" && fact.inputId === "marker-later",
      ),
    ).toHaveLength(0);
  });

  test("starts directly from a decision tail when the accepted input predates that decision", async () => {
    const root = workspace();
    const identity = taskIdentity(root, "v3-decision-tail");
    const resolution = resolutionV3WithModel(identity, new ScriptedModel([]));
    await seedV3Run(resolution, [
      accepted("decision-tail-q1"),
      modelDispatch(1),
      completedPlainModelSettlement(
        1,
        "openai-compatible",
        "segment zero decision tail",
      ),
    ]);
    await commitV3TerminalDecision(resolution);
    const before = committedPrefix(identity);
    expect(before.at(-1)?.record.kind).toBe("derived_decision");
    const model = new ScriptedModel([finalResponse("decision tail q1 final")]);

    const result = await runExistingPawNextWorkSegmentV3({
      resolution: resolutionV3WithReplacementModel(resolution, model),
      work: {
        inputId: "decision-tail-q1",
        callerId: "test-caller",
        content: "content:decision-tail-q1",
      },
    });

    expect(result.inputAcceptance.status).toBe("already_accepted");
    expect(result.segmentStart.status).toBe("started");
    const after = committedPrefix(identity);
    expect(after[before.length]?.record).toMatchObject({
      kind: "input_fact",
      fact: { type: "work.segment_started", inputId: "decision-tail-q1" },
    });
    expect(after[before.length + 1]?.record).toMatchObject({
      kind: "input_fact",
      fact: { type: "input.promoted", inputId: "decision-tail-q1" },
    });
    expect(model.requests).toHaveLength(1);
  });

  test("pre-abort admits no work and preserves the terminal journal", async () => {
    const root = workspace();
    const identity = taskIdentity(root, "v3-explicit-preabort");
    const resolution = resolutionV3WithModel(
      identity,
      new ScriptedModel([finalResponse("segment zero final")]),
    );
    await runFreshPawNextTaskV3({ resolution });
    const before = committedPrefix(identity);
    const probe = new ScriptedModel([]);
    const controller = new AbortController();
    const reason = new Error("explicit work aborted");
    controller.abort(reason);

    await expect(
      runExistingPawNextWorkSegmentV3({
        resolution: resolutionV3WithReplacementModel(resolution, probe),
        work: {
          inputId: "aborted-q1",
          callerId: "test-caller",
          content: "content:aborted-q1",
        },
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    expect(probe.requests).toHaveLength(0);
    expect(committedPrefix(identity)).toEqual(before);
  });

  test("rejects an invalid work request before lease or file mutation", async () => {
    const root = workspace();
    const identity = taskIdentity(root, "v3-invalid-work");
    const resolution = resolutionV3WithModel(
      identity,
      new ScriptedModel([finalResponse("segment zero final")]),
    );
    await runFreshPawNextTaskV3({ resolution });
    const before = rawTree(root);
    const probe = new ScriptedModel([]);

    await expect(
      runExistingPawNextWorkSegmentV3({
        resolution: resolutionV3WithReplacementModel(resolution, probe),
        work: {
          inputId: "invalid-q1",
          callerId: "test-caller",
          content: "invalid attachments",
          attachments: [],
        },
      }),
    ).rejects.toThrow(/attachments|non-empty/i);
    expect(probe.requests).toHaveLength(0);
    expect(rawTree(root)).toEqual(before);
  });

  test("rejects exhausted or steer-blocked work before accepting its input", async () => {
    for (const budget of ["segments", "total-turns"] as const) {
      const root = workspace();
      const identity = taskIdentity(root, `v3-${budget}-preaccept`);
      const resolution = resolutionV3WithModel(
        identity,
        new ScriptedModel([finalResponse("segment zero final")]),
        budget === "segments"
          ? { maxSegments: 1 }
          : { maxModelTurns: 1, maxTotalModelTurns: 1 },
      );
      await runFreshPawNextTaskV3({ resolution });
      const before = committedPrefix(identity);
      const payloadRoot = path.join(
        root,
        ".paw",
        "paw-next",
        "durable-json-payloads",
      );
      const treeBefore = rawTree(payloadRoot);
      const probe = new ScriptedModel([]);

      await expect(
        runExistingPawNextWorkSegmentV3({
          resolution: resolutionV3WithReplacementModel(resolution, probe),
          work: {
            inputId: `blocked-${budget}`,
            callerId: "test-caller",
            content: `content:blocked-${budget}`,
          },
        }),
      ).rejects.toThrow(/budget|segment|turn|incomplete/i);
      expect(probe.requests).toHaveLength(0);
      expect(committedPrefix(identity)).toEqual(before);
      expect(rawTree(payloadRoot)).toEqual(treeBefore);
      expect(
        inputFacts(committedPrefix(identity)).some(
          (fact) =>
            (fact.type === "input.accepted" ||
              fact.type === "work.segment_started") &&
            fact.inputId === `blocked-${budget}`,
        ),
      ).toBeFalse();
    }

    const steerRoot = workspace();
    const steerIdentity = taskIdentity(steerRoot, "v3-steer-preaccept");
    const steerResolution = resolutionV3WithModel(
      steerIdentity,
      new ScriptedModel([finalResponse("segment zero final")]),
    );
    await runFreshPawNextTaskV3({ resolution: steerResolution });
    const steerContent = "pending steer content";
    await appendRawV3Facts(steerResolution, [
      {
        type: "input.accepted",
        inputId: "pending-steer",
        delivery: "steer",
        content: steerContent,
        contentHash: hashText(steerContent),
        callerId: "steer-caller",
      },
    ]);
    const steerBefore = committedPrefix(steerIdentity);
    const steerPayloadRoot = path.join(
      steerRoot,
      ".paw",
      "paw-next",
      "durable-json-payloads",
    );
    const steerTreeBefore = rawTree(steerPayloadRoot);
    await expect(
      runExistingPawNextWorkSegmentV3({
        resolution: resolutionV3WithReplacementModel(
          steerResolution,
          new ScriptedModel([]),
        ),
        work: {
          inputId: "queue-behind-steer",
          callerId: "test-caller",
          content: "content:queue-behind-steer",
        },
      }),
    ).rejects.toThrow(/steer|pending|input/i);
    expect(committedPrefix(steerIdentity)).toEqual(steerBefore);
    expect(rawTree(steerPayloadRoot)).toEqual(steerTreeBefore);
    expect(
      inputFacts(committedPrefix(steerIdentity)).some(
        (fact) =>
          (fact.type === "input.accepted" ||
            fact.type === "work.segment_started") &&
          fact.inputId === "queue-behind-steer",
      ),
    ).toBeFalse();
  });

  test("keeps model turns and mutating checkpoint allocation global across segments", async () => {
    const root = workspace();
    const identity = taskIdentity(root, "v3-global-effect-identity");
    const firstModel = new ScriptedModel([
      toolResponse("write-segment-zero", "workspace_write_file", {
        path: "segment-zero.txt",
        content: "zero",
      }),
      finalResponse("segment zero final"),
    ]);
    const resolution = resolutionV3WithModel(identity, firstModel, {}, true);
    await runFreshPawNextTaskV3({ resolution });
    const nextModel = new ScriptedModel([
      toolResponse("write-segment-one", "workspace_write_file", {
        path: "segment-one.txt",
        content: "one",
      }),
      finalResponse("segment one final"),
    ]);

    const result = await runExistingPawNextWorkSegmentV3({
      resolution: resolutionV3WithReplacementModel(resolution, nextModel),
      work: {
        inputId: "effect-q1",
        callerId: "effect-caller",
        content: "perform the second edit",
      },
    });

    expect(firstModel.requests).toHaveLength(2);
    expect(nextModel.requests).toHaveLength(2);
    expect(
      result.inputFacts
        .filter((fact) => fact.type === "model.dispatch_recorded")
        .map((fact) => fact.turn),
    ).toEqual([1, 2, 3, 4]);
    expect(
      result.inputFacts
        .filter((fact) => fact.type === "tool.effect_checkpoint_allocated")
        .map((fact) => fact.checkpointSeq),
    ).toEqual([1, 2]);
    expect(result.state).toMatchObject({
      segmentIndex: 1,
      segmentModelTurns: 2,
      totalModelTurns: 4,
      decision: { kind: "completed" },
    });
    expect(fs.readFileSync(path.join(root, "segment-zero.txt"), "utf8")).toBe(
      "zero",
    );
    expect(fs.readFileSync(path.join(root, "segment-one.txt"), "utf8")).toBe(
      "one",
    );
  });

  test("repairs an exact active request and rebuilds before returning its terminal state", async () => {
    const root = workspace();
    const identity = taskIdentity(root, "v3-explicit-repair-retry");
    const resolution = resolutionV3WithModel(
      identity,
      new ScriptedModel([finalResponse("segment zero final")]),
    );
    await runFreshPawNextTaskV3({ resolution });
    await startV3FixtureSegment(resolution, "repair-exact", "repair-later");
    await appendRawV3Facts(resolution, [modelDispatch(2)]);
    const beforeConflict = committedPrefix(identity);
    await expect(
      runExistingPawNextWorkSegmentV3({
        resolution: resolutionV3WithReplacementModel(
          resolution,
          new ScriptedModel([]),
        ),
        work: {
          inputId: "repair-different",
          callerId: "test-caller",
          content: "content:repair-different",
        },
      }),
    ).rejects.toThrow(/active|segment|input|repair/i);
    expect(committedPrefix(identity)).toEqual(beforeConflict);
    expect(
      inputFacts(committedPrefix(identity)).filter(
        (fact) =>
          fact.type === "model.settled" && fact.modelCallId === "model-2",
      ),
    ).toHaveLength(0);
    const probe = new ScriptedModel([]);

    const result = await runExistingPawNextWorkSegmentV3({
      resolution: resolutionV3WithReplacementModel(resolution, probe),
      work: {
        inputId: "repair-exact",
        callerId: "test-caller",
        content: "content:repair-exact",
      },
    });

    expect(result.inputAcceptance.status).toBe("already_accepted");
    expect(result.segmentStart.status).toBe("already_started");
    expect(result.state.decision).toEqual({
      kind: "incomplete",
      reason: "model-result-unknown",
    });
    expect(probe.requests).toHaveLength(0);
    expect(
      result.inputFacts.filter(
        (fact) =>
          fact.type === "model.settled" &&
          fact.modelCallId === "model-2" &&
          fact.status === "unknown",
      ),
    ).toHaveLength(1);
    expect(
      result.inputFacts.filter(
        (fact) =>
          fact.type === "input.promoted" && fact.inputId === "repair-later",
      ),
    ).toHaveLength(0);
  });

  test("repairs an active-segment frontier before reporting its queued input", async () => {
    const root = workspace();
    const identity = taskIdentity(root, "v3-segment-repair-priority");
    const resolution = resolutionV3WithModel(
      identity,
      new ScriptedModel([finalResponse("segment zero final")]),
    );
    await runFreshPawNextTaskV3({ resolution });
    await startV3FixtureSegment(resolution, "repair-q1", "repair-q2");
    await appendRawV3Facts(resolution, [modelDispatch(2)]);
    const before = committedPrefix(identity);
    const classification = await classifyPawNextExistingPrefixV3({
      prefix: before,
      resolution,
    });
    expect(classification.status).toBe("actionable_repair");
    const probe = new ScriptedModel([]);

    await expect(
      runExistingPawNextTaskV3({
        resolution: resolutionV3WithReplacementModel(resolution, probe),
      }),
    ).rejects.toThrow(/pending accepted input/i);

    const repaired = inputFacts(committedPrefix(identity));
    expect(probe.requests).toHaveLength(0);
    expect(
      repaired.filter(
        (fact) =>
          fact.type === "model.settled" &&
          fact.modelCallId === "model-2" &&
          fact.status === "unknown",
      ),
    ).toHaveLength(1);
    expect(
      repaired.filter(
        (fact) =>
          fact.type === "input.promoted" && fact.inputId === "repair-q2",
      ),
    ).toHaveLength(0);
  });

  test("repairs open model and tool frontiers before pending input without starting a segment", async () => {
    for (const frontier of ["model", "tool"] as const) {
      const root = workspace();
      fs.writeFileSync(path.join(root, "v3-open.txt"), "open\n");
      const identity = taskIdentity(root, `v3-open-${frontier}`);
      const resolution = resolutionV3WithModel(identity, new ScriptedModel([]));
      const facts =
        frontier === "model"
          ? [modelDispatch(1), accepted(`pending-${frontier}`)]
          : [
              modelDispatch(1),
              completedToolModelSettlement(1, [
                toolCall("v3-open-read", "v3-open.txt", 0),
              ]),
              observedTool(1, "v3-open-read", "v3-open.txt", 0),
              toolDispatch(1, "v3-open-read", 0),
              toolPermission(1, "v3-open-read", 0),
              accepted(`pending-${frontier}`),
            ];
      await seedV3Run(resolution, facts);
      const beforeMarkers = inputFacts(committedPrefix(identity)).filter(
        (fact) => fact.type === "work.segment_started",
      );
      const probe = new ScriptedModel([]);

      await expect(
        runExistingPawNextTaskV3({
          resolution: resolutionV3WithReplacementModel(resolution, probe),
        }),
      ).rejects.toThrow(/pending accepted input/i);

      const repaired = inputFacts(committedPrefix(identity));
      expect(probe.requests).toHaveLength(0);
      expect(beforeMarkers).toHaveLength(0);
      expect(
        repaired.filter((fact) => fact.type === "work.segment_started"),
      ).toHaveLength(0);
      expect(
        repaired.filter((fact) =>
          frontier === "model"
            ? fact.type === "model.settled" &&
              fact.modelCallId === "model-1" &&
              fact.status === "unknown"
            : fact.type === "tool.settled" &&
              fact.callId === "v3-open-read" &&
              fact.status === "unknown",
        ),
      ).toHaveLength(1);
    }
  });

  test("continues a settled artifact tool frontier at the next global turn", async () => {
    const root = workspace();
    fs.writeFileSync(path.join(root, "v3-cursor.txt"), "cursor\n");
    const identity = taskIdentity(root, "v3-cursor");
    const resolution = resolutionV3WithModel(identity, new ScriptedModel([]));
    await seedV3Run(resolution, [
      modelDispatch(1),
      completedToolModelSettlement(1, [
        toolCall("v3-cursor-read", "v3-cursor.txt", 0),
      ]),
      observedTool(1, "v3-cursor-read", "v3-cursor.txt", 0),
      toolDispatch(1, "v3-cursor-read", 0),
      toolPermission(1, "v3-cursor-read", 0),
      {
        type: "tool.settled",
        callId: "v3-cursor-read",
        status: "completed",
        observation: {
          schemaVersion: "paw.tool-observation.v1",
          summary: "v3 cursor result",
          isError: false,
          payload: inlinePayload({ content: "cursor\n" }),
        },
      },
    ]);
    const probe = new ScriptedModel([finalResponse("continued v3")]);

    const result = await runExistingPawNextTaskV3({
      resolution: resolutionV3WithReplacementModel(resolution, probe),
    });

    expect(result.assistantText).toBe("continued v3");
    expect(probe.requests).toHaveLength(1);
    expect(
      result.inputFacts
        .filter((fact) => fact.type === "model.dispatch_recorded")
        .map((fact) => fact.turn),
    ).toEqual([1, 2]);
    expect(result.state).toMatchObject({
      reducerVersion: "paw.interactive-control.v2",
      segmentIndex: 0,
      segmentModelTurns: 2,
      totalModelTurns: 2,
      decision: { kind: "completed" },
    });
  });

  test("rejects artifact, provider, and budget drift before repair or model activity", async () => {
    const root = workspace();
    const identity = taskIdentity(root, "v3-drift");
    const resolution = resolutionV3WithModel(
      identity,
      new ScriptedModel([finalResponse("v3 historical")]),
    );
    await runFreshPawNextTaskV3({ resolution });
    const occurrence = projectCanonicalDurableJsonPayloadBindingsV1(
      committedPrefix(identity),
    ).find((item) => item.location.kind === "model_response");
    if (!occurrence || occurrence.payload.kind !== "artifact_ref") {
      throw new Error("missing V3 model artifact fixture");
    }
    const before = committedPrefix(identity);
    const probe = new ScriptedModel([]);

    for (const change of ["provider", "budget"] as const) {
      const drifted = {
        ...resolution,
        taskOptions: {
          ...resolution.taskOptions,
          ...(change === "provider"
            ? { providerProtocol: "anthropic-compatible" as const }
            : {
                payloadRuntime: {
                  ...resolution.taskOptions.payloadRuntime,
                  readBudget: {
                    ...resolution.taskOptions.payloadRuntime.readBudget,
                    maxTotalBytes:
                      resolution.taskOptions.payloadRuntime.readBudget
                        .maxTotalBytes - 1,
                  },
                },
              }),
          model: probe,
        },
      } as BuiltPawNextTaskProfileV3;
      await expect(
        runExistingPawNextTaskV3({ resolution: drifted }),
      ).rejects.toThrow();
      expect(probe.requests).toHaveLength(0);
      expect(committedPrefix(identity)).toEqual(before);
    }

    fs.appendFileSync(
      payloadArtifactFile(root, occurrence.payload.artifactRef),
      " ",
    );
    await expect(
      runExistingPawNextTaskV3({
        resolution: resolutionV3WithReplacementModel(resolution, probe),
      }),
    ).rejects.toThrow();
    expect(probe.requests).toHaveLength(0);
    expect(committedPrefix(identity)).toEqual(before);
  });

  test("allows implicit segment zero at maxSegments one but enforces the global turn budget", async () => {
    const completeRoot = workspace();
    const completeIdentity = taskIdentity(completeRoot, "v3-one-segment");
    const completeModel = new ScriptedModel([finalResponse("one segment")]);
    const complete = await runFreshPawNextTaskV3({
      resolution: resolutionV3WithModel(completeIdentity, completeModel, {
        maxSegments: 1,
      }),
    });
    expect(complete.state).toMatchObject({
      segmentIndex: 0,
      totalModelTurns: 1,
      decision: { kind: "completed" },
    });

    const budgetRoot = workspace();
    fs.writeFileSync(path.join(budgetRoot, "v3-budget.txt"), "budget\n");
    const budgetIdentity = taskIdentity(budgetRoot, "v3-total-budget");
    const budgetModel = new ScriptedModel([
      toolResponse("budget-read", "workspace_read_file", {
        path: "v3-budget.txt",
      }),
      finalResponse("must not run"),
    ]);
    const budgeted = await runFreshPawNextTaskV3({
      resolution: resolutionV3WithModel(budgetIdentity, budgetModel, {
        maxModelTurns: 1,
        maxSegments: 1,
        maxTotalModelTurns: 1,
      }),
    });
    expect(budgetModel.requests).toHaveLength(1);
    expect(budgeted.state).toMatchObject({
      segmentIndex: 0,
      segmentModelTurns: 1,
      totalModelTurns: 1,
      decision: {
        kind: "incomplete",
        reason: "model-turn-budget-exhausted",
      },
    });
  });
});

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-composition-v2-"));
  fs.mkdirSync(path.join(root, ".paw"), { recursive: true });
  roots.push(root);
  return root;
}

function initializeGitWorkspace(root: string): void {
  fs.writeFileSync(path.join(root, ".gitignore"), "**/.paw/*\n", "utf8");
  const commands = [
    ["init"],
    ["config", "user.email", "paw@example.invalid"],
    ["config", "user.name", "Paw Test"],
    ["config", "core.autocrlf", "false"],
    ["add", "."],
    ["commit", "-m", "fixture"],
  ] as const;
  for (const args of commands) {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(result.stderr || `git ${args.join(" ")} failed`);
    }
  }
}

function taskIdentity(root: string, suffix: string) {
  return {
    workspaceRoot: root,
    sessionId: `session-${suffix}`,
    runId: `run-${suffix}`,
    inputId: `input-${suffix}`,
    goal: "Read evidence.txt and report the result.",
  };
}

function resolutionWithModel(
  identity: ReturnType<typeof taskIdentity>,
  model: ScriptedModel,
): BuiltPawNextTaskProfileV2 {
  const seed = profileV2();
  const first = buildPawNextTaskProfileV2({
    identity,
    profile: seed,
    apiKey: API_KEY,
  });
  model.copyIdentity(first.taskOptions.model);
  const profile = { ...seed, configHash: first.configHash };
  const built = buildPawNextTaskProfileV2({
    identity,
    profile,
    apiKey: API_KEY,
  });
  return Object.freeze({
    ...built,
    taskOptions: Object.freeze({ ...built.taskOptions, model }),
  });
}

function resolutionWithReplacementModel(
  resolution: BuiltPawNextTaskProfileV2,
  model: ScriptedModel,
): BuiltPawNextTaskProfileV2 {
  model.copyIdentity(resolution.taskOptions.model);
  return Object.freeze({
    ...resolution,
    taskOptions: Object.freeze({ ...resolution.taskOptions, model }),
  });
}

function resolutionV3WithModel(
  identity: ReturnType<typeof taskIdentity>,
  model: ScriptedModel,
  controlOverrides: Partial<ReturnType<typeof profileV3>["control"]> = {},
  allowWrite = false,
  allowShell = false,
): BuiltPawNextTaskProfileV3 {
  const seed = profileV3(controlOverrides, allowWrite, allowShell);
  const first = buildPawNextTaskProfileV3({
    identity,
    profile: seed,
    apiKey: API_KEY,
  });
  model.copyIdentity(first.taskOptions.model);
  const built = buildPawNextTaskProfileV3({
    identity,
    profile: { ...seed, configHash: first.configHash },
    apiKey: API_KEY,
  });
  return Object.freeze({
    ...built,
    taskOptions: Object.freeze({ ...built.taskOptions, model }),
  });
}

function resolutionV3WithReplacementModel(
  resolution: BuiltPawNextTaskProfileV3,
  model: ScriptedModel,
): BuiltPawNextTaskProfileV3 {
  model.copyIdentity(resolution.taskOptions.model);
  return Object.freeze({
    ...resolution,
    taskOptions: Object.freeze({ ...resolution.taskOptions, model }),
  });
}

function profileV2() {
  return {
    profileId: "composition-v2",
    revision: 1,
    configHash: "0".repeat(64),
    model: {
      protocol: "openai-compatible" as const,
      transport: "complete" as const,
      model: "composition-v2-model",
      baseUrl: "https://example.invalid/v1",
      capabilities: { contextWindow: 32_000, maxOutputTokens: 2_048 },
      thinkingEnabled: false,
      reasoningEffort: null,
      credentialSlot: "composition-v2-key",
    },
    control: {
      mode: "interactive" as const,
      maxModelTurns: 8,
      naturalStop: "complete" as const,
    },
    systemPrompt: "V2 artifact composition test",
    budget: {
      contextWindowTokens: 32_000,
      reservedOutputTokens: 2_048,
      estimationMarginTokens: 256,
      estimator: {
        id: "core:openai:composition-v2-model",
        version: "v1",
      },
    },
    permission: {
      policyVersion: "composition-v2-permission.v1",
      defaultAction: "deny" as const,
      rules: [
        {
          id: "allow-read",
          layer: "default" as const,
          category: "read" as const,
          action: "allow" as const,
        },
      ],
    },
    approval: "unavailable" as const,
    heartbeat: {
      policyVersion: "paw.session-lease-heartbeat.v1" as const,
      ttlMs: 90_000,
      intervalMs: 30_000,
    },
    shellSandbox: null,
    payloadRuntime: {
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
    },
  };
}

function profileV3(
  controlOverrides: Partial<{
    mode: "interactive";
    maxModelTurns: number;
    naturalStop: "complete" | "await_user";
    maxSegments: number;
    maxTotalModelTurns: number;
  }> = {},
  allowWrite = false,
  allowShell = false,
) {
  return {
    ...profileV2(),
    profileId: "composition-v3",
    model: {
      ...profileV2().model,
      model: "composition-v3-model",
    },
    control: {
      mode: "interactive" as const,
      maxModelTurns: 8,
      naturalStop: "complete" as const,
      maxSegments: 4,
      maxTotalModelTurns: 24,
      ...controlOverrides,
    },
    systemPrompt: "V3 multi-segment artifact composition test",
    budget: {
      ...profileV2().budget,
      estimator: {
        id: "core:openai:composition-v3-model",
        version: "v1",
      },
    },
    permission: {
      ...profileV2().permission,
      rules: [
        ...profileV2().permission.rules,
        ...(allowWrite
          ? [
              {
                id: "allow-write",
                layer: "default" as const,
                category: "write" as const,
                action: "allow" as const,
              },
            ]
          : []),
        ...(allowShell
          ? [
              {
                id: "allow-shell",
                layer: "default" as const,
                category: "shell" as const,
                action: "allow" as const,
              },
            ]
          : []),
      ],
    },
    workSegmentPolicyVersion: WORK_SEGMENT_POLICY_VERSION_V1,
  };
}

function writeProductProfileStores(
  root: string,
  v1Profiles: readonly unknown[],
  v2Profiles: readonly unknown[],
  v3Profiles: readonly unknown[] = [],
): void {
  writeJson(path.join(root, DEFAULT_PAW_NEXT_PRODUCT_PROFILE_FILE_V1), {
    schemaVersion: PAW_NEXT_PRODUCT_PROFILE_SCHEMA_VERSION_V1,
    profiles: v1Profiles,
  });
  writeJson(path.join(root, DEFAULT_PAW_NEXT_PRODUCT_PROFILE_FILE_V2), {
    schemaVersion: PAW_NEXT_PRODUCT_PROFILE_SCHEMA_VERSION_V2,
    profiles: v2Profiles,
  });
  writeJson(path.join(root, DEFAULT_PAW_NEXT_PRODUCT_PROFILE_FILE_V3), {
    schemaVersion: PAW_NEXT_PRODUCT_PROFILE_SCHEMA_VERSION_V3,
    profiles: v3Profiles,
  });
  writeJson(path.join(root, ".paw", "settings.local.json"), {
    models: { "composition-v2-key": { apiKey: API_KEY } },
  });
}

function writeJson(target: string, value: unknown): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(value));
}

class ScriptedModel implements LanguageModel {
  label = "uninitialized";
  capabilities: LanguageModel["capabilities"];
  runtimeProfile: LanguageModel["runtimeProfile"];
  readonly requests: ChatMessage[][] = [];
  readonly requestOptions: Array<
    Readonly<{
      maxOutputTokens?: number;
      thinkingEnabled?: boolean;
      toolNames?: readonly string[];
    }>
  > = [];
  private index = 0;

  constructor(
    private readonly responses: readonly (ModelCompletionResult | Error)[],
    identity?: LanguageModel,
  ) {
    if (identity) this.copyIdentity(identity);
  }

  copyIdentity(identity: LanguageModel): void {
    this.label = identity.label;
    this.capabilities = identity.capabilities;
    this.runtimeProfile = identity.runtimeProfile;
  }

  async complete(
    messages: readonly ChatMessage[],
    options?: ModelCompleteOptions,
  ): Promise<ModelCompletionResult> {
    this.requests.push(messages.map((message) => structuredClone(message)));
    this.requestOptions.push({
      ...(options?.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: options.maxOutputTokens }),
      ...(options?.thinkingEnabled === undefined
        ? {}
        : { thinkingEnabled: options.thinkingEnabled }),
      ...(options?.tools === undefined
        ? {}
        : {
            toolNames: Object.freeze(
              options.tools.map((tool) => tool.function.name),
            ),
          }),
    });
    const response = this.responses[this.index++];
    if (!response) throw new Error("No scripted response remains");
    if (response instanceof Error) throw response;
    return response;
  }
}

class DynamicRecallModel extends ScriptedModel {
  private phase = 0;
  stubContent = "";
  recallContent = "";

  constructor(
    private readonly file: string,
    private readonly tailMarker: string,
  ) {
    super([]);
  }

  override async complete(
    messages: readonly ChatMessage[],
    _options?: ModelCompleteOptions,
  ): Promise<ModelCompletionResult> {
    this.requests.push(messages.map((message) => structuredClone(message)));
    if (this.phase === 0) {
      this.phase += 1;
      return toolResponse("large-read", "workspace_read_file", {
        path: this.file,
      });
    }
    const latestResult = [...messages]
      .reverse()
      .flatMap((message) => message.nativeToolTurn?.results ?? [])
      .at(0)?.content;
    if (!latestResult) throw new Error("Expected a native tool result");
    if (this.phase === 1) {
      this.phase += 1;
      this.stubContent = latestResult;
      const id = latestResult.match(/paw-payload:v1:[0-9a-f]{64}/)?.[0];
      if (!id) throw new Error("Large output stub did not expose an id");
      return toolResponse("large-recall", "context_recall", {
        id,
        part: "tail",
        limit: 256,
      });
    }
    this.phase += 1;
    this.recallContent = latestResult;
    if (!latestResult.includes(this.tailMarker)) {
      throw new Error("Recalled output did not contain the expected tail");
    }
    return finalResponse("durable recall complete");
  }
}

class DynamicTaskProgressModel extends ScriptedModel {
  private phase = 0;
  writeContent = "";
  readContent = "";

  constructor() {
    super([]);
  }

  override async complete(
    messages: readonly ChatMessage[],
    _options?: ModelCompleteOptions,
  ): Promise<ModelCompletionResult> {
    this.requests.push(messages.map((message) => structuredClone(message)));
    if (this.phase === 0) {
      this.phase += 1;
      return toolResponse("progress-write", "workspace_todo_write", {
        todos: [
          { id: "inspect", content: "Inspect code", status: "done" },
          { id: "test", content: "Run tests", status: "in_progress" },
        ],
      });
    }
    const latestResult = [...messages]
      .reverse()
      .flatMap((message) => message.nativeToolTurn?.results ?? [])
      .at(0)?.content;
    if (!latestResult) throw new Error("Expected a progress tool result");
    if (this.phase === 1) {
      this.phase += 1;
      this.writeContent = latestResult;
      return toolResponse("progress-read", "workspace_progress_read", {});
    }
    this.phase += 1;
    this.readContent = latestResult;
    return finalResponse("durable progress complete");
  }
}

class DynamicCompactionModel extends ScriptedModel {
  agentCalls = 0;
  distillerCalls = 0;
  verifierCalls = 0;
  distillerSawResolvedText = false;

  constructor() {
    super([]);
  }

  override async complete(
    messages: readonly ChatMessage[],
    _options?: ModelCompleteOptions,
  ): Promise<ModelCompletionResult> {
    this.requests.push(messages.map((message) => structuredClone(message)));
    const system = messages[0]?.content ?? "";
    if (system.includes("task checkpoint distiller")) {
      this.distillerCalls += 1;
      const user = messages[1]?.content ?? "";
      this.distillerSawResolvedText = user.includes(
        "INTERMEDIATE_CONTEXT_SENTINEL",
      );
      const marker = "Journal evidence:\n";
      const evidence = JSON.parse(
        user.slice(user.indexOf(marker) + marker.length),
      ) as readonly { seq: number; factType: string }[];
      const modelEvidence = evidence.find(
        (item) => item.factType === "model.settled",
      );
      if (!modelEvidence) throw new Error("Expected model evidence to distill");
      return finalResponse(
        JSON.stringify({
          schemaVersion: "paw.task-checkpoint.v1",
          confirmedFacts: [],
          currentHypotheses: [
            {
              statement: "Earlier model turns produced intermediate output",
              sourceSeqs: [modelEvidence.seq],
            },
          ],
          ruledOut: [],
          changedFiles: [],
          verification: [],
          unresolved: [],
        }),
      );
    }
    if (system.includes("checkpoint evidence auditor")) {
      this.verifierCalls += 1;
      return finalResponse('{"status":"supported"}');
    }
    this.agentCalls += 1;
    if (this.agentCalls <= 7) {
      const content = `INTERMEDIATE_CONTEXT_SENTINEL_${this.agentCalls}_${"x".repeat(4_000)}`;
      return {
        ...toolResponse(
          `compact-read-${this.agentCalls}`,
          "workspace_read_file",
          { path: "compact-evidence.txt" },
        ),
        text: content,
        nativeAssistantContent: content,
      };
    }
    return finalResponse("compaction complete");
  }
}

class BlockingScriptedModel extends ScriptedModel {
  readonly started: Promise<void>;
  private resolveStarted!: () => void;
  private resolveResult!: (result: ModelCompletionResult) => void;
  private readonly result: Promise<ModelCompletionResult>;

  constructor() {
    super([]);
    this.started = new Promise((resolve) => {
      this.resolveStarted = resolve;
    });
    this.result = new Promise((resolve) => {
      this.resolveResult = resolve;
    });
  }

  override async complete(
    messages: readonly ChatMessage[],
    _options?: ModelCompleteOptions,
  ): Promise<ModelCompletionResult> {
    this.requests.push(messages.map((message) => structuredClone(message)));
    this.resolveStarted();
    return this.result;
  }

  finish(result: ModelCompletionResult): void {
    this.resolveResult(result);
  }
}

class ExpireWhenHeartbeatArmsScheduler implements SessionLeaseSchedulerV1 {
  private nowMs = 0;

  constructor(private readonly expiredAtMs: number) {}

  now(): number {
    return this.nowMs;
  }

  scheduleAt(
    _deadlineMs: number,
    _task: () => void,
  ): SessionLeaseScheduledTaskV1 {
    this.nowMs = this.expiredAtMs;
    return Object.freeze({ cancel() {} });
  }
}

function toolResponse(
  id: string,
  name: string,
  args: Record<string, unknown>,
): ModelCompletionResult {
  const call: NativeToolCall = {
    id,
    name,
    arguments: args,
    rawArguments: JSON.stringify(args),
    sourceIndex: 0,
    argumentsValid: true,
  };
  return {
    text: "",
    nativeAssistantContent: "",
    finishReason: "tool_calls",
    toolCalls: [call],
  };
}

function finalResponse(text: string): ModelCompletionResult {
  return { text, nativeAssistantContent: text, finishReason: "stop" };
}

function responseWithUsage(
  response: ModelCompletionResult,
  promptTokens: number,
): ModelCompletionResult {
  return {
    ...response,
    usage: {
      promptTokens,
      completionTokens: 10,
      totalTokens: promptTokens + 10,
    },
  };
}

function truncatedResponse(): ModelCompletionResult {
  return { text: "", nativeAssistantContent: "", finishReason: "length" };
}

async function appendV2Facts(
  resolution: BuiltPawNextTaskProfileV2,
  facts: readonly import("@paw/protocol").InputFactV1[],
): Promise<void> {
  const task = resolution.taskOptions;
  const head = readFileSessionJournalCommitIndexV1(task).head;
  const acquired = acquireFileSessionExecutionLeaseV1({
    workspaceRoot: task.workspaceRoot,
    sessionId: task.sessionId,
    runId: task.runId,
    ttlMs: task.heartbeatPolicy.ttlMs,
    baseTailSeq: head.tailSeq,
    basePrefixHash: head.prefixHash,
  });
  if (acquired.status !== "acquired") {
    throw new Error(`failed to acquire fixture lease: ${acquired.status}`);
  }
  const raw = new FileRunSessionV1({
    workspaceRoot: task.workspaceRoot,
    sessionId: task.sessionId,
    runId: task.runId,
    executionLease: acquired.lease,
  });
  try {
    await openFixtureSegmentBeforeModelDispatch(raw, facts);
    const writer = createFileDurableJsonPayloadWriterV1({
      workspaceRoot: task.workspaceRoot,
      sessionId: task.sessionId,
      runId: task.runId,
      policy: task.payloadRuntime.storePolicy,
      executionLease: acquired.lease,
    });
    const session = createLocationAwarePayloadSessionV1({
      source: raw,
      sessionId: task.sessionId,
      runId: task.runId,
      materializer: writer,
      budget: task.payloadRuntime.readBudget,
    });
    await session.appendInputFacts(facts);
  } finally {
    raw.close();
    expect(await acquired.lease.release()).toBe("released");
  }
}

async function seedV3Run(
  resolution: BuiltPawNextTaskProfileV3,
  facts: readonly import("@paw/protocol").InputFactV1[],
): Promise<void> {
  const task = resolution.taskOptions;
  const head = readFileSessionJournalCommitIndexV1(task).head;
  expect(head.tailSeq).toBe(0);
  const acquired = acquireFileSessionExecutionLeaseV1({
    workspaceRoot: task.workspaceRoot,
    sessionId: task.sessionId,
    runId: task.runId,
    ttlMs: task.heartbeatPolicy.ttlMs,
    baseTailSeq: head.tailSeq,
    basePrefixHash: head.prefixHash,
  });
  if (acquired.status !== "acquired") {
    throw new Error(`failed to acquire V3 fixture lease: ${acquired.status}`);
  }
  const raw = new FileRunSessionV1({
    workspaceRoot: task.workspaceRoot,
    sessionId: task.sessionId,
    runId: task.runId,
    executionLease: acquired.lease,
  });
  try {
    const writer = createFileDurableJsonPayloadWriterV1({
      workspaceRoot: task.workspaceRoot,
      sessionId: task.sessionId,
      runId: task.runId,
      policy: task.payloadRuntime.storePolicy,
      executionLease: acquired.lease,
    });
    const session = createLocationAwarePayloadSessionV1({
      source: raw,
      sessionId: task.sessionId,
      runId: task.runId,
      materializer: writer,
      budget: task.payloadRuntime.readBudget,
    });
    await session.appendInputFacts([
      {
        type: "attempt.started",
        goalHash: hashText(task.goal),
        configHash: resolution.configHash,
      },
      {
        type: "input.promoted",
        inputId: task.inputId,
        delivery: "initial",
        content: task.goal,
        contentHash: hashText(task.goal),
      },
      ...facts,
    ]);
  } finally {
    raw.close();
    expect(await acquired.lease.release()).toBe("released");
  }
}

async function startV3FixtureSegment(
  resolution: BuiltPawNextTaskProfileV3,
  inputId: string,
  pendingInputId: string,
): Promise<void> {
  const task = resolution.taskOptions;
  const head = readFileSessionJournalCommitIndexV1(task).head;
  const acquired = acquireFileSessionExecutionLeaseV1({
    workspaceRoot: task.workspaceRoot,
    sessionId: task.sessionId,
    runId: task.runId,
    ttlMs: task.heartbeatPolicy.ttlMs,
    baseTailSeq: head.tailSeq,
    basePrefixHash: head.prefixHash,
  });
  if (acquired.status !== "acquired") {
    throw new Error(`failed to acquire V3 segment lease: ${acquired.status}`);
  }
  const raw = new FileRunSessionV1({
    workspaceRoot: task.workspaceRoot,
    sessionId: task.sessionId,
    runId: task.runId,
    executionLease: acquired.lease,
  });
  try {
    const prefix = await raw.readCanonicalPrefix();
    const previous = prefix.at(-1);
    if (previous?.record.kind !== "derived_decision") {
      throw new Error("V3 segment fixture requires a terminal decision tail");
    }
    const decision = previous.record.decision;
    if (decision.action.kind !== "complete") {
      throw new Error("V3 segment fixture requires completed segment zero");
    }
    const segmentIndex =
      prefix.filter(
        (entry) =>
          entry.record.kind === "input_fact" &&
          entry.record.fact.type === "work.segment_started",
      ).length + 1;
    const root = accepted(inputId);
    await raw.appendInputFacts([root]);
    const snapshot = await raw.readInputSnapshot();
    await raw.commitDerivedDecision(snapshot.tailSeq, {
      ...decision,
      inputThroughSeq: snapshot.latestInputSeq,
    });
    await raw.appendInputFacts([
      {
        type: "work.segment_started",
        segmentIndex,
        inputId,
        reducerVersion: decision.reducerVersion,
        previousDecisionStateHash: decision.stateHash,
        previousAction: decision.action,
        policyVersion: WORK_SEGMENT_POLICY_VERSION_V1,
      },
      {
        type: "input.promoted",
        inputId,
        delivery: root.delivery,
        content: root.content,
        contentHash: root.contentHash,
      },
      accepted(pendingInputId),
    ]);
  } finally {
    raw.close();
    expect(await acquired.lease.release()).toBe("released");
  }
}

async function appendRawV3Facts(
  resolution: BuiltPawNextTaskProfileV3,
  facts: readonly import("@paw/protocol").InputFactV1[],
): Promise<void> {
  const task = resolution.taskOptions;
  const head = readFileSessionJournalCommitIndexV1(task).head;
  const acquired = acquireFileSessionExecutionLeaseV1({
    workspaceRoot: task.workspaceRoot,
    sessionId: task.sessionId,
    runId: task.runId,
    ttlMs: task.heartbeatPolicy.ttlMs,
    baseTailSeq: head.tailSeq,
    basePrefixHash: head.prefixHash,
  });
  if (acquired.status !== "acquired") {
    throw new Error(`failed to acquire V3 raw lease: ${acquired.status}`);
  }
  const raw = new FileRunSessionV1({
    workspaceRoot: task.workspaceRoot,
    sessionId: task.sessionId,
    runId: task.runId,
    executionLease: acquired.lease,
  });
  try {
    await raw.appendInputFacts(facts);
  } finally {
    raw.close();
    expect(await acquired.lease.release()).toBe("released");
  }
}

async function commitV3TerminalDecision(
  resolution: BuiltPawNextTaskProfileV3,
): Promise<void> {
  const task = resolution.taskOptions;
  const head = readFileSessionJournalCommitIndexV1(task).head;
  const acquired = acquireFileSessionExecutionLeaseV1({
    workspaceRoot: task.workspaceRoot,
    sessionId: task.sessionId,
    runId: task.runId,
    ttlMs: task.heartbeatPolicy.ttlMs,
    baseTailSeq: head.tailSeq,
    basePrefixHash: head.prefixHash,
  });
  if (acquired.status !== "acquired") {
    throw new Error(`failed to acquire V3 decision lease: ${acquired.status}`);
  }
  const raw = new FileRunSessionV1({
    workspaceRoot: task.workspaceRoot,
    sessionId: task.sessionId,
    runId: task.runId,
    executionLease: acquired.lease,
  });
  try {
    const snapshot = await raw.readInputSnapshot();
    const state = createInteractiveControlReducerV2().reduce(
      snapshot.entries.map((entry) => entry.fact),
      {
        mode: "interactive",
        maxModelTurns: task.maxModelTurns,
        naturalStop: task.naturalStop,
        maxSegments: task.maxSegments,
        maxTotalModelTurns: task.maxTotalModelTurns,
      },
    );
    if (state.decision.kind !== "completed") {
      throw new Error("V3 decision-tail fixture must be completed");
    }
    await raw.commitDerivedDecision(snapshot.tailSeq, {
      type: "control.decided",
      reducerVersion: state.reducerVersion,
      inputThroughSeq: snapshot.latestInputSeq,
      stateHash: hashCanonicalJsonV1(toFrozenJsonValueV1(state)),
      action: {
        kind: "complete",
        reasonCode: state.decision.reason,
      },
    });
  } finally {
    raw.close();
    expect(await acquired.lease.release()).toBe("released");
  }
}

async function appendBlockingReviewFeedback(
  resolution: BuiltPawNextTaskProfileV3,
  window: "accepted" | "decision",
): Promise<void> {
  const prefix = committedPrefix(resolution.taskOptions);
  const sourceThroughSeq = prefix.reduce(
    (latest, envelope) =>
      envelope.record.kind === "input_fact" ? envelope.seq : latest,
    0,
  );
  const candidateHash = createHash("sha256")
    .update(`${resolution.taskOptions.runId}:blocking-review`)
    .digest("hex");
  const reviewId = `completion-review-${candidateHash.slice(0, 32)}`;
  const settlement = {
    type: "completion.review_settled" as const,
    reviewId,
    status: "completed" as const,
    verdict: "block" as const,
    reasonCode: "missing_verification",
    summary: "Run one focused recovery verification.",
    settledAt: 3,
  };
  const inputId = completionReviewFeedbackInputIdV1(candidateHash);
  const content = createCompletionReviewFeedbackV1(settlement);
  await appendRawV3Facts(resolution, [
    {
      type: "completion.review_claimed",
      reviewId,
      candidateHash,
      policyVersion: COMPLETION_REVIEW_POLICY_VERSION_V1,
      reviewerId: "fixture-reviewer.v1",
      triggers: ["missing_fresh_verification"],
      sourceThroughSeq,
      claimedAt: 2,
    },
    settlement,
    {
      type: "input.accepted",
      inputId,
      delivery: "queue",
      content,
      contentHash: hashText(content),
      callerId: COMPLETION_REVIEW_FEEDBACK_CALLER_ID_V1,
    },
  ]);
  if (window === "decision") await commitV3TerminalDecision(resolution);
}

async function actionableToolResolution(
  identity: ReturnType<typeof taskIdentity>,
  file: string,
): Promise<BuiltPawNextTaskProfileV2> {
  fs.writeFileSync(path.join(identity.workspaceRoot, file), `${file}\n`);
  const resolution = resolutionWithModel(
    identity,
    new ScriptedModel([finalResponse(`seed:${file}`)]),
  );
  await runFreshPawNextTaskV2({ resolution });
  const callId = `read-${file.replaceAll(/[^A-Za-z0-9]/g, "-")}`;
  await appendV2Facts(resolution, [
    modelDispatch(2),
    completedToolModelSettlement(2, [toolCall(callId, file, 0)]),
    observedTool(2, callId, file, 0),
    toolDispatch(2, callId, 0),
    toolPermission(2, callId, 0),
    {
      type: "tool.settled",
      callId,
      status: "completed",
      observation: {
        schemaVersion: "paw.tool-observation.v1",
        summary: `historical ${file}`,
        isError: false,
        payload: inlinePayload({ content: `${file}\n` }),
      },
    },
  ]);
  return resolution;
}

async function appendRawFacts(
  resolution: BuiltPawNextTaskProfileV2,
  facts: readonly import("@paw/protocol").InputFactV1[],
): Promise<void> {
  const task = resolution.taskOptions;
  const head = readFileSessionJournalCommitIndexV1(task).head;
  const acquired = acquireFileSessionExecutionLeaseV1({
    workspaceRoot: task.workspaceRoot,
    sessionId: task.sessionId,
    runId: task.runId,
    ttlMs: task.heartbeatPolicy.ttlMs,
    baseTailSeq: head.tailSeq,
    basePrefixHash: head.prefixHash,
  });
  if (acquired.status !== "acquired") {
    throw new Error(`failed to acquire raw fixture lease: ${acquired.status}`);
  }
  const raw = new FileRunSessionV1({
    workspaceRoot: task.workspaceRoot,
    sessionId: task.sessionId,
    runId: task.runId,
    executionLease: acquired.lease,
  });
  try {
    await openFixtureSegmentBeforeModelDispatch(raw, facts);
    await raw.appendInputFacts(facts);
  } finally {
    raw.close();
    expect(await acquired.lease.release()).toBe("released");
  }
}

async function openFixtureSegmentBeforeModelDispatch(
  session: FileRunSessionV1,
  facts: readonly import("@paw/protocol").InputFactV1[],
): Promise<void> {
  if (!facts.some((fact) => fact.type === "model.dispatch_recorded")) return;
  const prefix = await session.readCanonicalPrefix();
  const previous = prefix.at(-1);
  if (previous?.record.kind !== "derived_decision") return;
  const decision = previous.record.decision;
  if (decision.action.kind !== "complete" && decision.action.kind !== "wait") {
    return;
  }
  const segmentIndex =
    prefix.filter(
      (entry) =>
        entry.record.kind === "input_fact" &&
        entry.record.fact.type === "work.segment_started",
    ).length + 1;
  const inputId = `fixture-segment-${segmentIndex}`;
  const content = `fixture segment ${segmentIndex}`;
  const contentHash = createHash("sha256").update(content).digest("hex");
  await session.appendInputFacts([
    {
      type: "input.accepted",
      inputId,
      delivery: "queue",
      content,
      contentHash,
      callerId: "fixture-segment",
    },
  ]);
  const snapshot = await session.readInputSnapshot();
  await session.commitDerivedDecision(snapshot.tailSeq, {
    ...decision,
    inputThroughSeq: snapshot.latestInputSeq,
  });
  await session.appendInputFacts([
    {
      type: "work.segment_started",
      segmentIndex,
      inputId,
      reducerVersion: decision.reducerVersion,
      previousDecisionStateHash: decision.stateHash,
      previousAction: decision.action,
      policyVersion: WORK_SEGMENT_POLICY_VERSION_V1,
    },
    {
      type: "input.promoted",
      inputId,
      delivery: "queue",
      content,
      contentHash,
    },
  ]);
}

async function appendRawIdentityFacts(
  identity: Pick<
    Parameters<typeof runFreshPawNextTaskV1>[0],
    "workspaceRoot" | "sessionId" | "runId" | "heartbeatPolicy"
  >,
  facts: readonly import("@paw/protocol").InputFactV1[],
): Promise<void> {
  const head = readFileSessionJournalCommitIndexV1(identity).head;
  const acquired = acquireFileSessionExecutionLeaseV1({
    workspaceRoot: identity.workspaceRoot,
    sessionId: identity.sessionId,
    runId: identity.runId,
    ttlMs: identity.heartbeatPolicy?.ttlMs ?? 90_000,
    baseTailSeq: head.tailSeq,
    basePrefixHash: head.prefixHash,
  });
  if (acquired.status !== "acquired") {
    throw new Error(`failed to acquire identity fixture: ${acquired.status}`);
  }
  const raw = new FileRunSessionV1({
    workspaceRoot: identity.workspaceRoot,
    sessionId: identity.sessionId,
    runId: identity.runId,
    executionLease: acquired.lease,
  });
  try {
    await openFixtureSegmentBeforeModelDispatch(raw, facts);
    await raw.appendInputFacts(facts);
  } finally {
    raw.close();
    expect(await acquired.lease.release()).toBe("released");
  }
}

function modelDispatch(
  turn: number,
): Extract<
  import("@paw/protocol").InputFactV1,
  { type: "model.dispatch_recorded" }
> {
  return {
    type: "model.dispatch_recorded",
    modelCallId: `model-${turn}`,
    turn,
    requestHash: `request-${turn}`,
  };
}

function toolCall(
  callId: string,
  file: string,
  sourceIndex: number,
): import("@paw/protocol").ModelResponseToolCallV1 {
  const args = { path: file };
  return {
    callId,
    name: "workspace_read_file",
    rawArguments: JSON.stringify(args),
    args,
    sourceIndex,
    argumentsValid: true,
  };
}

function completedToolModelSettlement(
  turn: number,
  calls: readonly import("@paw/protocol").ModelResponseToolCallV1[],
): Extract<import("@paw/protocol").InputFactV1, { type: "model.settled" }> {
  const response = {
    schemaVersion: "paw.model-response.v1" as const,
    providerProtocol: "openai-compatible" as const,
    assistantContent: "",
    finishReason: "tool_calls",
    toolCalls: calls,
  };
  return {
    type: "model.settled",
    modelCallId: `model-${turn}`,
    turn,
    status: "completed",
    hasToolCalls: true,
    hasVisibleOutput: false,
    finishReason: "tool_calls",
    response: inlinePayload(
      response as unknown as import("@paw/protocol").JsonValue,
    ),
  };
}

function completedPlainModelSettlement(
  turn: number,
  providerProtocol: "openai-compatible" | "anthropic-compatible",
  text: string,
): Extract<import("@paw/protocol").InputFactV1, { type: "model.settled" }> {
  const response = {
    schemaVersion: "paw.model-response.v1" as const,
    providerProtocol,
    assistantContent: text,
    finishReason: "stop",
    toolCalls: [],
  };
  return {
    type: "model.settled",
    modelCallId: `model-${turn}`,
    turn,
    status: "completed",
    hasToolCalls: false,
    hasVisibleOutput: true,
    finishReason: "stop",
    response: inlinePayload(response),
  };
}

function observedTool(
  turn: number,
  callId: string,
  file: string,
  sourceIndex: number,
): Extract<
  import("@paw/protocol").InputFactV1,
  { type: "tool.call_observed" }
> {
  return {
    type: "tool.call_observed",
    callId,
    modelCallId: `model-${turn}`,
    turn,
    tool: "workspace_read_file",
    args: { path: file },
    order: sourceIndex,
  };
}

function toolDispatch(
  turn: number,
  callId: string,
  sourceIndex: number,
): Extract<
  import("@paw/protocol").InputFactV1,
  { type: "tool.dispatch_recorded" }
> {
  return {
    type: "tool.dispatch_recorded",
    callId,
    turn,
    sourceIndex,
    batchId: `tool-batch-${turn}`,
    mode: "parallel",
  };
}

function toolPermission(
  turn: number,
  callId: string,
  sourceIndex: number,
): Extract<
  import("@paw/protocol").InputFactV1,
  { type: "tool.permission_resolved" }
> {
  return {
    type: "tool.permission_resolved",
    turn,
    sourceIndex,
    callId,
    tool: "workspace_read_file",
    policyVersion: "composition-v2-permission.v1",
    resolution: "allow_once",
    source: "base_policy",
    ruleId: "allow-read",
  };
}

function accepted(
  inputId: string,
): Extract<import("@paw/protocol").InputFactV1, { type: "input.accepted" }> {
  const content = `content:${inputId}`;
  return {
    type: "input.accepted",
    inputId,
    delivery: "queue",
    content,
    contentHash: hashText(content),
    callerId: "test-caller",
  };
}

function inlinePayload(value: import("@paw/protocol").JsonValue) {
  const frozen = toFrozenJsonValueV1(value);
  return {
    kind: "inline" as const,
    value: frozen,
    hash: hashCanonicalJsonV1(frozen),
  };
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function inputFacts(
  prefix: readonly import("@paw/protocol").RunJournalEnvelopeV1[],
) {
  return prefix.flatMap((envelope) =>
    envelope.record.kind === "input_fact" ? [envelope.record.fact] : [],
  );
}

function statusOf(
  report: Awaited<ReturnType<typeof scanAndResumePawNextRunsWithCatalogV1>>,
  identity: Pick<ReturnType<typeof taskIdentity>, "sessionId" | "runId">,
) {
  const run = report.runs.find(
    (candidate) =>
      candidate.sessionId === identity.sessionId &&
      candidate.runId === identity.runId,
  );
  if (!run) throw new Error("missing scanner report fixture");
  return run.status;
}

function newWorkCliArgs(
  identity: ReturnType<typeof taskIdentity>,
  inputId: string,
  callerId: string,
): readonly string[] {
  return [
    "--new-work-v3",
    "--root",
    identity.workspaceRoot,
    "--session-id",
    identity.sessionId,
    "--run-id",
    identity.runId,
    "--input-id",
    inputId,
    "--caller-id",
    callerId,
    "--stdin-json",
  ];
}

async function* cliStdin(content: string): AsyncIterable<Uint8Array> {
  yield new TextEncoder().encode(JSON.stringify({ content }));
}

async function assertExistingFailureLeavesJournalUnchanged(
  resolution: BuiltPawNextTaskProfileV2,
): Promise<void> {
  const identity = resolution.taskOptions;
  const before = committedPrefix(identity);
  const probe = new ScriptedModel([]);
  const candidate = resolutionWithReplacementModel(resolution, probe);
  await expect(
    runExistingPawNextTaskV2({ resolution: candidate }),
  ).rejects.toThrow();
  expect(probe.requests).toHaveLength(0);
  expect(committedPrefix(identity)).toEqual(before);
}

function payloadArtifactFile(root: string, artifactRef: string): string {
  const match = /^paw-payload:v1:([0-9a-f]{64})$/.exec(artifactRef);
  if (!match?.[1]) throw new Error("invalid payload artifact fixture ref");
  const name = `${match[1]}.json`;
  const payloadRoot = path.join(
    root,
    ".paw",
    "paw-next",
    "durable-json-payloads",
  );
  const matches: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.name === name) matches.push(absolute);
    }
  };
  visit(payloadRoot);
  if (matches.length !== 1) {
    throw new Error(
      `expected one payload artifact fixture, got ${matches.length}`,
    );
  }
  return matches[0] as string;
}

function committedPrefix(identity: ReturnType<typeof taskIdentity>) {
  const head = readFileSessionJournalCommitIndexV1(identity).head;
  return readCommittedFileRunPrefixV1({ ...identity, expectedHead: head });
}

function attemptConfigHash(
  facts: readonly import("@paw/protocol").InputFactV1[],
): string {
  const fact = facts.find((candidate) => candidate.type === "attempt.started");
  if (!fact || fact.type !== "attempt.started") {
    throw new Error("missing attempt.started");
  }
  return fact.configHash;
}

function rawTree(root: string): readonly string[] {
  const visit = (directory: string): string[] =>
    fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).replaceAll("\\", "/");
      return entry.isDirectory()
        ? [`d:${relative}`, ...visit(absolute)]
        : [`f:${relative}:${fs.readFileSync(absolute).toString("hex")}`];
    });
  return Object.freeze(visit(root).sort());
}
