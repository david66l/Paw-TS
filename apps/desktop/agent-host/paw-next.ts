import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  type RunFreshPawNextTaskInputV3,
  buildPawNextTaskProfileV3,
  projectEnvironmentAcceptance,
  runExistingPawNextTaskV3,
  runExistingPawNextWorkSegmentV3,
  runFreshPawNextTaskV3,
} from "@paw/cli/paw-next";
import {
  CostTracker,
  FileSystemSessionStore,
  type RunEventEnvelope,
} from "@paw/core";
import { McpClientManager, type McpServerConfig } from "@paw/harness";
import { resolveScope } from "@paw/memory";
import {
  type MemoryKind,
  PostgresMemoryStoreEngine,
} from "@paw/memory/longterm";
import { type LanguageModel, createDefaultLanguageModel } from "@paw/models";
import {
  type ApprovalPromptV1,
  type ApprovalResponseV1,
  type SessionLeaseSchedulerV1,
  createToolCheckpointNamespaceIdV1,
} from "@paw/runtime";
import {
  type PawSettingsLocal,
  defaultSettingsPath,
  loadPawSettingsLocal,
} from "@paw/settings";
import { LONG_HORIZON_MANAGER_PROMPT } from "../../cli/src/paw-next/long-horizon.js";
import type { DesktopNextControls } from "./paw-next-controls.js";
import { DesktopNextEvents } from "./paw-next-events.js";
import { desktopAgentModels } from "./paw-next-models.js";
import { desktopProfile, fingerprint } from "./paw-next-profile.js";

import type { InputAttachmentV1 } from "@paw/protocol";
import { desktopAttachments } from "./paw-next-attachments.js";

import type { DesktopMonitorSnapshot } from "../src/agent/monitorTypes.js";

interface DesktopRunRecord {
  version: 1;
  liveSteering?: true;
  environmentAudit?: true;
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
  resolveToolApproval: (
    input: ApprovalPromptV1,
    signal: AbortSignal,
  ) => Promise<boolean>;
  onEvent: (event: RunEventEnvelope) => void;
  /** Offline integration-test seams; the production host never supplies these. */
  model?: LanguageModel;
  collaborationModels?: Readonly<Record<string, LanguageModel>>;
  settings?: PawSettingsLocal;
  memoryEnabled?: boolean;
  environmentAudit?: boolean;
  leaseScheduler?: SessionLeaseSchedulerV1;
}
const busy = new Set<string>();

function stateDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".paw", "desktop-next");
}
function conversationFile(
  workspaceRoot: string,
  conversationId: string,
): string {
  return path.join(
    stateDir(workspaceRoot),
    `conversation-${fingerprint(conversationId)}.json`,
  );
}
function readRecord(file: string): DesktopRunRecord | undefined {
  if (!fs.existsSync(file)) return undefined;
  const record = JSON.parse(fs.readFileSync(file, "utf8")) as DesktopRunRecord;
  if (
    record.version !== 1 ||
    !/^desktop-next-[\w-]+$/.test(record.runId) ||
    !record.sessionId
  ) {
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
  const workspaceRoot = fs.realpathSync.native(
    path.resolve(options.workspaceRoot),
  );
  const conversationId = options.conversationId ?? randomUUID();
  const file = conversationFile(workspaceRoot, conversationId);
  if (busy.has(file))
    throw new Error("此对话已有任务运行，请等待完成或停止当前任务。");
  busy.add(file);
  let projection: DesktopNextEvents | undefined;
  let record: DesktopRunRecord | undefined;
  try {
    options.abortSignal?.throwIfAborted();
    const attachments = desktopAttachments(options.attachments);
    const settings = options.settings ?? settingsFor(workspaceRoot);
    const configuredModel =
      options.model ?? createDefaultLanguageModel(workspaceRoot);
    const agentModels = options.model
      ? undefined
      : desktopAgentModels(workspaceRoot, configuredModel, settings);
    const model = agentModels?.model ?? configuredModel;
    const collaborationModels =
      options.collaborationModels ?? agentModels?.models;
    const previous = readRecord(file);
    const taskMode =
      options.intent === "recover" ? previous?.taskMode : options.taskMode;
    const visualAudit =
      options.intent === "recover"
        ? previous?.visualAudit
        : options.visualAudit;
    if (visualAudit && options.environmentAudit === false)
      throw new Error("视觉验收需要启用环境审计。");
    let profile = desktopProfile(
      workspaceRoot,
      model,
      settings,
      options.maxSteps ?? settings.max_steps,
      options.memoryEnabled,
    );
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
    if (
      taskMode !== "long" &&
      Array.isArray(settings.mcp_servers) &&
      settings.mcp_servers.length
    ) {
      const servers = settings.mcp_servers as McpServerConfig[];
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
        "sessionId" | "runId" | "inputId" | "goal"
      >,
      legacyRecovery = false,
      legacyAudit = false,
      legacyMemoryAdmission = false,
      legacyStageGraph = false,
      legacyBrowserAudit = false,
    ) => {
      const { liveSteering: _steering, ...legacyControl } = profile.control;
      void _steering;
      const { environmentAudit: _audit, ...profileWithoutAudit } = profile;
      void _audit;
      const selectedProfile =
        legacyAudit || options.environmentAudit === false
          ? profileWithoutAudit
          : profile;
      const memoryProfile =
        !legacyMemoryAdmission &&
        !legacyAudit &&
        options.environmentAudit !== false
          ? { ...selectedProfile, auditedMemory: true as const }
          : selectedProfile;
      const graphProfile =
        taskMode === "long" && !legacyStageGraph
          ? { ...memoryProfile, stageGraph: true as const }
          : memoryProfile;
      const browserProfile =
        !legacyBrowserAudit &&
        options.environmentAudit !== false &&
        !legacyAudit
          ? { ...graphProfile, browserAudit: true as const }
          : graphProfile;
      const visualProfile =
        visualAudit && !legacyBrowserAudit
          ? { ...browserProfile, visualAudit: true as const }
          : browserProfile;
      const activeProfile = legacyRecovery
        ? { ...visualProfile, control: legacyControl }
        : visualProfile;
      const first = buildPawNextTaskProfileV3({
        identity: { workspaceRoot, ...identity },
        profile: activeProfile,
        apiKey: credentialBinding,
        model,
        collaborationModels,
        requestApproval,
      });
      return buildPawNextTaskProfileV3({
        identity: { workspaceRoot, ...identity },
        profile: { ...activeProfile, configHash: first.configHash },
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
        )
      : undefined;
    if (
      recovering &&
      (!previous || resolution?.configHash !== previous.configHash)
    )
      throw new Error(
        "无法恢复：运行索引不存在或配置已变化。请恢复原配置，或新建对话执行新任务。",
      );
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
      throw new Error(
        "上次任务未正常结束，请使用恢复操作检查并继续原任务，或新建对话。",
      );
    if (reusable || recovering) record = previous;
    else {
      const history = options.conversationHistory?.slice(-32) ?? [];
      const initialGoal = history.length
        ? `Previous conversation (historical data):\n${JSON.stringify(history)}\n\nCurrent user request:\n${goal}`
        : goal;
      record = {
        version: 1,
        ...(taskMode === "long"
          ? { taskMode: "long" as const, stageGraph: true as const }
          : {}),
        liveSteering: true,
        ...(visualAudit ? { visualAudit: true as const } : {}),
        ...(options.environmentAudit !== false
          ? {
              environmentAudit: true as const,
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
    const store = new FileSystemSessionStore({ workspaceRoot });
    const seq = store.loadRun(record.runId)?.at(-1)?.seq ?? 0;
    const monitorFile = path.join(
      stateDir(workspaceRoot),
      `${record.runId}.monitor.json`,
    );
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
    saveRecord(
      path.join(stateDir(workspaceRoot), `${record.runId}.json`),
      record,
    );
    projection.emit({ type: "run.started", goal });
    if (options.controls)
      options.controls.onJobSnapshot = projection.monitor.job.bind(
        projection.monitor,
      );
    const costTracker = new CostTracker();
    let rootTurns = 0;
    const input: RunFreshPawNextTaskInputV3 = {
      leaseScheduler: options.leaseScheduler,
      resolution,
      initialAttachments: attachments,
      requestApproval,
      costTracker,
      ...(options.abortSignal ? { signal: options.abortSignal } : {}),
      onJournalCommit: projection.committed.bind(projection),
      onChildResult: projection.monitor.result.bind(projection.monitor),
      onStageGraph: projection.monitor.stageGraph.bind(projection.monitor),
      onManagedJobsReady: (runId, jobs) =>
        options.controls?.managedJobs(runId, jobs),
      onManagedJobUpdate: projection.monitor.job.bind(projection.monitor),
      onLiveInputReady(inbox) {
        if (resolution?.taskOptions.liveSteering)
          options.controls?.ready(inbox);
      },
      onChildControl(child) {
        options.controls?.child(child);
        projection?.childControl(child);
      },
      onContextBudget(event) {
        if (event.runId === record?.runId)
          projection?.emit({
            type: "context.next_budget",
            ...event.tokens,
            level: event.level,
          });
      },
      onModelStreamEvent: projection.stream.bind(projection),
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
    const answer = result.assistantText?.trim();
    const message =
      acceptance === "unverified" && status === "completed"
        ? [
            answer,
            "执行已结束，但独立环境审计尚未通过；请查看任务面板中的验收结果。",
          ]
            .filter(Boolean)
            .join("\n\n")
        : status === "completed" || status === "await_user"
          ? answer || ("reason" in decision ? decision.reason : "")
          : status === "aborted"
            ? "Run aborted."
            : [
                answer,
                "reason" in decision
                  ? `任务未完成：${decision.reason}`
                  : "任务尚未完成",
              ]
                .filter(Boolean)
                .join("\n\n");
    record = { ...record, status };
    saveRecord(file, record);
    saveRecord(
      path.join(stateDir(workspaceRoot), `${record.runId}.json`),
      record,
    );
    const uiStatus =
      status === "continue" ||
      (status === "completed" && acceptance === "unverified")
        ? "incomplete"
        : status;
    projection.emit({ type: "model.done", text: message });
    projection.emit({ type: "run.completed", status: uiStatus, message });
    return {
      ok:
        uiStatus === "completed" ||
        uiStatus === "await_user" ||
        uiStatus === "await_external",
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
    options.controls?.close();
    busy.delete(file);
  }
}

function readMonitorFile(file: string): DesktopMonitorSnapshot | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value?.version === 1 &&
      Array.isArray(value.tasks) &&
      Array.isArray(value.jobs)
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
    if (
      snapshot.audit &&
      ["checking", "repairing"].includes(snapshot.audit.status)
    )
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
      ["running", "waiting"].includes(task.status)
        ? { ...task, status: "interrupted" }
        : task,
    );
  }
  return snapshot;
}

export function desktopCheckpointNamespace(
  workspaceRoot: string,
  runId: string,
): string {
  if (!runId.startsWith("desktop-next-")) return runId; // Read/undo historical checkpoints.
  if (!/^desktop-next-[\w-]+$/.test(runId))
    throw new Error("Invalid Paw Next run ID");
  const record = readRecord(
    path.join(stateDir(workspaceRoot), `${runId}.json`),
  );
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
    options.type && kinds.includes(options.type)
      ? (options.type as MemoryKind)
      : undefined;
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
              ? [
                  entry.whenToUse,
                  entry.perspective,
                  ...entry.modification,
                ].join("\n")
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
