import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import { CostTracker } from "@paw/core";
import type {
  ChatMessage,
  LanguageModel,
  ModelCompleteOptions,
  ModelCompletionResult,
  NativeToolCall,
} from "@paw/models";
import {
  FileRunSessionV1,
  PAW_TOOL_EFFECT_CHECKPOINT_POLICY_VERSION_V1,
  SessionCoordinatorV1,
  type SessionLeaseScheduledTaskV1,
  type SessionLeaseSchedulerV1,
  acquireFileSessionExecutionLeaseV1,
  readFileSessionJournalCommitIndexV1,
} from "@paw/runtime";

import {
  type PawModelSettlementTelemetryV1,
  preparePawNextProductRuntimeV1,
  runFreshPawNextTaskV1,
} from "../src/paw-next/composition.js";
import {
  createPawNextProductManifestV1,
  hashCanonicalJsonV1,
  hashPawNextProductManifestV1,
} from "../src/paw-next/product-manifest.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("Paw Next controlled product composition", () => {
  test("persists provider cache telemetry in the model settlement journal", async () => {
    const root = workspace();
    const costTracker = new CostTracker();
    const settlements: PawModelSettlementTelemetryV1[] = [];
    const model = new ScriptedModel([
      {
        text: "done",
        nativeAssistantContent: "done",
        finishReason: "stop",
        usage: {
          promptTokens: 1_000,
          completionTokens: 20,
          totalTokens: 1_020,
          cachedPromptTokens: 768,
          cacheMissPromptTokens: 232,
        },
      },
    ]);

    const result = await runFreshPawNextTaskV1({
      workspaceRoot: root,
      sessionId: "session-cache-telemetry",
      runId: "run-cache-telemetry",
      inputId: "input-cache-telemetry",
      goal: "finish",
      model,
      transport: "complete",
      permissionConfig: allowAllPermissions(),
      estimator: smallEstimator(),
      estimatorId: "test-small-estimator",
      estimatorVersion: "v1",
      costTracker,
      onModelSettlement: (event) => settlements.push(event),
    });

    const settled = result.inputFacts.find(
      (fact) => fact.type === "model.settled" && fact.response !== undefined,
    );
    if (!settled || settled.type !== "model.settled" || !settled.response) {
      throw new Error("cache telemetry settlement is missing");
    }
    expect(settled.response.kind).toBe("inline");
    if (settled.response.kind !== "inline") {
      throw new Error("cache telemetry response must be inline");
    }
    expect(settled.response.value).toMatchObject({
      usage: {
        promptTokens: 1_000,
        cachedPromptTokens: 768,
        cacheMissPromptTokens: 232,
      },
    });
    expect(costTracker.snapshot()).toMatchObject({
      cachedPromptTokens: 768,
      cacheMissPromptTokens: 232,
      cacheHitRate: 0.768,
    });
    expect(settlements).toEqual([
      expect.objectContaining({
        modelLabel: model.label,
        sessionId: "session-cache-telemetry",
        runId: "run-cache-telemetry",
        status: "success",
        usage: expect.objectContaining({
          cachedPromptTokens: 768,
          cacheMissPromptTokens: 232,
        }),
      }),
    ]);
  });

  test("installs coding tool plugins through the product composition", async () => {
    const root = workspace();
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "a.ts"), "export const a = 1;\n");
    const model = new ScriptedModel([
      toolResponse("list-src", "workspace_list_dir", { path: "." }),
      {
        text: "workspace inspected",
        nativeAssistantContent: "workspace inspected",
        finishReason: "stop",
      },
    ]);
    const runOptions = {
      workspaceRoot: root,
      sessionId: "session-workspace-inspection-plugin",
      runId: "run-workspace-inspection-plugin",
      inputId: "input-workspace-inspection-plugin",
      goal: "inspect the workspace",
      model,
      transport: "complete",
      permissionConfig: allowAllPermissions(),
      estimator: smallEstimator(),
      estimatorId: "test-small-estimator",
      estimatorVersion: "v1",
    } as const;

    const prepared = preparePawNextProductRuntimeV1(runOptions);
    expect(prepared.registry.plugins).toEqual([
      {
        pluginId: "paw.code-intelligence",
        pluginVersion: "paw.code-intelligence.v1",
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
      prepared.registry.entries
        .filter((entry) => entry.pluginId === "paw.workspace-inspection")
        .map((entry) => entry.providerName)
        .sort(),
    ).toEqual([
      "workspace_git_diff",
      "workspace_git_log",
      "workspace_git_status",
      "workspace_glob",
      "workspace_list_dir",
      "workspace_search",
    ]);

    const result = await runFreshPawNextTaskV1(runOptions);

    expect(result.state.decision.kind).toBe("completed");
    expect(result.state.settledToolCalls).toBe(1);
    expect(model.toolInventories[0]).toEqual(
      expect.arrayContaining([
        "workspace_list_dir",
        "workspace_search",
        "workspace_glob",
        "workspace_git_status",
        "workspace_git_diff",
        "workspace_git_log",
        "workspace_apply_patch",
        "workspace_symbol_search",
        "workspace_lsp",
      ]),
    );
    expect(toolPayload(requestAt(model, 1))).toMatchObject({
      files: expect.arrayContaining(["src/"]),
    });
    expect(
      result.inputFacts.filter(
        (fact) => fact.type === "tool.permission_resolved",
      ),
    ).toHaveLength(1);
  });

  test("durably wakes the model when a background Job settles", async () => {
    const root = workspace();
    fs.writeFileSync(
      path.join(root, "auto-wake.mjs"),
      "setTimeout(() => process.stdout.write('auto-ok'), 400);\n",
    );
    const model = new ScriptedModel([
      toolResponse("job-start", "workspace_job_start", {
        command: `${JSON.stringify(process.execPath)} auto-wake.mjs`,
      }),
      {
        text: "premature completion",
        nativeAssistantContent: "premature completion",
        finishReason: "stop",
      },
      {
        text: "completed after durable wake",
        nativeAssistantContent: "completed after durable wake",
        finishReason: "stop",
      },
    ]);

    const result = await runFreshPawNextTaskV1({
      workspaceRoot: root,
      sessionId: "session-auto-wake-job",
      runId: "run-auto-wake-job",
      inputId: "input-auto-wake-job",
      goal: "start the background command and finish after it exits",
      model,
      transport: "complete",
      permissionConfig: allowAllPermissions(),
      estimator: smallEstimator(),
      estimatorId: "test-small-estimator",
      estimatorVersion: "v1",
    });

    expect(result.state.decision.kind).toBe("completed");
    expect(result.assistantText).toBe("completed after durable wake");
    expect(model.requests).toHaveLength(3);
    expect(
      result.inputFacts
        .map((fact) => fact.type)
        .filter((type) => type.startsWith("runtime.activity_")),
    ).toEqual(["runtime.activity_started", "runtime.activity_settled"]);
    expect(
      requestAt(model, 2).some((message) =>
        message.content.includes("[Paw Runtime Activity]"),
      ),
    ).toBeTrue();
    expect(
      requestAt(model, 2).some((message) =>
        message.content.includes('"status":"completed"'),
      ),
    ).toBeTrue();
  }, 15_000);

  test("runs a managed background shell job through the product runtime", async () => {
    const root = workspace();
    fs.writeFileSync(
      path.join(root, "background.mjs"),
      "setTimeout(() => process.stdout.write('job-ok'), 50);\n",
    );
    const model = new ScriptedModel([
      toolResponse("job-start", "workspace_job_start", {
        command: `${JSON.stringify(process.execPath)} background.mjs`,
      }),
      toolResponse("job-wait", "workspace_job_wait", {
        id: "shell-1",
        timeout_sec: 5,
      }),
      toolResponse("job-read", "workspace_job_read", { id: "shell-1" }),
      {
        text: "background job completed",
        nativeAssistantContent: "background job completed",
        finishReason: "stop",
      },
    ]);

    const result = await runFreshPawNextTaskV1({
      workspaceRoot: root,
      sessionId: "session-managed-job",
      runId: "run-managed-job",
      inputId: "input-managed-job",
      goal: "run the background command and report its output",
      model,
      transport: "complete",
      permissionConfig: allowAllPermissions(),
      estimator: smallEstimator(),
      estimatorId: "test-small-estimator",
      estimatorVersion: "v1",
    });

    expect(result.state.decision).toEqual({
      kind: "completed",
      reason: "interactive-natural-stop",
    });
    expect(result.state.settledToolCalls).toBe(3);
    expect(toolPayload(requestAt(model, 1))).toMatchObject({
      jobId: "shell-1",
      status: "running",
    });
    expect(toolPayload(requestAt(model, 2))).toMatchObject({
      timedOut: false,
      snapshot: { status: "completed" },
    });
    expect(toolPayload(requestAt(model, 3))).toMatchObject({ text: "job-ok" });
  }, 15_000);

  test("runs read, edit, test and final through one canonical runtime", async () => {
    const root = workspace();
    fs.writeFileSync(path.join(root, "a.txt"), "before\n");
    const shellCommand = `${JSON.stringify(process.execPath)} -e "const fs=require('fs');const v=fs.readFileSync('a.txt','utf8');if(v!=='after\\n')process.exit(7);process.stdout.write('test-ok')"`;
    const model = new ScriptedModel([
      toolResponse("read-1", "workspace_read_file", { path: "a.txt" }),
      toolResponse("edit-1", "workspace_edit_file", {
        path: "a.txt",
        old_string: "before",
        new_string: "after",
      }),
      toolResponse("test-1", "workspace_run_shell", {
        command: shellCommand,
        timeout_sec: 10,
      }),
      {
        text: "已完成修改并验证。",
        nativeAssistantContent: "已完成修改并验证。",
        finishReason: "stop",
      },
    ]);

    const runOptions = {
      workspaceRoot: root,
      sessionId: "session-product-smoke",
      runId: "run-product-smoke",
      inputId: "input-product-smoke",
      goal: "把 a.txt 的 before 改成 after，并运行检查。",
      model,
      transport: "complete",
      permissionConfig: allowAllPermissions(),
      estimator: smallEstimator(),
      estimatorId: "test-small-estimator",
      estimatorVersion: "v1",
    } as const;
    const prepared = preparePawNextProductRuntimeV1(runOptions);
    const result = await runFreshPawNextTaskV1(runOptions);

    expect(result.state.decision).toEqual({
      kind: "completed",
      reason: "interactive-natural-stop",
    });
    expect(result.state.modelTurns).toBe(4);
    expect(result.state.settledToolCalls).toBe(3);
    expect(result.assistantText).toBe("已完成修改并验证。");
    expect(attemptConfigHash(result.inputFacts)).toBe(prepared.configHash);
    expect(
      result.inputFacts.every((fact) => {
        if (fact.type === "model.settled" && fact.response) {
          return fact.response.kind === "inline";
        }
        if (fact.type === "tool.settled" && fact.observation?.payload) {
          return fact.observation.payload.kind === "inline";
        }
        if (fact.type === "input.accepted" || fact.type === "input.promoted") {
          return (fact.attachments ?? []).every(
            (attachment) => attachment.content.kind === "inline",
          );
        }
        return true;
      }),
    ).toBeTrue();
    expect(
      fs.existsSync(
        path.join(root, ".paw", "paw-next", "durable-json-payloads"),
      ),
    ).toBeFalse();
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("after\n");
    expect(
      result.inputFacts.filter((fact) => fact.type === "tool.settled"),
    ).toHaveLength(3);
    expect(
      result.inputFacts.filter(
        (fact) => fact.type === "tool.permission_resolved",
      ),
    ).toHaveLength(3);
    expect(model.requests).toHaveLength(4);
    expect(toolPayload(requestAt(model, 1))).toMatchObject({
      content: "before\n",
    });
    expect(toolPayload(requestAt(model, 2))).toMatchObject({
      replacements: 1,
    });
    expect(toolPayload(requestAt(model, 3))).toMatchObject({
      stdout: "test-ok",
    });
  }, 15_000);

  test("refuses to disguise an existing run as fresh resume", async () => {
    const root = workspace();
    const first = new ScriptedModel([
      {
        text: "first",
        nativeAssistantContent: "first",
        finishReason: "stop",
      },
    ]);
    const common = {
      workspaceRoot: root,
      sessionId: "session-fresh-only",
      runId: "run-fresh-only",
      inputId: "input-fresh-only",
      goal: "inspect the repository",
      providerProtocol: "openai-compatible" as const,
      estimator: {
        count: (text: string) => Math.ceil(text.length / 4),
        countMessages: (messages: readonly ChatMessage[]) =>
          messages.reduce(
            (total, message) => total + Math.ceil(message.content.length / 4),
            0,
          ),
      },
      estimatorId: "test-small-estimator",
      estimatorVersion: "v1",
    };
    await runFreshPawNextTaskV1({ ...common, model: first });

    const second = new ScriptedModel([]);
    await expect(
      runFreshPawNextTaskV1({ ...common, model: second }),
    ).rejects.toThrow("only accepts a new empty run journal");
    expect(second.requests).toHaveLength(0);
  });

  test("default permissions never turn a missing approval channel into write access", async () => {
    const root = workspace();
    fs.writeFileSync(path.join(root, "guarded.txt"), "safe\n");
    const model = new ScriptedModel([
      toolResponse("edit-denied", "workspace_edit_file", {
        path: "guarded.txt",
        old_string: "safe",
        new_string: "changed",
      }),
    ]);

    const result = await runFreshPawNextTaskV1({
      workspaceRoot: root,
      sessionId: "session-default-deny",
      runId: "run-default-deny",
      inputId: "input-default-deny",
      goal: "change guarded.txt",
      model,
      estimator: smallEstimator(),
      estimatorId: "test-small-estimator",
      estimatorVersion: "v1",
    });

    expect(result.state.decision).toEqual({
      kind: "await_user",
      reason: "tool-permission-rejected",
    });
    expect(fs.readFileSync(path.join(root, "guarded.txt"), "utf8")).toBe(
      "safe\n",
    );
    expect(
      result.inputFacts.find(
        (fact) => fact.type === "tool.permission_resolved",
      ),
    ).toMatchObject({ resolution: "deny" });
  });

  test("invalid frozen config leaves the run reusable and performs no model call", async () => {
    const root = workspace();
    const invalidModel = new ScriptedModel([]);
    const common = {
      workspaceRoot: root,
      sessionId: "session-invalid-config",
      runId: "run-invalid-config",
      inputId: "input-invalid-config",
      goal: "inspect",
      estimator: smallEstimator(),
      estimatorId: "test-small-estimator",
      estimatorVersion: "v1",
    };

    await expect(
      runFreshPawNextTaskV1({
        ...common,
        model: invalidModel,
        maxModelTurns: 0,
      }),
    ).rejects.toThrow("Interactive control config is invalid");
    expect(invalidModel.requests).toHaveLength(0);

    await expect(
      runFreshPawNextTaskV1({
        ...common,
        model: invalidModel,
        contextWindowTokens: 1_000,
        reservedOutputTokens: 1_000,
      }),
    ).rejects.toThrow("Context budget configuration is invalid");
    await expect(
      runFreshPawNextTaskV1({
        ...common,
        model: invalidModel,
        permissionConfig: {
          policyVersion: "bad-policy",
          defaultAction: "allow" as never,
          rules: [],
        },
      }),
    ).rejects.toThrow("Permission defaultAction must be ask or deny");
    await expect(
      runFreshPawNextTaskV1({
        ...common,
        model: invalidModel,
        heartbeatPolicy: {
          policyVersion: "paw.session-lease-heartbeat.v1",
          ttlMs: 90,
          intervalMs: 31,
        },
      }),
    ).rejects.toThrow("at most ttlMs / 3");
    expect(invalidModel.requests).toHaveLength(0);

    const validModel = finalModel("recovered");
    const result = await runFreshPawNextTaskV1({
      ...common,
      model: validModel,
    });
    expect(result.assistantText).toBe("recovered");
  });

  test("a coordinator cleanup failure still closes the Session and releases its lease", async () => {
    const root = workspace();
    const sessionId = "session-cleanup-failure";
    const runId = "run-cleanup-failure";
    const originalClose = SessionCoordinatorV1.prototype.close;
    SessionCoordinatorV1.prototype.close = async function closeThenFail() {
      await originalClose.call(this);
      throw new Error("simulated coordinator cleanup failure");
    };
    try {
      await expect(
        runFreshPawNextTaskV1({
          workspaceRoot: root,
          sessionId,
          runId,
          inputId: "input-cleanup-failure",
          goal: "inspect",
          model: finalModel("done"),
          estimator: smallEstimator(),
          estimatorId: "test-small-estimator",
          estimatorVersion: "v1",
        }),
      ).rejects.toThrow("Paw Next task cleanup failed");
    } finally {
      SessionCoordinatorV1.prototype.close = originalClose;
    }

    const index = readFileSessionJournalCommitIndexV1({
      workspaceRoot: root,
      sessionId,
      runId,
    });
    const acquired = acquireFileSessionExecutionLeaseV1({
      workspaceRoot: root,
      sessionId,
      runId,
      ownerId: "recovery-owner",
      ttlMs: 60_000,
      baseTailSeq: index.head.tailSeq,
      basePrefixHash: index.head.prefixHash,
    });
    expect(acquired.status).toBe("acquired");
    if (acquired.status !== "acquired") return;
    const session = new FileRunSessionV1({
      workspaceRoot: root,
      sessionId,
      runId,
      executionLease: acquired.lease,
    });
    expect((await session.readInputSnapshot()).tailSeq).toBeGreaterThan(0);
    session.close();
    expect(await acquired.lease.release()).toBe("released");
  });

  test("config hash binds the real frozen product manifest", async () => {
    const hashes: string[] = [];
    const variants: ReadonlyArray<{
      readonly systemPrompt: string;
      readonly contextWindowTokens: number;
      readonly estimatorId?: string;
      readonly modelName?: string;
      readonly heartbeatPolicy?: {
        readonly policyVersion: "paw.session-lease-heartbeat.v1";
        readonly ttlMs: number;
        readonly intervalMs: number;
      };
    }> = [
      { systemPrompt: "system-a", contextWindowTokens: 8_000 },
      { systemPrompt: "system-a", contextWindowTokens: 8_000 },
      { systemPrompt: "system-b", contextWindowTokens: 8_000 },
      { systemPrompt: "system-a", contextWindowTokens: 9_000 },
      {
        systemPrompt: "system-a",
        contextWindowTokens: 8_000,
        estimatorId: "other-estimator",
      },
      {
        systemPrompt: "system-a",
        contextWindowTokens: 8_000,
        modelName: "other-model",
      },
      {
        systemPrompt: "system-a",
        contextWindowTokens: 8_000,
        heartbeatPolicy: {
          policyVersion: "paw.session-lease-heartbeat.v1",
          ttlMs: 120_000,
          intervalMs: 30_000,
        },
      },
    ];
    for (const [index, variant] of variants.entries()) {
      const result = await runFreshPawNextTaskV1({
        workspaceRoot: workspace(),
        sessionId: `session-config-${index}`,
        runId: `run-config-${index}`,
        inputId: `input-config-${index}`,
        goal: "inspect",
        model: finalModel("done", variant.modelName),
        estimator: smallEstimator(),
        estimatorId: variant.estimatorId ?? "test-small-estimator",
        estimatorVersion: "v1",
        systemPrompt: variant.systemPrompt,
        contextWindowTokens: variant.contextWindowTokens,
        reservedOutputTokens: 1_000,
        ...(variant.heartbeatPolicy
          ? { heartbeatPolicy: variant.heartbeatPolicy }
          : {}),
      });
      hashes.push(attemptConfigHash(result.inputFacts));
    }
    expect(hashes[0]).toBe(hashes[1]);
    expect(new Set(hashes).size).toBe(6);
  });

  test("checkpoint allocation and physical layout policy is part of config identity", () => {
    const input = {
      toolEffectCheckpointPolicyVersion:
        PAW_TOOL_EFFECT_CHECKPOINT_POLICY_VERSION_V1,
      reducerVersion: "test-reducer.v1",
      runConfig: { mode: "interactive" },
      model: "test-model",
      providerProtocol: "openai-compatible",
      transport: "complete",
      registryHash: "registry-hash",
      shellSandboxHash: "sandbox-hash",
      permissionPolicy: { policyVersion: "permission.v1" },
      approvalMode: "unavailable" as const,
      systemPromptHash: "system-hash",
      contextBudget: { contextWindowTokens: 8_000 },
      modelRuntimeProfile: { model: "test-model" },
      modelCapabilities: { contextWindow: 8_000 },
      sessionLeaseHeartbeat: { policyVersion: "heartbeat.v1" },
    } as const;
    const manifest = createPawNextProductManifestV1(input);
    const changed = createPawNextProductManifestV1({
      ...input,
      toolEffectCheckpointPolicyVersion: "paw.tool-effect-checkpoint.v2",
    });
    const {
      toolEffectCheckpointPolicyVersion: _legacyMissingPolicy,
      ...legacyManifest
    } = manifest;

    expect(hashPawNextProductManifestV1(manifest)).not.toBe(
      hashPawNextProductManifestV1(changed),
    );
    expect(hashCanonicalJsonV1(legacyManifest)).not.toBe(
      hashPawNextProductManifestV1(manifest),
    );
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.contextBudget)).toBe(true);
  });

  test("renews a live product run through the injected deterministic scheduler", async () => {
    const root = workspace();
    const scheduler = new ManualLeaseScheduler(1_000);
    const model = new BlockingModel();
    const running = runFreshPawNextTaskV1({
      workspaceRoot: root,
      sessionId: "session-heartbeat",
      runId: "run-heartbeat",
      inputId: "input-heartbeat",
      goal: "inspect",
      model,
      estimator: smallEstimator(),
      estimatorId: "test-small-estimator",
      estimatorVersion: "v1",
      heartbeatPolicy: {
        policyVersion: "paw.session-lease-heartbeat.v1",
        ttlMs: 90,
        intervalMs: 20,
      },
      leaseScheduler: scheduler,
    });

    await model.started.promise;
    expect(scheduler.pendingDeadlines()).toEqual([1_020]);
    scheduler.advanceTo(1_020);
    await flushMicrotasks();
    expect(scheduler.pendingDeadlines()).toEqual([1_040]);

    model.finish({
      text: "heartbeat complete",
      nativeAssistantContent: "heartbeat complete",
      finishReason: "stop",
    });
    await expect(running).resolves.toMatchObject({
      assistantText: "heartbeat complete",
    });
    expect(scheduler.pendingDeadlines()).toEqual([]);
    scheduler.advanceTo(2_000);
    await flushMicrotasks();
    expect(scheduler.pendingDeadlines()).toEqual([]);
  });

  test("whitespace-only model output never becomes a completed delivery", async () => {
    for (const naturalStop of ["complete", "await_user"] as const) {
      const result = await runFreshPawNextTaskV1({
        workspaceRoot: workspace(),
        sessionId: `session-empty-${naturalStop}`,
        runId: `run-empty-${naturalStop}`,
        inputId: `input-empty-${naturalStop}`,
        goal: "inspect",
        model: finalModel("  \n\t"),
        naturalStop,
        estimator: smallEstimator(),
        estimatorId: "test-small-estimator",
        estimatorVersion: "v1",
      });
      expect(result.state.decision).toEqual({
        kind: "incomplete",
        reason: "model-visible-output-missing",
      });
    }
  });
});

class BlockingModel implements LanguageModel {
  readonly label = "blocking-openai";
  readonly capabilities = {
    contextWindow: 32_000,
    maxOutputTokens: 2_048,
  };
  readonly runtimeProfile = {
    protocol: "openai-compatible" as const,
    model: "blocking",
    baseUrl: "https://example.invalid/v1",
  };
  readonly started = deferred<void>();
  private readonly response = deferred<ModelCompletionResult>();

  async complete(
    _messages: readonly ChatMessage[],
    _options?: ModelCompleteOptions,
  ): Promise<ModelCompletionResult> {
    this.started.resolve(undefined);
    return this.response.promise;
  }

  finish(response: ModelCompletionResult): void {
    this.response.resolve(response);
  }
}

class ScriptedModel implements LanguageModel {
  readonly label = "scripted-openai";
  readonly capabilities = {
    contextWindow: 32_000,
    maxOutputTokens: 2_048,
  };
  readonly runtimeProfile;
  readonly requests: ChatMessage[][] = [];
  readonly toolInventories: string[][] = [];
  private index = 0;

  constructor(
    private readonly responses: readonly ModelCompletionResult[],
    runtimeModel = "scripted",
  ) {
    this.runtimeProfile = {
      protocol: "openai-compatible" as const,
      model: runtimeModel,
      baseUrl: "https://example.invalid/v1",
    };
  }

  async complete(
    messages: readonly ChatMessage[],
    options?: ModelCompleteOptions,
  ): Promise<ModelCompletionResult> {
    this.requests.push(messages.map((message) => ({ ...message })));
    this.toolInventories.push(
      (options?.tools ?? []).map((tool) => tool.function.name),
    );
    const response = this.responses[this.index];
    this.index += 1;
    if (!response) throw new Error("No scripted response remains");
    return response;
  }
}

function finalModel(text: string, runtimeModel?: string): ScriptedModel {
  return new ScriptedModel(
    [{ text, nativeAssistantContent: text, finishReason: "stop" }],
    runtimeModel,
  );
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

function toolPayload(messages: readonly ChatMessage[]): unknown {
  let content: string | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    content = messages[index]?.nativeToolTurn?.results[0]?.content;
    if (content) break;
  }
  if (!content) throw new Error("expected a native tool result");
  const observation = JSON.parse(content) as { payload?: unknown };
  return observation.payload;
}

function requestAt(
  model: ScriptedModel,
  index: number,
): readonly ChatMessage[] {
  const request = model.requests[index];
  if (!request) throw new Error(`missing model request ${index}`);
  return request;
}

function attemptConfigHash(
  facts: readonly import("@paw/protocol").InputFactV1[],
): string {
  const attempt = facts.find((fact) => fact.type === "attempt.started");
  if (!attempt || attempt.type !== "attempt.started") {
    throw new Error("missing attempt.started");
  }
  return attempt.configHash;
}

class ManualLeaseScheduler implements SessionLeaseSchedulerV1 {
  private readonly tasks: Array<{
    readonly deadlineMs: number;
    readonly task: () => void;
    cancelled: boolean;
  }> = [];

  constructor(private nowMs: number) {}

  now(): number {
    return this.nowMs;
  }

  scheduleAt(
    deadlineMs: number,
    task: () => void,
  ): SessionLeaseScheduledTaskV1 {
    const entry = { deadlineMs, task, cancelled: false };
    this.tasks.push(entry);
    return Object.freeze({
      cancel: () => {
        entry.cancelled = true;
      },
    });
  }

  advanceTo(nowMs: number): void {
    if (nowMs < this.nowMs)
      throw new Error("manual clock cannot move backward");
    this.nowMs = nowMs;
    for (;;) {
      const next = this.tasks
        .filter((entry) => !entry.cancelled && entry.deadlineMs <= nowMs)
        .sort((left, right) => left.deadlineMs - right.deadlineMs)[0];
      if (!next) return;
      next.cancelled = true;
      next.task();
    }
  }

  pendingDeadlines(): number[] {
    return this.tasks
      .filter((entry) => !entry.cancelled)
      .map((entry) => entry.deadlineMs)
      .sort((left, right) => left - right);
  }
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-next-product-"));
  roots.push(root);
  return root;
}
