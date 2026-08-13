/**
 * 默认的 SubAgentLauncher 实现，使用 AgentOrchestrator 作为子 Agent 引擎。
 *
 * 优先按 agent_id 从 AgentRegistry 物化 Spec（工具硬裁、childPolicy、prompt）；
 * 否则回退到旧 agent_type 文案 + SharedContext。
 */

import type { RunEventEnvelope } from "@paw/core";
import { ContextManager } from "@paw/core";
import type {
  McpServerConfig,
  SubAgentLaunchOptions,
  SubAgentLauncher,
  SubAgentResult,
} from "@paw/harness";
import type { LanguageModel } from "@paw/models";

import type { FileLockLike } from "@paw/harness";
import { materializeAgent } from "./agents/factory.js";
import type { AgentRegistry } from "./agents/registry.js";
import type { ToolExecutionPolicy } from "./execution-policy.js";
import type { VerificationPolicy } from "./lifecycle/verification-gate.js";
import { AgentOrchestrator, type ToolApprovalInput } from "./orchestrator.js";
import { buildMinimalSharedContext } from "./orchestrator/agent-args.js";
import type { SharedContext } from "./orchestrator/types.js";

export interface DefaultSubAgentLauncherOptions {
  readonly workspaceRoot: string;
  /** 父 Agent 的模型（默认也用作子 Agent 模型） */
  readonly model?: LanguageModel;
  /** 子 Agent 专用模型（可选，未指定则复用 model） */
  readonly subAgentModel?: LanguageModel;
  readonly skillsDir?: string;
  readonly mcpServers?: readonly McpServerConfig[];
  /** 子 Agent 默认 maxSteps */
  readonly maxSteps?: number;
  /** Agent 注册表：按 agent_id 装配 */
  readonly agentRegistry?: AgentRegistry;
  /**
   * 工具审批回调（透传给子 Agent）。
   * 不传则子 Agent 保持旧行为：修改性工具无交互环境下默认放行。
   */
  readonly resolveToolApproval?: (input: ToolApprovalInput) => Promise<boolean>;
  /** 工具审批策略（与根 Orchestrator 同一语义） */
  readonly approvalPolicy?: (tool: string) => boolean | undefined;
  readonly toolExecutionPolicy?: ToolExecutionPolicy;
  readonly verificationPolicy?: VerificationPolicy;
}

function isSharedContext(value: unknown): value is SharedContext {
  return (
    value !== null &&
    typeof value === "object" &&
    "task" in value &&
    typeof (value as SharedContext).task === "string"
  );
}

function resolveSharedContext(
  goal: string,
  sharedContext: unknown | undefined,
  args: Record<string, unknown> | undefined,
): SharedContext {
  if (isSharedContext(sharedContext)) {
    return sharedContext;
  }
  return buildMinimalSharedContext(goal, args);
}

function parseAgentId(
  args: Record<string, unknown> | undefined,
): string | undefined {
  const raw = args?.agent_id ?? args?.agentId ?? args?.spec_id ?? args?.specId;
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  return undefined;
}

export class DefaultSubAgentLauncher implements SubAgentLauncher {
  private readonly workspaceRoot: string;
  private readonly model?: LanguageModel;
  private readonly subAgentModel?: LanguageModel;
  private readonly skillsDir?: string;
  private readonly mcpServers?: readonly McpServerConfig[];
  private readonly defaultMaxSteps: number;
  private readonly agentRegistry?: AgentRegistry;
  private readonly resolveToolApproval?: DefaultSubAgentLauncherOptions["resolveToolApproval"];
  private readonly approvalPolicy?: DefaultSubAgentLauncherOptions["approvalPolicy"];
  private readonly toolExecutionPolicy?: DefaultSubAgentLauncherOptions["toolExecutionPolicy"];
  private readonly verificationPolicy?: DefaultSubAgentLauncherOptions["verificationPolicy"];

  constructor(opts: DefaultSubAgentLauncherOptions) {
    this.workspaceRoot = opts.workspaceRoot;
    this.model = opts.model;
    this.subAgentModel = opts.subAgentModel;
    this.skillsDir = opts.skillsDir;
    this.mcpServers = opts.mcpServers;
    this.defaultMaxSteps = opts.maxSteps ?? 10;
    this.agentRegistry = opts.agentRegistry;
    this.resolveToolApproval = opts.resolveToolApproval;
    this.approvalPolicy = opts.approvalPolicy;
    this.toolExecutionPolicy = opts.toolExecutionPolicy;
    this.verificationPolicy = opts.verificationPolicy;
  }

  private createChildOrchestrator(
    sharedContext: SharedContext,
    onEvent: (envelope: RunEventEnvelope) => void,
    extras?: {
      allowedTools?: readonly string[] | null;
      model?: LanguageModel;
      memoryExtraction?: "off" | "background" | "await";
      fileLock?: FileLockLike;
      contextManager?: ContextManager;
    },
  ): AgentOrchestrator {
    const childModel = extras?.model ?? this.subAgentModel ?? this.model;
    return new AgentOrchestrator({
      model: childModel,
      auxiliaryModel: childModel,
      runMode: "child",
      sharedContext,
      childPolicy: sharedContext.childPolicy ?? "read_only",
      skillsDir: this.skillsDir,
      mcpServers: this.mcpServers,
      memoryExtraction: extras?.memoryExtraction ?? "off",
      allowedTools: extras?.allowedTools,
      resolveToolApproval: this.resolveToolApproval,
      approvalPolicy: this.approvalPolicy,
      toolExecutionPolicy: this.toolExecutionPolicy,
      verificationPolicy: this.verificationPolicy,
      fileLock: extras?.fileLock,
      contextManager: extras?.contextManager,
      onEvent,
    });
  }

  async launch(
    goal: string,
    maxSteps?: number,
    options?: SubAgentLaunchOptions,
  ): Promise<SubAgentResult> {
    const parentRunId =
      options?.parentRunId ?? `parent-${Date.now().toString(36)}`;
    const agentId =
      options?.agentId ??
      `sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return this.launchStreaming({
      goal,
      maxSteps,
      signal: options?.signal,
      parentRunId,
      agentId,
      onEvent: options?.onEvent ?? (() => {}),
      sharedContext: options?.sharedContext,
      args: options?.args,
    });
  }

  async launchStreaming(options: {
    goal: string;
    maxSteps?: number;
    signal?: AbortSignal;
    parentRunId: string;
    agentId: string;
    onEvent: (envelope: RunEventEnvelope) => void;
    sharedContext?: unknown;
    args?: Record<string, unknown>;
    fileLock?: FileLockLike;
  }): Promise<SubAgentResult> {
    const runId = options.agentId;
    let stepsTaken = 0;
    const events: RunEventEnvelope[] = [];

    // 热加载：每次 spawn 前 reload，吃到 create_agent 新文件
    if (this.agentRegistry) {
      this.agentRegistry.reload();
    }

    const specId = parseAgentId(options.args);
    const spec = specId ? this.agentRegistry?.get(specId) : undefined;

    let sharedContext: SharedContext;
    let allowedTools: readonly string[] | null | undefined;
    let childModel: LanguageModel | undefined;
    let memoryExtraction: "off" | "background" | "await" = "off";
    let maxSteps = options.maxSteps ?? this.defaultMaxSteps;

    if (spec) {
      const mat = materializeAgent(spec, options.goal, {
        workspaceRoot: this.workspaceRoot,
        inheritModel: this.subAgentModel ?? this.model,
        forceChild: true,
      });
      // 合并父级摘要 facts（若有）
      const parentCtx = isSharedContext(options.sharedContext)
        ? options.sharedContext
        : undefined;
      sharedContext = {
        ...mat.sharedContext,
        facts: [
          ...mat.sharedContext.facts,
          ...(parentCtx?.facts ?? []).slice(0, 10),
        ],
        // 合并父级约束（用户 must/never 指令），去重且 Spec 约束在前
        constraints: [
          ...new Set([
            ...mat.sharedContext.constraints,
            ...(parentCtx?.constraints ?? []),
          ]),
        ],
        artifacts: parentCtx?.artifacts?.length
          ? parentCtx.artifacts
          : mat.sharedContext.artifacts,
        // 合并父级进度状态：父级已完成/待办在前，Spec 物化的在后
        state: {
          completed: [
            ...(parentCtx?.state?.completed ?? []),
            ...mat.sharedContext.state.completed,
          ],
          pending: [
            ...(parentCtx?.state?.pending ?? []),
            ...mat.sharedContext.state.pending,
          ],
          risks: mat.sharedContext.state.risks ?? parentCtx?.state?.risks,
        },
        parentConclusions: parentCtx?.parentConclusions,
      };
      // 调用方可覆盖 child_policy
      const policyOverride =
        options.args?.child_policy ?? options.args?.childPolicy;
      if (policyOverride === "read_only" || policyOverride === "read_write") {
        sharedContext = {
          ...sharedContext,
          childPolicy: policyOverride,
        };
      }
      allowedTools = mat.allowedTools;
      childModel = mat.model;
      memoryExtraction = mat.memoryExtraction;
      if (options.maxSteps === undefined) {
        maxSteps = mat.maxSteps;
      }
    } else {
      sharedContext = resolveSharedContext(
        options.goal,
        options.sharedContext,
        options.args,
      );
    }

    // 注入独立 ContextManager：run 结束后可读出完整对话填充 trace.messages
    const ctxMgr = new ContextManager();
    const orch = this.createChildOrchestrator(
      sharedContext,
      (envelope) => {
        events.push(envelope);
        options.onEvent(envelope);
        if (envelope.event.type === "loop.tick") {
          stepsTaken = envelope.event.turn;
        }
      },
      {
        allowedTools,
        model: childModel,
        memoryExtraction,
        fileLock: options.fileLock,
        contextManager: ctxMgr,
      },
    );

    const result = await orch.run({
      runId,
      goal: options.goal,
      workspaceRoot: this.workspaceRoot,
      maxSteps,
      abortSignal: options.signal,
    });

    return {
      status: result.status === "completed" ? "completed" : "failed",
      summary: result.message,
      trace: {
        messages: ctxMgr.buildMessages(),
        events,
        stepsTaken,
      },
    };
  }
}
