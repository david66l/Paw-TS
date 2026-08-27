import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import type {
  ChatMessage,
  LanguageModel,
  ModelCompleteOptions,
  ModelCompletionResult,
  NativeToolCall,
} from "@paw/models";
import type {
  InputAttachmentV1,
  InputFactV1,
  ModelResponseV1,
} from "@paw/protocol";
import {
  FileRunSessionV1,
  acquireFileSessionExecutionLeaseV1,
  createPermissionRunRuleIdV1,
  readCommittedFileRunPrefixV1,
  readFileSessionJournalCommitIndexV1,
} from "@paw/runtime";

import {
  type RunFreshPawNextTaskOptionsV1,
  classifyPawNextExistingPrefixV1,
  preparePawNextProductRuntimeV1,
  runExistingPawNextTaskV1,
  runFreshPawNextTaskV1,
} from "../src/paw-next/composition.js";
import {
  PAW_NEXT_INLINE_PAYLOAD_CODEC_V1,
  createPawNextProductManifestV1,
  hashCanonicalJsonV1,
  hashPawNextProductManifestV1,
  toFrozenJsonValueV1,
} from "../src/paw-next/product-manifest.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("Paw Next existing-run controlled composition", () => {
  test("pure startup classification distinguishes terminal, blocked, repair, and continuing prefixes", async () => {
    const terminalRoot = workspace();
    const terminal = productOptions(
      terminalRoot,
      "classify-terminal",
      finalModel("done"),
    );
    await runFreshPawNextTaskV1(terminal);
    const terminalProbe = new ScriptedModel([]);
    const terminalResult = classifyPawNextExistingPrefixV1({
      prefix: readCommittedPrefix(terminal),
      options: { ...terminal, model: terminalProbe },
    });
    expect(terminalResult.status).toBe("terminal");
    expect(Object.isFrozen(terminalResult)).toBe(true);
    expect(Object.isFrozen(terminalResult.state)).toBe(true);
    expect(terminalProbe.requests).toHaveLength(0);

    await mutateRun(terminal, (session) =>
      session.appendInputFacts([accepted("classify-pending")]),
    );
    const blocked = classifyPawNextExistingPrefixV1({
      prefix: readCommittedPrefix(terminal),
      options: { ...terminal, model: terminalProbe },
    });
    expect(blocked).toMatchObject({
      status: "blocked_pending",
      inputIds: ["classify-pending"],
    });

    const repairRoot = workspace();
    const repair = productOptions(
      repairRoot,
      "classify-repair",
      finalModel("done"),
    );
    const repairPrepared = preparePawNextProductRuntimeV1(repair);
    await mutateRun(repair, (session) =>
      session.appendInputFacts([
        ...historicalWriteFacts(
          repair,
          repairPrepared.configHash,
          fixtureAllowOncePermission(),
          1,
        ),
        modelDispatch(2),
        accepted("pending-during-open-model"),
      ]),
    );
    const repairProbe = new ScriptedModel([]);
    const repairResult = classifyPawNextExistingPrefixV1({
      prefix: readCommittedPrefix(repair),
      options: { ...repair, model: repairProbe },
    });
    expect(repairResult.status).toBe("actionable_repair");
    expect(repairProbe.requests).toHaveLength(0);

    const continueRoot = workspace();
    const continueProbe = new ScriptedModel([]);
    const continuing = productOptions(
      continueRoot,
      "classify-continue",
      continueProbe,
    );
    const prepared = preparePawNextProductRuntimeV1(continuing);
    const continuingPrefix = prefixFromFacts(
      continuing,
      historicalWriteFacts(
        continuing,
        prepared.configHash,
        {
          resolution: "allow_once",
          source: "base_policy",
          policyVersion: allowAllPermissions().policyVersion,
          ruleId: "allow-write",
        },
        7,
      ),
    );
    const continueResult = classifyPawNextExistingPrefixV1({
      prefix: continuingPrefix,
      options: continuing,
    });
    expect(continueResult).toMatchObject({
      status: "actionable_continue",
      cursor: {
        lastModelTurn: 1,
        nextBoundary: "after_tool_batch_settled",
      },
    });
    expect(continueProbe.requests).toHaveLength(0);
  });

  test("repairs a dispatched tool before reporting pending input, without re-executing effects", async () => {
    const root = workspace();
    const model = new ScriptedModel([]);
    const common = productOptions(root, "repair-before-pending", model);
    const prepared = preparePawNextProductRuntimeV1(common);
    const openToolFacts = historicalWriteFacts(
      common,
      prepared.configHash,
      {
        resolution: "allow_once",
        source: "base_policy",
        policyVersion: allowAllPermissions().policyVersion,
        ruleId: "allow-write",
      },
      1,
    ).filter((fact) => fact.type !== "tool.settled");
    await mutateRun(common, (session) =>
      session.appendInputFacts([
        ...openToolFacts,
        accepted("pending-during-open-tool"),
      ]),
    );

    const before = classifyPawNextExistingPrefixV1({
      prefix: readCommittedPrefix(common),
      options: common,
    });
    expect(before.status).toBe("actionable_repair");

    await expect(runExistingPawNextTaskV1(common)).rejects.toThrow(
      /pending accepted input/i,
    );
    expect(model.requests).toHaveLength(0);
    const facts = await readFacts(common);
    expect(
      facts.filter(
        (fact) =>
          fact.type === "tool.settled" &&
          fact.callId === "write-seed" &&
          fact.status === "unknown",
      ),
    ).toHaveLength(1);
    const after = classifyPawNextExistingPrefixV1({
      prefix: readCommittedPrefix(common),
      options: common,
    });
    expect(after).toMatchObject({
      status: "blocked_pending",
      inputIds: ["pending-during-open-tool"],
    });
  });

  test("fresh and existing share one manifest hash and every frozen product dimension changes it", async () => {
    const base = manifestInput();
    const manifest = createPawNextProductManifestV1(base);
    expect(hashPawNextProductManifestV1(manifest)).toBe(
      hashPawNextProductManifestV1(createPawNextProductManifestV1(base)),
    );

    const variants = [
      { ...base, model: "other-model" },
      { ...base, systemPromptHash: "other-system" },
      { ...base, permissionPolicy: { policyVersion: "permission.v2" } },
      { ...base, approvalMode: "available" as const },
      { ...base, contextBudget: { contextWindowTokens: 16_000 } },
      {
        ...base,
        sessionLeaseHeartbeat: {
          policyVersion: "paw.session-lease-heartbeat.v1",
          ttlMs: 120_000,
          intervalMs: 30_000,
        },
      },
      {
        ...base,
        toolEffectCheckpointPolicyVersion: "paw.tool-effect-checkpoint.v2",
      },
    ];
    for (const changed of variants) {
      expect(
        hashPawNextProductManifestV1(createPawNextProductManifestV1(changed)),
      ).not.toBe(hashPawNextProductManifestV1(manifest));
    }
    expect(
      hashCanonicalJsonV1({
        ...manifest,
        payloadCodec: { id: "other-codec", version: "v2" },
      }),
    ).not.toBe(hashPawNextProductManifestV1(manifest));
    expect(manifest.payloadCodec).toEqual(PAW_NEXT_INLINE_PAYLOAD_CODEC_V1);

    const root = workspace();
    const common = productOptions(root, "shared", finalModel("done"));
    const fresh = await runFreshPawNextTaskV1(common);
    const resumedModel = new ScriptedModel([]);
    const resumed = await runExistingPawNextTaskV1({
      ...common,
      model: resumedModel,
    });
    expect(resumedModel.requests).toHaveLength(0);
    expect(attemptConfigHash(resumed.inputFacts)).toBe(
      attemptConfigHash(fresh.inputFacts),
    );
  });

  test("identity and prepared config drift fail before any repair, input, model or tool activity", async () => {
    const root = workspace();
    const common = productOptions(root, "identity", finalModel("done"));
    await runFreshPawNextTaskV1(common);

    const cases: ReadonlyArray<{
      readonly name: string;
      readonly change: Record<string, unknown>;
    }> = [
      { name: "input id", change: { inputId: "wrong-input" } },
      { name: "goal body/hash", change: { goal: "different goal" } },
      { name: "system", change: { systemPrompt: "different system" } },
      { name: "budget", change: { contextWindowTokens: 31_000 } },
      {
        name: "permission policy",
        change: {
          permissionConfig: {
            ...allowAllPermissions(),
            policyVersion: "other-policy.v1",
          },
        },
      },
    ];
    for (const item of cases) {
      const before = journalHead(root, common.sessionId, common.runId);
      const model = new ScriptedModel([]);
      await expect(
        runExistingPawNextTaskV1({
          ...common,
          model,
          ...item.change,
        }),
        item.name,
      ).rejects.toThrow();
      expect(model.requests, item.name).toHaveLength(0);
      expect(
        journalHead(root, common.sessionId, common.runId),
        item.name,
      ).toEqual(before);
    }
  });

  test("historical decision drift is rejected before an inflight model can be repaired", async () => {
    const root = workspace();
    const common = productOptions(root, "decision-drift", finalModel("done"));
    const prepared = preparePawNextProductRuntimeV1(common);
    await mutateRun(common, async (session) => {
      await session.appendInputFacts([
        ...historicalWriteFacts(
          common,
          prepared.configHash,
          fixtureAllowOncePermission(),
          1,
        ),
        accepted("audit-only"),
      ]);
      const snapshot = await session.readInputSnapshot();
      await session.commitDerivedDecision(snapshot.tailSeq, {
        type: "control.decided",
        reducerVersion: "paw.interactive-control.v1",
        inputThroughSeq: snapshot.latestInputSeq,
        stateHash: "tampered-state-hash",
        action: { kind: "continue", reasonCode: "tampered-continue" },
      });
      await session.appendInputFacts([modelDispatch(2)]);
    });
    const before = journalHead(root, common.sessionId, common.runId);
    const model = new ScriptedModel([]);

    await expect(
      runExistingPawNextTaskV1({ ...common, model }),
    ).rejects.toThrow(/stateHash|replay|diverg/i);
    expect(model.requests).toHaveLength(0);
    expect(journalHead(root, common.sessionId, common.runId)).toEqual(before);
    expect(
      (await readFacts(common)).filter(
        (fact) =>
          fact.type === "model.settled" && fact.modelCallId === "model-2",
      ),
    ).toHaveLength(0);
  });

  test("artifact payloads and bad inline hashes fail preflight before repair", async () => {
    const attachments: ReadonlyArray<{
      readonly name: string;
      readonly attachment: InputAttachmentV1;
    }> = [
      {
        name: "artifact",
        attachment: {
          attachmentId: "attachment-artifact",
          type: "file",
          name: "artifact.txt",
          content: {
            kind: "artifact_ref",
            artifactRef: "artifact:unsupported",
            hash: "artifact-hash",
          },
        },
      },
      {
        name: "bad-inline-hash",
        attachment: {
          attachmentId: "attachment-inline",
          type: "file",
          name: "inline.txt",
          content: {
            kind: "inline",
            value: "inline body",
            hash: "wrong-inline-hash",
          },
        },
      },
    ];

    for (const item of attachments) {
      const root = workspace();
      const common = productOptions(root, item.name, finalModel("done"));
      const prepared = preparePawNextProductRuntimeV1(common);
      await mutateRun(common, async (session) => {
        await session.appendInputFacts([
          ...historicalWriteFacts(
            common,
            prepared.configHash,
            fixtureAllowOncePermission(),
            1,
          ),
          accepted(`pending-${item.name}`, [item.attachment]),
          modelDispatch(2),
        ]);
      });
      const before = journalHead(root, common.sessionId, common.runId);
      const model = new ScriptedModel([]);

      await expect(
        runExistingPawNextTaskV1({ ...common, model }),
        item.name,
      ).rejects.toThrow();
      expect(model.requests, item.name).toHaveLength(0);
      expect(
        journalHead(root, common.sessionId, common.runId),
        item.name,
      ).toEqual(before);
      expect(
        (await readFacts(common)).filter(
          (fact) =>
            fact.type === "model.settled" && fact.modelCallId === "model-2",
        ),
        item.name,
      ).toHaveLength(0);
    }
  });

  test("repair is replayed before the Loop and reopening does not duplicate it", async () => {
    const root = workspace();
    const common = productOptions(root, "repair-replay", finalModel("done"));
    const prepared = preparePawNextProductRuntimeV1(common);
    await mutateRun(common, (session) =>
      session.appendInputFacts([
        ...historicalWriteFacts(
          common,
          prepared.configHash,
          fixtureAllowOncePermission(),
          1,
        ),
        modelDispatch(2),
      ]),
    );

    const firstModel = new ScriptedModel([]);
    const first = await runExistingPawNextTaskV1({
      ...common,
      model: firstModel,
    });
    expect(firstModel.requests).toHaveLength(0);
    expect(first.state.decision).toEqual({
      kind: "incomplete",
      reason: "model-result-unknown",
    });
    expect(modelUnknowns(first.inputFacts, "model-2")).toHaveLength(1);

    const firstTail = first.tailSeq;
    const secondModel = new ScriptedModel([]);
    const second = await runExistingPawNextTaskV1({
      ...common,
      model: secondModel,
    });
    expect(secondModel.requests).toHaveLength(0);
    expect(second.tailSeq).toBe(firstTail);
    expect(modelUnknowns(second.inputFacts, "model-2")).toHaveLength(1);
  });

  test("terminal history never silently consumes a pending inbox item", async () => {
    const root = workspace();
    const common = productOptions(root, "terminal-pending", finalModel("done"));
    await runFreshPawNextTaskV1(common);
    await mutateRun(common, (session) =>
      session.appendInputFacts([accepted("pending-after-terminal")]),
    );
    const before = journalHead(root, common.sessionId, common.runId);
    const model = new ScriptedModel([]);

    await expect(
      runExistingPawNextTaskV1({ ...common, model }),
    ).rejects.toThrow(/pending accepted input/i);
    expect(model.requests).toHaveLength(0);
    expect(journalHead(root, common.sessionId, common.runId)).toEqual(before);
    const facts = await readFacts(common);
    expect(
      facts.filter(
        (fact) =>
          fact.type === "input.accepted" &&
          fact.inputId === "pending-after-terminal",
      ),
    ).toHaveLength(1);
    expect(
      facts.filter(
        (fact) =>
          fact.type === "input.promoted" &&
          fact.inputId === "pending-after-terminal",
      ),
    ).toHaveLength(0);
  });

  test("terminal history never silently consumes an already-promoted inbox item", async () => {
    const root = workspace();
    const common = productOptions(
      root,
      "terminal-promoted",
      finalModel("done"),
    );
    await runFreshPawNextTaskV1(common);
    const promoted = accepted("promoted-after-terminal");
    await mutateRun(common, (session) =>
      session.appendInputFacts([
        promoted,
        {
          type: "input.promoted",
          inputId: promoted.inputId,
          delivery: promoted.delivery,
          content: promoted.content,
          contentHash: promoted.contentHash,
        },
      ]),
    );
    const before = journalHead(root, common.sessionId, common.runId);
    const model = new ScriptedModel([]);

    await expect(
      runExistingPawNextTaskV1({ ...common, model }),
    ).rejects.toThrow(/unconsumed promoted input/i);
    expect(model.requests).toHaveLength(0);
    expect(journalHead(root, common.sessionId, common.runId)).toEqual(before);
  });

  test("an existing terminal is replayed before a pre-aborted caller", async () => {
    const root = workspace();
    const common = productOptions(
      root,
      "terminal-preabort",
      finalModel("done"),
    );
    const fresh = await runFreshPawNextTaskV1(common);
    const controller = new AbortController();
    controller.abort(new Error("caller already stopped waiting"));
    const model = new ScriptedModel([]);

    const resumed = await runExistingPawNextTaskV1({
      ...common,
      model,
      signal: controller.signal,
    });

    expect(resumed.state.decision).toEqual(fresh.state.decision);
    expect(resumed.tailSeq).toBe(fresh.tailSeq);
    expect(model.requests).toHaveLength(0);
  });

  test("legacy allowed mutating history without an allocation fails before repair", async () => {
    const probeRoot = workspace();
    const probe = productOptions(
      probeRoot,
      "missing-allocation-probe",
      finalModel("done"),
    );
    const configHash = attemptConfigHash(
      (await runFreshPawNextTaskV1(probe)).inputFacts,
    );
    const root = workspace();
    const model = new ScriptedModel([]);
    const common = productOptions(root, "missing-allocation", model);
    await mutateRun(common, (session) =>
      session.appendInputFacts([
        ...historicalWriteFacts(common, configHash, {
          resolution: "allow_once",
          source: "base_policy",
          policyVersion: allowAllPermissions().policyVersion,
          ruleId: "allow-write",
        }),
        modelDispatch(2),
      ]),
    );
    const before = journalHead(root, common.sessionId, common.runId);

    await expect(runExistingPawNextTaskV1(common)).rejects.toThrow(
      /checkpoint allocation/i,
    );
    expect(model.requests).toHaveLength(0);
    expect(journalHead(root, common.sessionId, common.runId)).toEqual(before);
    expect(modelUnknowns(await readFacts(common), "model-2")).toHaveLength(0);
  });

  test("impossible prompted permission history is rejected before repair", async () => {
    const permissionConfig = askPermissions();
    const probeRoot = workspace();
    const probe = {
      ...productOptions(
        probeRoot,
        "unavailable-grant-probe",
        finalModel("done"),
      ),
      permissionConfig,
    };
    const configHash = attemptConfigHash(
      (await runFreshPawNextTaskV1(probe)).inputFacts,
    );
    const root = workspace();
    const model = new ScriptedModel([]);
    const common = {
      ...productOptions(root, "unavailable-grant", model),
      permissionConfig,
    };
    const ruleId = createPermissionRunRuleIdV1({
      policyVersion: permissionConfig.policyVersion,
      tool: "workspace.write_file",
      category: "write",
    });
    await mutateRun(common, (session) =>
      session.appendInputFacts([
        ...historicalWriteFacts(
          common,
          configHash,
          {
            resolution: "allow_rule",
            source: "user_prompt",
            policyVersion: permissionConfig.policyVersion,
            ruleId,
          },
          4,
        ),
        modelDispatch(2),
      ]),
    );
    const before = journalHead(root, common.sessionId, common.runId);

    await expect(runExistingPawNextTaskV1(common)).rejects.toThrow(
      /frozen base policy/i,
    );
    expect(model.requests).toHaveLength(0);
    expect(journalHead(root, common.sessionId, common.runId)).toEqual(before);
    expect(modelUnknowns(await readFacts(common), "model-2")).toHaveLength(0);
  });

  test("hydrates a canonical user allow-rule grant before executing the next call", async () => {
    const permissionConfig = askPermissions();
    let approvalCalls = 0;
    const requestApproval = async () => {
      approvalCalls += 1;
      return { decision: "deny" as const };
    };
    const probeRoot = workspace();
    const probe = {
      ...productOptions(probeRoot, "allow-rule-probe", finalModel("done")),
      permissionConfig,
      requestApproval,
    };
    const configHash = attemptConfigHash(
      (await runFreshPawNextTaskV1(probe)).inputFacts,
    );
    const root = workspace();
    const ruleId = createPermissionRunRuleIdV1({
      policyVersion: permissionConfig.policyVersion,
      tool: "workspace.write_file",
      category: "write",
    });
    const model = new ScriptedModel([
      toolResponse("write-next", "workspace_write_file", {
        path: "next.txt",
        content: "next",
      }),
      {
        text: "resumed from run rule",
        nativeAssistantContent: "resumed from run rule",
        finishReason: "stop",
      },
    ]);
    const common = {
      ...productOptions(root, "allow-rule", model),
      permissionConfig,
      requestApproval,
    };
    await mutateRun(common, (session) =>
      session.appendInputFacts(
        historicalWriteFacts(
          common,
          configHash,
          {
            resolution: "allow_rule",
            source: "user_prompt",
            policyVersion: permissionConfig.policyVersion,
            ruleId,
          },
          4,
        ),
      ),
    );

    const result = await runExistingPawNextTaskV1(common);
    expect(approvalCalls).toBe(0);
    expect(result.assistantText).toBe("resumed from run rule");
    expect(fs.readFileSync(path.join(root, "next.txt"), "utf8")).toBe("next");
    expect(
      result.inputFacts.find(
        (fact) =>
          fact.type === "tool.permission_resolved" &&
          fact.callId === "write-next",
      ),
    ).toMatchObject({
      resolution: "allow_rule",
      source: "run_rule",
      ruleId,
    });
  });

  test("checkpoint allocation resumes at canonical max plus one and preserves gaps", async () => {
    const probeRoot = workspace();
    const probe = productOptions(
      probeRoot,
      "allocation-probe",
      finalModel("done"),
    );
    const probeResult = await runFreshPawNextTaskV1(probe);
    const configHash = attemptConfigHash(probeResult.inputFacts);

    const root = workspace();
    const model = new ScriptedModel([
      toolResponse("write-next", "workspace_write_file", {
        path: "next.txt",
        content: "next",
      }),
      {
        text: "resumed",
        nativeAssistantContent: "resumed",
        finishReason: "stop",
      },
    ]);
    const common = productOptions(root, "allocation-resume", model);
    const seededResponse = durableToolResponse(
      "write-seed",
      "workspace_write_file",
      { path: "seed.txt", content: "seed" },
    );
    await mutateRun(common, (session) =>
      session.appendInputFacts([
        {
          type: "attempt.started",
          goalHash: hashText(common.goal),
          configHash,
        },
        {
          type: "input.promoted",
          inputId: common.inputId,
          delivery: "initial",
          content: common.goal,
          contentHash: hashText(common.goal),
        },
        modelDispatch(1),
        {
          type: "model.settled",
          modelCallId: "model-1",
          turn: 1,
          status: "completed",
          hasToolCalls: true,
          hasVisibleOutput: false,
          response: {
            kind: "inline",
            value: toFrozenJsonValueV1(seededResponse),
            hash: hashCanonicalJsonV1(seededResponse),
          },
          finishReason: "tool_calls",
        },
        {
          type: "tool.call_observed",
          callId: "write-seed",
          modelCallId: "model-1",
          turn: 1,
          tool: "workspace_write_file",
          args: { path: "seed.txt", content: "seed" },
          order: 0,
        },
        {
          type: "tool.dispatch_recorded",
          callId: "write-seed",
          turn: 1,
          sourceIndex: 0,
          batchId: "tool-batch-1",
          mode: "parallel",
        },
        {
          type: "tool.permission_resolved",
          turn: 1,
          sourceIndex: 0,
          callId: "write-seed",
          tool: "workspace_write_file",
          policyVersion: allowAllPermissions().policyVersion,
          resolution: "allow_once",
          source: "base_policy",
          ruleId: "allow-write",
        },
        {
          type: "tool.effect_checkpoint_allocated",
          callId: "write-seed",
          turn: 1,
          sourceIndex: 0,
          checkpointSeq: 7,
        },
        {
          type: "tool.settled",
          callId: "write-seed",
          status: "completed",
          observation: {
            schemaVersion: "paw.tool-observation.v1",
            summary: "seeded historical write",
            isError: false,
          },
        },
      ]),
    );

    const result = await runExistingPawNextTaskV1(common);
    expect(result.assistantText).toBe("resumed");
    expect(model.requests).toHaveLength(2);
    expect(
      result.inputFacts
        .filter(
          (
            fact,
          ): fact is Extract<
            InputFactV1,
            { type: "tool.effect_checkpoint_allocated" }
          > => fact.type === "tool.effect_checkpoint_allocated",
        )
        .map((fact) => fact.checkpointSeq),
    ).toEqual([7, 8]);
    expect(fs.readFileSync(path.join(root, "next.txt"), "utf8")).toBe("next");
  });
});

class ScriptedModel implements LanguageModel {
  readonly label = "scripted-openai";
  readonly capabilities = {
    contextWindow: 32_000,
    maxOutputTokens: 2_048,
  };
  readonly runtimeProfile = {
    protocol: "openai-compatible" as const,
    model: "scripted",
    baseUrl: "https://example.invalid/v1",
  };
  readonly requests: ChatMessage[][] = [];
  private index = 0;

  constructor(private readonly responses: readonly ModelCompletionResult[]) {}

  async complete(
    messages: readonly ChatMessage[],
    _options?: ModelCompleteOptions,
  ): Promise<ModelCompletionResult> {
    this.requests.push(messages.map((message) => ({ ...message })));
    const response = this.responses[this.index];
    this.index += 1;
    if (!response) throw new Error("No scripted response remains");
    return response;
  }
}

function finalModel(text: string): ScriptedModel {
  return new ScriptedModel([
    { text, nativeAssistantContent: text, finishReason: "stop" },
  ]);
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

function durableToolResponse(
  callId: string,
  name: string,
  args: Record<string, string>,
): ModelResponseV1 {
  return {
    schemaVersion: "paw.model-response.v1",
    providerProtocol: "openai-compatible",
    assistantContent: "",
    finishReason: "tool_calls",
    toolCalls: [
      {
        callId,
        name,
        rawArguments: JSON.stringify(args),
        args,
        sourceIndex: 0,
        argumentsValid: true,
      },
    ],
  };
}

function historicalWriteFacts(
  options: Pick<RunFreshPawNextTaskOptionsV1, "inputId" | "goal">,
  configHash: string,
  permission: Pick<
    Extract<InputFactV1, { type: "tool.permission_resolved" }>,
    "resolution" | "source" | "policyVersion" | "ruleId"
  >,
  checkpointSeq?: number,
): InputFactV1[] {
  const args = { path: "seed.txt", content: "seed" };
  const response = durableToolResponse(
    "write-seed",
    "workspace_write_file",
    args,
  );
  return [
    {
      type: "attempt.started",
      goalHash: hashText(options.goal),
      configHash,
    },
    {
      type: "input.promoted",
      inputId: options.inputId,
      delivery: "initial",
      content: options.goal,
      contentHash: hashText(options.goal),
    },
    modelDispatch(1),
    {
      type: "model.settled",
      modelCallId: "model-1",
      turn: 1,
      status: "completed",
      hasToolCalls: true,
      hasVisibleOutput: false,
      response: {
        kind: "inline",
        value: toFrozenJsonValueV1(response),
        hash: hashCanonicalJsonV1(response),
      },
      finishReason: "tool_calls",
    },
    {
      type: "tool.call_observed",
      callId: "write-seed",
      modelCallId: "model-1",
      turn: 1,
      tool: "workspace_write_file",
      args,
      order: 0,
    },
    {
      type: "tool.dispatch_recorded",
      callId: "write-seed",
      turn: 1,
      sourceIndex: 0,
      batchId: "tool-batch-1",
      mode: "parallel",
    },
    {
      type: "tool.permission_resolved",
      turn: 1,
      sourceIndex: 0,
      callId: "write-seed",
      tool: "workspace_write_file",
      ...permission,
    },
    ...(checkpointSeq === undefined
      ? []
      : [
          {
            type: "tool.effect_checkpoint_allocated" as const,
            callId: "write-seed",
            turn: 1,
            sourceIndex: 0,
            checkpointSeq,
          },
        ]),
    {
      type: "tool.settled",
      callId: "write-seed",
      status: "completed",
      observation: {
        schemaVersion: "paw.tool-observation.v1",
        summary: "seeded historical write",
        isError: false,
      },
    },
  ];
}

function productOptions(
  root: string,
  suffix: string,
  model: LanguageModel,
): RunFreshPawNextTaskOptionsV1 {
  return {
    workspaceRoot: root,
    sessionId: `session-${suffix}`,
    runId: `run-${suffix}`,
    inputId: `input-${suffix}`,
    goal: "inspect and complete the task",
    model,
    providerProtocol: "openai-compatible",
    transport: "complete",
    permissionConfig: allowAllPermissions(),
    estimator: smallEstimator(),
    estimatorId: "test-small-estimator",
    estimatorVersion: "v1",
  };
}

function allowAllPermissions() {
  return {
    policyVersion: "test-allow-all.v1",
    defaultAction: "deny" as const,
    rules: (["read", "write", "shell"] as const).map((category) => ({
      id: `allow-${category}`,
      layer: "default" as const,
      category,
      action: "allow" as const,
    })),
  };
}

function fixtureAllowOncePermission() {
  return {
    resolution: "allow_once" as const,
    source: "base_policy" as const,
    policyVersion: allowAllPermissions().policyVersion,
    ruleId: "allow-write",
  };
}

function askPermissions() {
  return {
    policyVersion: "test-ask.v1",
    defaultAction: "ask" as const,
    rules: [],
  };
}

function smallEstimator() {
  return {
    count: (text: string) => Math.ceil(text.length / 4),
    countMessages: (messages: readonly ChatMessage[]) =>
      messages.reduce(
        (total, message) => total + Math.ceil(message.content.length / 4),
        0,
      ),
  };
}

function manifestInput() {
  return {
    toolEffectCheckpointPolicyVersion: "paw.tool-effect-checkpoint.v1",
    reducerVersion: "paw.interactive-control.v1",
    runConfig: {
      mode: "interactive",
      maxModelTurns: 64,
      naturalStop: "complete",
    },
    model: "scripted-openai",
    providerProtocol: "openai-compatible",
    transport: "complete",
    registryHash: "registry-hash",
    shellSandboxHash: "sandbox-hash",
    permissionPolicy: { policyVersion: "permission.v1" },
    approvalMode: "unavailable",
    systemPromptHash: "system-hash",
    contextBudget: {
      contextWindowTokens: 32_000,
      reservedOutputTokens: 2_048,
      estimationMarginTokens: 1_024,
      estimatorId: "test-small-estimator",
      estimatorVersion: "v1",
    },
    modelRuntimeProfile: { model: "scripted" },
    modelCapabilities: { contextWindow: 32_000 },
    sessionLeaseHeartbeat: {
      policyVersion: "paw.session-lease-heartbeat.v1",
      ttlMs: 60_000,
      intervalMs: 20_000,
    },
  } as const;
}

function accepted(
  inputId: string,
  attachments?: readonly InputAttachmentV1[],
): Extract<InputFactV1, { type: "input.accepted" }> {
  const content = `content:${inputId}`;
  return {
    type: "input.accepted",
    inputId,
    delivery: "queue",
    content,
    contentHash: hashText(content),
    callerId: "test-caller",
    ...(attachments ? { attachments } : {}),
  };
}

function modelDispatch(turn: number): InputFactV1 {
  return {
    type: "model.dispatch_recorded",
    modelCallId: `model-${turn}`,
    turn,
    requestHash: `request-${turn}`,
  };
}

async function mutateRun(
  options: Pick<
    RunFreshPawNextTaskOptionsV1,
    "workspaceRoot" | "sessionId" | "runId"
  >,
  work: (session: FileRunSessionV1) => Promise<unknown>,
): Promise<void> {
  const index = journalIndex(options);
  const acquired = acquireFileSessionExecutionLeaseV1({
    workspaceRoot: options.workspaceRoot,
    sessionId: options.sessionId,
    runId: options.runId,
    ttlMs: 60_000,
    baseTailSeq: index.head.tailSeq,
    basePrefixHash: index.head.prefixHash,
  });
  if (acquired.status !== "acquired") {
    throw new Error(`failed to acquire test lease: ${acquired.status}`);
  }
  const session = new FileRunSessionV1({
    workspaceRoot: options.workspaceRoot,
    sessionId: options.sessionId,
    runId: options.runId,
    executionLease: acquired.lease,
  });
  try {
    await work(session);
  } finally {
    session.close();
    const released = await acquired.lease.release();
    expect(released).toBe("released");
  }
}

async function readFacts(
  options: Pick<
    RunFreshPawNextTaskOptionsV1,
    "workspaceRoot" | "sessionId" | "runId"
  >,
): Promise<readonly InputFactV1[]> {
  let facts: readonly InputFactV1[] = [];
  await mutateRun(options, async (session) => {
    facts = (await session.readInputSnapshot()).entries.map(
      (entry) => entry.fact,
    );
  });
  return facts;
}

function journalIndex(
  options: Pick<
    RunFreshPawNextTaskOptionsV1,
    "workspaceRoot" | "sessionId" | "runId"
  >,
) {
  return readFileSessionJournalCommitIndexV1(options);
}

function journalHead(workspaceRoot: string, sessionId: string, runId: string) {
  return journalIndex({ workspaceRoot, sessionId, runId }).head;
}

function readCommittedPrefix(
  options: Pick<
    RunFreshPawNextTaskOptionsV1,
    "workspaceRoot" | "sessionId" | "runId"
  >,
) {
  const index = journalIndex(options);
  return readCommittedFileRunPrefixV1({
    ...options,
    expectedHead: index.head,
  });
}

function prefixFromFacts(
  options: Pick<RunFreshPawNextTaskOptionsV1, "sessionId" | "runId">,
  facts: readonly InputFactV1[],
) {
  return facts.map((fact, index) => ({
    schemaVersion: "paw.run-journal.v1" as const,
    sessionId: options.sessionId,
    runId: options.runId,
    seq: index + 1,
    ts: 0,
    record: { kind: "input_fact" as const, fact },
  }));
}

function attemptConfigHash(facts: readonly InputFactV1[]): string {
  const attempt = facts.find((fact) => fact.type === "attempt.started");
  if (!attempt || attempt.type !== "attempt.started") {
    throw new Error("missing attempt.started");
  }
  return attempt.configHash;
}

function modelUnknowns(facts: readonly InputFactV1[], modelCallId: string) {
  return facts.filter(
    (fact) =>
      fact.type === "model.settled" &&
      fact.modelCallId === modelCallId &&
      fact.status === "unknown",
  );
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-next-existing-"));
  roots.push(root);
  return root;
}
