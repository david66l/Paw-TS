/**
 * 默认的 SubAgentLauncher 实现，使用 AgentOrchestrator 作为子 Agent 引擎。
 * ======================================================================
 *
 * 子 Agent 启动器是连接父 Agent 和子 Agent 的桥梁。
 *
 * 关键设计决策：
 * - **复用 AgentOrchestrator**：子 Agent 也是一个完整的 AgentOrchestrator 实例，
 *   只是 runMode 设为 "child"，使用精简的 child system prompt。
 * - **子 Agent 模型可选独立配置**：subAgentModel 默认复用父 Agent 的模型，
 *   但可以指定更便宜的模型来降低子 Agent 的成本。
 * - **只读默认**：子 Agent 默认 childPolicy = "read_only"，
 *   避免多个 Agent 并发修改同一文件导致的竞态问题。
 * - **记忆提取关闭**：子 Agent 不产生记忆（memoryExtraction = "off"），
 *   只有父 Agent 产生记忆。
 * - **SharedContext 解析**：支持传入结构化 SharedContext 或从 goal+args 构建最小上下文。
 */

import type { RunEventEnvelope } from "@paw/core";
import type {
  McpServerConfig,
  SubAgentLaunchOptions,
  SubAgentLauncher,
  SubAgentResult,
} from "@paw/harness";
import type { LanguageModel } from "@paw/models";

import { buildMinimalSharedContext } from "./orchestrator/agent-args.js";
import { AgentOrchestrator } from "./orchestrator.js";
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
}

/** 类型守卫：判断值是否为 SharedContext 结构 */
function isSharedContext(value: unknown): value is SharedContext {
  return (
    value !== null &&
    typeof value === "object" &&
    "task" in value &&
    typeof (value as SharedContext).task === "string"
  );
}

/**
 * 解析 SharedContext。
 * 如果已经传入了结构化的 SharedContext → 直接使用；
 * 否则从 goal + args 构建最小上下文。
 */
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

export class DefaultSubAgentLauncher implements SubAgentLauncher {
  private readonly workspaceRoot: string;
  private readonly model?: LanguageModel;
  private readonly subAgentModel?: LanguageModel;
  private readonly skillsDir?: string;
  private readonly mcpServers?: readonly McpServerConfig[];
  private readonly defaultMaxSteps: number;

  constructor(opts: DefaultSubAgentLauncherOptions) {
    this.workspaceRoot = opts.workspaceRoot;
    this.model = opts.model;
    this.subAgentModel = opts.subAgentModel;
    this.skillsDir = opts.skillsDir;
    this.mcpServers = opts.mcpServers;
    this.defaultMaxSteps = opts.maxSteps ?? 10;
  }

  /**
   * 创建一个子 Agent 的 AgentOrchestrator 实例。
   *
   * 关键配置：
   * - runMode: "child" → 使用精简的 child system prompt
   * - childPolicy: sharedContext 中指定的策略 → 默认 read_only
   * - memoryExtraction: "off" → 子 Agent 不产生记忆
   */
  private createChildOrchestrator(
    sharedContext: SharedContext,
    onEvent: (envelope: RunEventEnvelope) => void,
  ): AgentOrchestrator {
    const childModel = this.subAgentModel ?? this.model;
    return new AgentOrchestrator({
      model: childModel,
      auxiliaryModel: childModel,
      runMode: "child",
      sharedContext,
      childPolicy: sharedContext.childPolicy ?? "read_only",
      skillsDir: this.skillsDir,
      mcpServers: this.mcpServers,
      memoryExtraction: "off",
      onEvent,
    });
  }

  /**
   * 非流式启动子 Agent（兼容旧接口）。
   * 内部委托给 launchStreaming。
   */
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

  /**
   * 流式启动子 Agent。
   *
   * 流程：
   * 1. 解析 SharedContext
   * 2. 创建 child AgentOrchestrator
   * 3. 调用 orch.run() 执行子 Agent
   * 4. 收集事件流和步数统计
   * 5. 返回 SubAgentResult（摘要 + trace）
   */
  async launchStreaming(options: {
    goal: string;
    maxSteps?: number;
    signal?: AbortSignal;
    parentRunId: string;
    agentId: string;
    onEvent: (envelope: RunEventEnvelope) => void;
    sharedContext?: unknown;
    args?: Record<string, unknown>;
  }): Promise<SubAgentResult> {
    const runId = options.agentId;
    let stepsTaken = 0;
    const events: RunEventEnvelope[] = [];
    const sharedContext = resolveSharedContext(
      options.goal,
      options.sharedContext,
      options.args,
    );

    // 创建子 Agent orchestrator，收集事件和步数
    const orch = this.createChildOrchestrator(sharedContext, (envelope) => {
      events.push(envelope);
      options.onEvent(envelope);
      if (envelope.event.type === "loop.tick") {
        stepsTaken = envelope.event.turn;
      }
    });

    // 执行
    const result = await orch.run({
      runId,
      goal: options.goal,
      workspaceRoot: this.workspaceRoot,
      maxSteps: options.maxSteps ?? this.defaultMaxSteps,
      abortSignal: options.signal,
    });

    return {
      status: result.status === "completed" ? "completed" : "failed",
      summary: result.message,
      trace: {
        messages: [],
        events,
        stepsTaken,
      },
    };
  }
}
