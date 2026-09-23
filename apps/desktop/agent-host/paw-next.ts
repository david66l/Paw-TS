import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CostTracker, FileSystemSessionStore, type RunEventEnvelope } from "@paw/core";
import { resolveScope } from "@paw/memory";
import { type MemoryKind, PostgresMemoryStoreEngine } from "@paw/memory/longterm";
import { type LanguageModel, createDefaultLanguageModel } from "@paw/models";
import {
  type ExecutionDeadlineV1,
  LONG_HORIZON_MANAGER_PROMPT,
  type PawNextPhaseEffortPolicyV1,
  type PawNextPhaseEffortTelemetryV1,
  type PawNextThinkingRecoveryPolicyV1,
  type PawNextThinkingRecoveryTelemetryV1,
  type RunFreshPawNextTaskInputV3,
  assertExecutionDeadlineV1,
  buildPawNextTaskProfileV3,
  compactExistingPawNextTaskV3,
  maintainExistingPawNextMemoryV3,
  projectEnvironmentAcceptance,
  runExistingPawNextTaskV3,
  runExistingPawNextWorkSegmentV3,
  runFreshPawNextTaskV3,
} from "@paw/paw-next";
import {
  type ApprovalPromptV1,
  type ApprovalResponseV1,
  type SessionLeaseSchedulerV1,
  createToolCheckpointNamespaceIdV1,
} from "@paw/runtime";
import { type PawSettingsLocal, defaultSettingsPath, loadPawSettingsLocal } from "@paw/settings";
import { McpClientManager, type McpServerConfig } from "@paw/tools";
import { PAW_INCREMENTAL_VERIFICATION_GUIDANCE } from "./agent-system-prompt.js";
import { type CloudRunTelemetry, desktopCloudTelemetry } from "./cloud-telemetry.js";
import type { DesktopNextControls } from "./paw-next-controls.js";
import { DesktopNextEvents } from "./paw-next-events.js";
import { desktopAgentModels } from "./paw-next-models.js";
import { desktopProfile, fingerprint } from "./paw-next-profile.js";
import { arrangeDesktopTask } from "./task-arrangement.js";

import type { InputAttachmentV1 } from "@paw/protocol";
import { enqueueDesktopMemoryJob } from "./memory-jobs.js";
import { desktopAttachments } from "./paw-next-attachments.js";

import type { DesktopMonitorSnapshot } from "../src/agent/monitorTypes.js";

interface DesktopRunRecord {
  version: 1;
  executionDeadline?: ExecutionDeadlineV1;
  incrementalVerification?: true;
  deliveryLedger?: true;
  legacyOutputRecall?: true;
  maxSteps?: number;
  mcpAllowedTools?: readonly string[];
  liveSteering?: true;
  environmentAudit?: true;
  environmentAuditRetry?: true;
  environmentAuditSinglePass?: true;
  environmentAuditEvidenceRepair?: true;
  compactMutationReceipts?: true;
  auditedMemory?: true;
  stageGraph?: true;
  browserAudit?: true;
  visualAudit?: true;
  taskMode?: "long";
  sessionId: string;
  runId: string;
  inputId: string;
  goal: string;
  configHash: string;
  status: string;
  segments: number;
  latestWork?: {
    inputId: string;
    callerId: string;
    content: string;
    attachments?: readonly InputAttachmentV1[];
  };
}
export interface DesktopNextOptions {
  /** Explicit caller/user time limit. Unspecified desktop tasks are unbounded. */
  executionDeadline?: ExecutionDeadlineV1;
  operation?: "compact" | "memory";
  memoryRunId?: string;
  expectedConfigHash?: string;
  /** Production defaults to durable background work; tests may opt in explicitly. */
  backgroundMemory?: boolean;
  memoryQueueDirectory?: string;
  taskMode?: "standard" | "long";
  visualAudit?: true;
  attachments?: unknown;
  controls?: DesktopNextControls;
  workspaceRoot: string;
  conversationId?: string;
  conversationHistory?: readonly {
    role: "user" | "assistant";
    content: string;
  }[];
  maxSteps?: number;
  intent?: "continue" | "recover" | "reset";
  abortSignal?: AbortSignal;
  resolveToolApproval: (input: ApprovalPromptV1, signal: AbortSignal) => Promise<boolean>;
  onEvent: (event: RunEventEnvelope) => void;
  /** Offline integration-test seams; the production host never supplies these. */
  model?: LanguageModel;
  collaborationModels?: Readonly<Record<string, LanguageModel>>;
  settings?: PawSettingsLocal;
  memoryEnabled?: boolean;
  environmentAudit?: boolean;
  /** New conversations only; false retains the legacy audit timeout/retry policy. */
  environmentAuditSinglePass?: boolean;
  environmentAuditEvidenceRepair?: boolean;
  /** Explicit experiment; normal desktop sessions do not retry thinking timeouts. */
  experimentalReasoningRecovery?: true;
  /**
   * Benchmark seam over the model-level thinking-only rescue (default on via
   * the V3 extensions): `false` disables it for the control arm; an explicit
   * policy retunes deadlines. The production host never sets this.
   */
  thinkingRecovery?: false | PawNextThinkingRecoveryPolicyV1;
  /** Process-local rescue telemetry; benchmark accounting only. */
  onThinkingRecoveryEvent?: (event: PawNextThinkingRecoveryTelemetryV1) => void;
  /** Benchmark seam over phase-aware reasoning effort (default off). */
  phaseEffort?: false | PawNextPhaseEffortPolicyV1;
  onPhaseEffortEvent?: (event: PawNextPhaseEffortTelemetryV1) => void;
  leaseScheduler?: SessionLeaseSchedulerV1;
  /** Offline monitoring integration tests only. */
  telemetry?: CloudRunTelemetry;
}
const busy = new Set<string>();

function stateDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".paw", "desktop-next");
}
function conversationFile(workspaceRoot: string, conversationId: string): string {
  return path.join(stateDir(workspaceRoot), `conversation-${fingerprint(conversationId)}.json`);
}
function readRecord(file: string): DesktopRunRecord | undefined {
  if (!fs.existsSync(file)) return undefined;
  const record = JSON.parse(fs.readFileSync(file, "utf8")) as DesktopRunRecord;
  if (record.version !== 1 || !/^desktop-next-[\w-]+$/.test(record.runId) || !record.sessionId) {
    throw new Error("Paw Next 桌面会话索引损坏，请新建对话。");
  }
  return record;
}
function saveRecord(file: string, record: DesktopRunRecord): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(record), {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(temporary, file);
}
function settingsFor(workspaceRoot: string): PawSettingsLocal {
  for (const root of [workspaceRoot, process.cwd()]) {
    if (fs.existsSync(defaultSettingsPath(root)))
      return loadPawSettingsLocal(defaultSettingsPath(root));
  }
  return {};
}

export async function runDesktopNext(
  goal: string,
  options: DesktopNextOptions,
): Promise<{ ok: boolean; text: string }> {
  const cloud = desktopCloudTelemetry();
  let telemetry = options.telemetry;
  try {
    telemetry ??= cloud?.start();
  } catch {
    /* Monitoring must not block a run. */
  }
  if (!telemetry) return executeDesktopNext(goal, options);
  let status = "failed";
  try {
    const result = await telemetry.run(() => executeDesktopNext(goal, options, telemetry));
    status = result.ok ? "completed" : "failed";
    try {
      status = JSON.parse(result.text).status ?? status;
    } catch {
      /* No result body is sent. */
    }
    return result;
  } finally {
    try {
      telemetry.finish(options.abortSignal?.aborted ? "cancelled" : status);
    } catch {
      /* Best effort. */
    }
    void cloud?.flush().catch(() => {});
  }
}

async function executeDesktopNext(
  goal: string,
  optionsInput: DesktopNextOptions,
  telemetry?: CloudRunTelemetry,
): Promise<{ ok: boolean; text: string }> {
  let options = optionsInput;
  const workspaceRoot = fs.realpathSync.native(path.resolve(options.workspaceRoot));
  const conversationId = options.conversationId ?? randomUUID();
  if (
    options.memoryRunId &&
    (options.operation !== "memory" || !/^desktop-next-[\w-]+$/.test(options.memoryRunId))
  )
    throw new Error("Invalid memory run locator");
  const file = options.memoryRunId
    ? path.join(stateDir(workspaceRoot), `${options.memoryRunId}.json`)
    : conversationFile(workspaceRoot, conversationId);
  if (busy.has(file)) throw new Error("此对话已有任务运行，请等待完成或停止当前任务。");
  busy.add(file);
  let projection: DesktopNextEvents | undefined;
  let record: DesktopRunRecord | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    options.abortSignal?.throwIfAborted();
    const attachments = desktopAttachments(options.attachments);
    const settings = options.settings ?? settingsFor(workspaceRoot);
    const configuredModel = options.model ?? createDefaultLanguageModel(workspaceRoot);
    const agentModels = options.model
      ? undefined
      : desktopAgentModels(workspaceRoot, configuredModel, settings);
    const model = agentModels?.model ?? configuredModel;
    const collaborationModels = options.collaborationModels ?? agentModels?.models;
    const previous = readRecord(file);
    const inheritedDeadline =
      options.intent === "recover" ? previous?.executionDeadline : undefined;
    if (
      inheritedDeadline &&
      options.executionDeadline &&
      (inheritedDeadline.deadlineAtMs !== options.executionDeadline.deadlineAtMs ||
        inheritedDeadline.reserveMs !== options.executionDeadline.reserveMs ||
        (options.executionDeadline.admissionPolicy !== undefined &&
          inheritedDeadline.admissionPolicy !== options.executionDeadline.admissionPolicy))
    )
      throw new Error("无法恢复：任务时间预算已变化，请新建任务。");
    const executionDeadline =
      inheritedDeadline ??
      (options.executionDeadline && options.intent !== "recover"
        ? {
            admissionPolicy: "recent_round_floor_v1" as const,
            ...options.executionDeadline,
          }
        : options.executionDeadline);
    if (executionDeadline && !options.operation) {
      assertExecutionDeadlineV1(executionDeadline);
      const controller = new AbortController();
      const expire = () => {
        const remaining = executionDeadline.deadlineAtMs - Date.now();
        if (remaining <= 0) controller.abort(new Error("ExecutionDeadlineExceeded"));
        else deadlineTimer = setTimeout(expire, Math.min(remaining, 2_147_483_647));
      };
      expire();
      options = {
        ...options,
        executionDeadline,
        abortSignal: options.abortSignal
          ? AbortSignal.any([options.abortSignal, controller.signal])
          : controller.signal,
      };
      options.abortSignal!.throwIfAborted();
    }
    let legacyOutputRecall = previous?.legacyOutputRecall;
    if (options.expectedConfigHash && previous?.configHash !== options.expectedConfigHash)
      throw new Error("Memory job configuration changed");
    let arrangement = {
      taskMode: "standard" as "standard" | "long",
      visualAudit: false,
    };
    if (options.intent !== "recover" && !options.taskMode && !options.model) {
      try {
        arrangement = await arrangeDesktopTask(model, goal, options.abortSignal);
      } catch {
        options.abortSignal?.throwIfAborted(); /* Ordinary execution remains available if routing fails. */
      }
    }
    const taskMode =
      options.intent === "recover"
        ? previous?.taskMode
        : (options.taskMode ?? arrangement.taskMode);
    const visualAudit =
      options.intent === "recover"
        ? previous?.visualAudit
        : (options.visualAudit ??
          (arrangement.visualAudit && model.capabilities?.imageInput ? true : undefined));
    if (visualAudit && options.environmentAudit === false)
      throw new Error("视觉验收需要启用环境审计。");
    let profile = desktopProfile(
      workspaceRoot,
      model,
      settings,
      options.maxSteps ??
        (options.intent === "recover" ? previous?.maxSteps : undefined) ??
        settings.max_steps,
      options.memoryEnabled,
    );
    if (options.experimentalReasoningRecovery)
      profile = {
        ...profile,
        control: { ...profile.control, recoverReasoningTimeout: true },
      };
    if (taskMode === "long")
      profile = {
        ...profile,
        longHorizon: "manager",
        systemPrompt: `${profile.systemPrompt}\n\n${LONG_HORIZON_MANAGER_PROMPT}`,
      };
    if (visualAudit)
      profile = {
        ...profile,
        systemPrompt: `${profile.systemPrompt}\nVisual acceptance is enabled. Make the relevant local web app available at an explicit loopback HTTP port before finishing and include that URL in your result. Independent auditors will check behavior and current screenshot pixels. Missing images or required reference comparisons remain unverified.`,
      };
    if (agentModels?.rootPrompt)
      profile = {
        ...profile,
        systemPrompt: `${profile.systemPrompt}\n\nConfigured root agent:\n${agentModels.rootPrompt}`,
      };
    if (taskMode !== "long" && Array.isArray(settings.mcp_servers) && settings.mcp_servers.length) {
      const servers = settings.mcp_servers as McpServerConfig[];
      if (options.operation === "memory") {
        if (!previous?.mcpAllowedTools)
          throw new Error("Memory maintenance requires the original MCP catalog");
        profile = {
          ...profile,
          mcp: {
            policyVersion: "paw.mcp-runtime.v1",
            servers,
            allowedTools: previous.mcpAllowedTools,
          },
        };
      } else {
        const manager = new McpClientManager();
        try {
          for (const server of servers) {
            options.abortSignal?.throwIfAborted();
            await manager.connect(server);
          }
          profile = {
            ...profile,
            mcp: {
              policyVersion: "paw.mcp-runtime.v1",
              servers,
              allowedTools: manager
                .listTools()
                .map((tool) => `mcp:${tool.serverName}/${tool.toolName}`),
            },
          };
        } finally {
          await manager.disconnectAll();
        }
      }
    }
    // Only an opaque binding goes through profile construction. The configured
    // LanguageModel owns credentials; neither profiles nor journals store them.
    const credentialBinding = fingerprint(settings);
    const requestApproval = async (
      prompt: ApprovalPromptV1,
      signal: AbortSignal,
    ): Promise<ApprovalResponseV1> => {
      if (signal.aborted || options.abortSignal?.aborted)
        return { decision: "deny", reason: "cancelled" };
      let cancel: (() => void) | undefined;
      try {
        const approved = await Promise.race([
          options.resolveToolApproval(prompt, signal),
          new Promise<boolean>((resolve) => {
            cancel = () => resolve(false);
            signal.addEventListener("abort", cancel, { once: true });
            if (signal.aborted) cancel();
          }),
        ]);
        return approved && !signal.aborted && !options.abortSignal?.aborted
          ? { decision: "allow_once" }
          : { decision: "deny", reason: "desktop-user-denied" };
      } finally {
        if (cancel) signal.removeEventListener("abort", cancel);
      }
    };
    const build = (
      identity: Pick<
        DesktopRunRecord,
        | "sessionId"
        | "runId"
        | "inputId"
        | "goal"
        | "incrementalVerification"
        | "deliveryLedger"
        | "environmentAuditSinglePass"
        | "environmentAuditEvidenceRepair"
      >,
      legacyRecovery = false,
      legacyAudit = false,
      legacyMemoryAdmission = false,
      legacyStageGraph = false,
      legacyBrowserAudit = false,
      legacyAuditRetry = false,
      legacyMutationReceipts = false,
    ) => {
      const { liveSteering: _steering, ...legacyControl } = profile.control;
      void _steering;
      const { environmentAudit: _audit, ...profileWithoutAudit } = profile;
      void _audit;
      const selectedProfile =
        legacyAudit || options.environmentAudit === false ? profileWithoutAudit : profile;
      const retryProfile =
        !legacyAuditRetry && !legacyAudit && options.environmentAudit !== false
          ? { ...selectedProfile, environmentAuditRetry: true as const }
          : selectedProfile;
      const memoryProfile =
        !legacyMemoryAdmission && !legacyAudit && options.environmentAudit !== false
          ? { ...retryProfile, auditedMemory: true as const }
          : retryProfile;
      const graphProfile =
        taskMode === "long" && !legacyStageGraph
          ? { ...memoryProfile, stageGraph: true as const }
          : memoryProfile;
      const browserProfile =
        !legacyBrowserAudit && options.environmentAudit !== false && !legacyAudit
          ? { ...graphProfile, browserAudit: true as const }
          : graphProfile;
      const visualProfile =
        visualAudit && !legacyBrowserAudit
          ? { ...browserProfile, visualAudit: true as const }
          : browserProfile;
      const activeProfile = legacyRecovery
        ? { ...visualProfile, control: legacyControl }
        : visualProfile;
      const receiptProfile =
        !legacyMutationReceipts && !legacyOutputRecall
          ? { ...activeProfile, compactMutationReceipts: true as const }
          : activeProfile;
      const selectedCompatibleProfile = legacyOutputRecall
        ? { ...receiptProfile, legacyOutputRecall: true as const }
        : receiptProfile;
      const verificationProfile = identity.incrementalVerification
        ? {
            ...selectedCompatibleProfile,
            systemPrompt: `${selectedCompatibleProfile.systemPrompt}\n\n${PAW_INCREMENTAL_VERIFICATION_GUIDANCE}`,
          }
        : selectedCompatibleProfile;
      const deliveryProfile =
        identity.deliveryLedger && taskMode !== "long"
          ? { ...verificationProfile, deliveryLedger: true as const }
          : verificationProfile;
      const singlePassProfile =
        identity.environmentAuditSinglePass && !legacyAudit && options.environmentAudit !== false
          ? { ...deliveryProfile, environmentAuditSinglePass: true as const }
          : deliveryProfile;
      const compatibleProfile =
        identity.environmentAuditEvidenceRepair && "environmentAuditSinglePass" in singlePassProfile
          ? {
              ...singlePassProfile,
              environmentAuditEvidenceRepair: true as const,
            }
          : singlePassProfile;
      const first = buildPawNextTaskProfileV3({
        identity: { workspaceRoot, ...identity },
        profile: compatibleProfile,
        apiKey: credentialBinding,
        model,
        collaborationModels,
        requestApproval,
      });
      return buildPawNextTaskProfileV3({
        identity: { workspaceRoot, ...identity },
        profile: { ...compatibleProfile, configHash: first.configHash },
        apiKey: credentialBinding,
        model,
        collaborationModels,
        requestApproval,
      });
    };
    const resetHistory = options.intent === "reset";
    const recovering = options.intent === "recover";
    let resolution = previous
      ? build(
          previous,
          recovering && previous.liveSteering !== true,
          recovering && previous.environmentAudit !== true,
          recovering && previous.auditedMemory !== true,
          recovering && previous.stageGraph !== true,
          recovering && previous.browserAudit !== true,
          previous.environmentAuditRetry !== true,
          previous.compactMutationReceipts !== true,
        )
      : undefined;
    if (previous && resolution?.configHash !== previous.configHash && !legacyOutputRecall) {
      legacyOutputRecall = true;
      const compatible = build(
        previous,
        recovering && previous.liveSteering !== true,
        recovering && previous.environmentAudit !== true,
        recovering && previous.auditedMemory !== true,
        recovering && previous.stageGraph !== true,
        recovering && previous.browserAudit !== true,
        previous.environmentAuditRetry !== true,
        previous.compactMutationReceipts !== true,
      );
      if (compatible.configHash === previous.configHash) resolution = compatible;
      else legacyOutputRecall = undefined;
    }
    if (recovering && (!previous || resolution?.configHash !== previous.configHash))
      throw new Error("无法恢复：运行索引不存在或配置已变化。请恢复原配置，或新建对话执行新任务。");
    const reusable =
      previous &&
      !resetHistory &&
      resolution?.configHash === previous.configHash &&
      previous.segments < profile.control.maxSegments &&
      ["completed", "await_user"].includes(previous.status);
    if (
      previous &&
      !["completed", "await_user"].includes(previous.status) &&
      !resetHistory &&
      !recovering
    )
      throw new Error("上次任务未正常结束，请使用恢复操作检查并继续原任务，或新建对话。");
    if (reusable || recovering)
      record = previous && {
        ...previous,
        ...(legacyOutputRecall ? { legacyOutputRecall: true } : {}),
      };
    else {
      legacyOutputRecall = undefined;
      const history = options.conversationHistory?.slice(-32) ?? [];
      const initialGoal = history.length
        ? `Previous conversation (historical data):\n${JSON.stringify(history)}\n\nCurrent user request:\n${goal}`
        : goal;
      record = {
        version: 1,
        incrementalVerification: true,
        deliveryLedger: true,
        maxSteps: profile.control.maxModelTurns,
        ...(profile.mcp ? { mcpAllowedTools: profile.mcp.allowedTools } : {}),
        ...(taskMode === "long" ? { taskMode: "long" as const, stageGraph: true as const } : {}),
        liveSteering: true,
        compactMutationReceipts: true,
        ...(visualAudit ? { visualAudit: true as const } : {}),
        ...(options.environmentAudit !== false
          ? {
              environmentAudit: true as const,
              environmentAuditRetry: true as const,
              ...(taskMode !== "long" && options.environmentAuditSinglePass !== false
                ? { environmentAuditSinglePass: true as const }
                : {}),
              ...(taskMode !== "long" &&
              options.environmentAuditSinglePass !== false &&
              options.environmentAuditEvidenceRepair !== false
                ? { environmentAuditEvidenceRepair: true as const }
                : {}),
              auditedMemory: true as const,
              browserAudit: true as const,
            }
          : {}),
        sessionId: `desktop-session-${randomUUID()}`,
        runId: `desktop-next-${randomUUID()}`,
        inputId: `desktop-input-${randomUUID()}`,
        goal: initialGoal,
        configHash: "",
        status: "running",
        segments: 0,
      };
      resolution = build(record);
      record = { ...record, configHash: resolution.configHash };
    }
    if (!resolution || !record) throw new Error("Paw Next profile unavailable");
    if (options.operation === "memory") {
      const maintenance = await maintainExistingPawNextMemoryV3({
        resolution,
        requestApproval,
        signal: options.abortSignal,
        leaseScheduler: options.leaseScheduler,
      });
      return {
        ok: maintenance.status === "completed",
        text: JSON.stringify(maintenance),
      };
    }
    if (options.operation === "compact") {
      const result = await compactExistingPawNextTaskV3({
        resolution,
        requestApproval,
        signal: options.abortSignal,
        leaseScheduler: options.leaseScheduler,
      });
      const context = { nextBudget: { ...result.tokens, level: result.level } };
      saveContext(file, context);
      return {
        ok: result.ok,
        text: JSON.stringify({
          ok: result.ok,
          message: result.message,
          context,
        }),
      };
    }
    const store = new FileSystemSessionStore({ workspaceRoot });
    const seq = store.loadRun(record.runId)?.at(-1)?.seq ?? 0;
    const monitorFile = path.join(stateDir(workspaceRoot), `${record.runId}.monitor.json`);
    const initialMonitor = readMonitorFile(monitorFile);
    projection = new DesktopNextEvents(
      record.runId,
      (event) => {
        const ev = event.event as unknown as {
          type: string;
          snapshot?: DesktopMonitorSnapshot;
        };
        // Streaming deltas are transient; monitor snapshots replace their own file.
        // Do not append every log poll to chat history.
        if (
          ev.type !== "model.chunk" &&
          ev.type !== "model.thinking" &&
          ev.type !== "monitor.snapshot"
        )
          store.saveEvent(event.runId, event);
        if (ev.type === "monitor.snapshot" && ev.snapshot) {
          const tmp = `${monitorFile}.tmp`;
          fs.writeFileSync(tmp, JSON.stringify(ev.snapshot));
          fs.renameSync(tmp, monitorFile);
        }
        options.onEvent(event);
      },
      seq,
      workspaceRoot,
      initialMonitor,
    );
    record = {
      ...record,
      executionDeadline: options.executionDeadline,
      status: "running",
      segments: record.segments + (recovering ? 0 : 1),
      ...(reusable && !recovering
        ? {
            latestWork: {
              inputId: `desktop-input-${randomUUID()}`,
              callerId: "desktop-user",
              content: goal,
              ...(attachments ? { attachments } : {}),
            },
          }
        : {}),
    };
    saveRecord(file, record);
    saveRecord(path.join(stateDir(workspaceRoot), `${record.runId}.json`), record);
    projection.emit({ type: "run.started", goal });
    if (options.controls)
      options.controls.onJobSnapshot = projection.monitor.job.bind(projection.monitor);
    const costTracker = new CostTracker();
    let rootTurns = 0;
    const input: RunFreshPawNextTaskInputV3 = {
      ...(options.executionDeadline ? { executionDeadline: options.executionDeadline } : {}),
      ...((options.backgroundMemory ?? !options.model) &&
      resolution.taskOptions.memory?.mode === "read_write"
        ? {
            deferMemory: async (sourceThroughSeq: number) => {
              enqueueDesktopMemoryJob(
                options.memoryQueueDirectory ??
                  path.join(process.cwd(), ".paw", "desktop-memory-ingress"),
                {
                  workspaceRoot,
                  runId: record!.runId,
                  configHash: resolution!.configHash,
                  sourceThroughSeq,
                },
              );
            },
          }
        : {}),
      leaseScheduler: options.leaseScheduler,
      ...(options.thinkingRecovery !== undefined
        ? { thinkingRecovery: options.thinkingRecovery }
        : {}),
      ...(options.onThinkingRecoveryEvent
        ? { onThinkingRecoveryEvent: options.onThinkingRecoveryEvent }
        : {}),
      ...(options.phaseEffort !== undefined ? { phaseEffort: options.phaseEffort } : {}),
      ...(options.onPhaseEffortEvent ? { onPhaseEffortEvent: options.onPhaseEffortEvent } : {}),
      resolution,
      initialAttachments: attachments,
      requestApproval,
      costTracker,
      ...(options.abortSignal ? { signal: options.abortSignal } : {}),
      onJournalCommit(events) {
        telemetry?.committed(events);
        projection?.committed(events);
      },
      onChildResult: projection.monitor.result.bind(projection.monitor),
      onStageGraph: projection.monitor.stageGraph.bind(projection.monitor),
      onManagedJobsReady: (runId, jobs) => options.controls?.managedJobs(runId, jobs),
      onManagedJobUpdate: projection.monitor.job.bind(projection.monitor),
      onLiveInputReady(inbox) {
        if (resolution?.taskOptions.liveSteering) options.controls?.ready(inbox);
      },
      onChildControl(child) {
        options.controls?.child(child);
        projection?.childControl(child);
      },
      onContextBudget(event) {
        if (event.runId === record?.runId) {
          saveContext(file, {
            nextBudget: { ...event.tokens, level: event.level },
          });
          projection?.emit({
            type: "context.next_budget",
            ...event.tokens,
            level: event.level,
          });
        }
      },
      onModelStreamEvent: projection.stream.bind(projection),
      onMemoryWriterEvent(event) {
        projection?.memoryMaintenance("write", event);
      },
      onMemoryTopicOrganizerEvent(event) {
        projection?.memoryMaintenance("topic", event);
      },
      onModelSettlement(event) {
        if (!event.usage) return;
        projection?.emit({ type: "cost.update", ...costTracker.snapshot() });
        if (event.runId === record?.runId && event.phase === "agent_loop") {
          projection?.emit({
            type: "loop.tick",
            turn: ++rootTurns,
            maxSteps: profile.control.maxModelTurns,
            estimatedTokens: event.usage.promptTokens ?? 0,
          });
        }
      },
    };
    const result = recovering
      ? record.latestWork
        ? await runExistingPawNextWorkSegmentV3({
            ...input,
            work: record.latestWork,
          })
        : await runExistingPawNextTaskV3(input)
      : reusable
        ? await runExistingPawNextWorkSegmentV3({
            ...input,
            work: record.latestWork!,
          })
        : await runFreshPawNextTaskV3(input);
    const decision = result.state.decision;
    await projection.flush();
    projection.monitor.finish();
    const acceptance = resolution.taskOptions.environmentAudit
      ? projectEnvironmentAcceptance(result.inputFacts)
      : "not_required";
    const status = decision.kind;
    const admissionStopped =
      status === "failed" &&
      result.inputFacts.some(
        (fact) =>
          fact.type === "runtime.failed" &&
          fact.area === "input" &&
          fact.message.startsWith("ExecutionBudgetInsufficientForRequest:"),
      );
    const answer = result.assistantText?.trim();
    const auditTimedOut =
      acceptance === "unverified" &&
      [...result.inputFacts].reverse().find((fact) => fact.type === "completion.review_settled")
        ?.reasonCode === "AuditTimeout";
    const message = admissionStopped
      ? "根据本任务近期耗时，剩余时间不足以继续一次请求，已停止执行并保留已有结果。任务尚未完成。"
      : acceptance === "unverified" && status === "completed"
        ? auditTimedOut
          ? "已有产物和验证记录已保留，但独立验收达到时限，任务尚未通过最终验收。请查看任务面板中的验收结果。"
          : "已有产物和验证记录已保留，但独立验收尚未通过，任务不能标记为完成。请查看任务面板中的验收结果。"
        : status === "completed" || status === "await_user"
          ? answer || ("reason" in decision ? decision.reason : "")
          : status === "aborted"
            ? "Run aborted."
            : [answer, "reason" in decision ? `任务未完成：${decision.reason}` : "任务尚未完成"]
                .filter(Boolean)
                .join("\n\n");
    record = { ...record, status };
    saveRecord(file, record);
    saveRecord(path.join(stateDir(workspaceRoot), `${record.runId}.json`), record);
    const uiStatus =
      admissionStopped ||
      status === "continue" ||
      (status === "completed" && acceptance === "unverified")
        ? "incomplete"
        : status;
    projection.emit({ type: "model.done", text: message });
    projection.emit({ type: "run.completed", status: uiStatus, message });
    return {
      ok: uiStatus === "completed" || uiStatus === "await_user" || uiStatus === "await_external",
      text: JSON.stringify({
        runId: record.runId,
        status: uiStatus,
        message,
        acceptance,
      }),
    };
  } catch (error) {
    const status = options.abortSignal?.aborted ? "aborted" : "failed";
    const message =
      status === "aborted"
        ? "Run aborted."
        : error instanceof Error
          ? error.message
          : String(error);
    if (record && projection) {
      await projection.flush();
      projection.monitor.finish();
      // An unexpected failure may leave unknown effects. Keep it non-resumable.
      saveRecord(file, { ...record, status });
      saveRecord(path.join(stateDir(workspaceRoot), `${record.runId}.json`), {
        ...record,
        status,
      });
      projection.emit({ type: "run.completed", status, message });
      return {
        ok: false,
        text: JSON.stringify({ runId: record.runId, status, message }),
      };
    }
    throw error;
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    options.controls?.close();
    busy.delete(file);
  }
}

function saveContext(file: string, context: unknown) {
  const target = path.join(
    path.dirname(path.dirname(file)),
    "desktop-context",
    path.basename(file),
  );
  const temporary = `${target}.${randomUUID()}.tmp`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(temporary, JSON.stringify(context), { mode: 0o600 });
  fs.renameSync(temporary, target);
}

export function readDesktopContext(workspaceRoot: string, conversationId: string) {
  const file = conversationFile(
    fs.realpathSync.native(path.resolve(workspaceRoot)),
    conversationId,
  );
  try {
    return JSON.parse(
      fs.readFileSync(
        path.join(path.dirname(path.dirname(file)), "desktop-context", path.basename(file)),
        "utf8",
      ),
    );
  } catch {
    return null;
  }
}

export async function compactDesktopContext(workspaceRoot: string, conversationId: string) {
  if (!conversationId?.trim()) throw new Error("缺少会话编号。");
  const result = await runDesktopNext("", {
    workspaceRoot,
    conversationId,
    intent: "recover",
    operation: "compact",
    abortSignal: AbortSignal.timeout(240_000),
    resolveToolApproval: async () => false,
    onEvent: () => {},
  });
  return JSON.parse(result.text) as {
    ok: boolean;
    message: string;
    context?: unknown;
  };
}

function readMonitorFile(file: string): DesktopMonitorSnapshot | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value?.version === 1 && Array.isArray(value.tasks) && Array.isArray(value.jobs)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}
export function readDesktopMonitor(
  workspaceRoot: string,
  conversationId: string,
): DesktopMonitorSnapshot | undefined {
  const file = conversationFile(
    fs.realpathSync.native(path.resolve(workspaceRoot)),
    conversationId,
  );
  const record = readRecord(file);
  if (!record) return undefined;
  const snapshot = readMonitorFile(
    path.join(stateDir(workspaceRoot), `${record.runId}.monitor.json`),
  );
  if (snapshot && !busy.has(file)) {
    if (snapshot.audit && ["checking", "repairing"].includes(snapshot.audit.status))
      snapshot.audit = {
        ...snapshot.audit,
        status: "unverified",
        summary: "宿主已断开，审计尚未完成。",
      };
    snapshot.jobs = snapshot.jobs.map((job) =>
      ["running", "stopping"].includes(job.status)
        ? {
            ...job,
            status: "interrupted_orphaned",
            detail: "宿主已断开；不会重新连接旧进程。",
          }
        : job,
    );
    snapshot.tasks = snapshot.tasks.map((task) =>
      ["running", "waiting"].includes(task.status) ? { ...task, status: "interrupted" } : task,
    );
  }
  return snapshot;
}

export function desktopCheckpointNamespace(workspaceRoot: string, runId: string): string {
  if (!runId.startsWith("desktop-next-")) return runId; // Read/undo historical checkpoints.
  if (!/^desktop-next-[\w-]+$/.test(runId)) throw new Error("Invalid Paw Next run ID");
  const record = readRecord(path.join(stateDir(workspaceRoot), `${runId}.json`));
  if (!record) throw new Error("Paw Next run index missing");
  return createToolCheckpointNamespaceIdV1({
    workspaceRoot,
    sessionId: record.sessionId,
    runId,
  });
}

export function finalizeDesktopNext(
  workspaceRoot: string,
  conversationId: string,
): { completed: boolean; taskId?: string } {
  const record = readRecord(conversationFile(workspaceRoot, conversationId));
  // V3 settles memory at each work-segment boundary; no legacy deferred TaskSession.
  return {
    completed: record?.status === "completed",
    ...(record ? { taskId: record.runId } : {}),
  };
}

export async function listDesktopNextMemories(options: {
  workspaceRoot: string;
  limit?: number;
  type?: string;
}) {
  const scope = resolveScope({ workspaceRoot: options.workspaceRoot });
  const engine = new PostgresMemoryStoreEngine(scope);
  const kinds = ["semantic", "episodic", "profile", "vault_ref"];
  const kind =
    options.type && kinds.includes(options.type) ? (options.type as MemoryKind) : undefined;
  const entries = await engine.query({
    repo: scope.repositoryId,
    limit: options.limit ?? 40,
    ...(kind ? { kind } : {}),
  });
  return {
    ok: true,
    items: entries.map((entry) => {
      const summary =
        entry.kind === "semantic"
          ? entry.fact
          : entry.kind === "profile"
            ? entry.insight
            : entry.kind === "episodic"
              ? [entry.whenToUse, entry.perspective, ...entry.modification].join("\n")
              : entry.refDescription;
      return {
        id: entry.id,
        title: summary.split("\n")[0]?.slice(0, 100) ?? entry.id,
        summary,
        type: entry.kind,
        status: entry.tInvalid ? "invalidated" : "active",
        confidence: entry.confidence,
        updatedAt: entry.created,
      };
    }),
  };
}
