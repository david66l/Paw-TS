/**
 * TUI 专用：用户提交序列化与运行中断控制。
 *
 * 提供两套能力：
 * 1. {@link createRunSessionController}：管理 Enter 提交的串行执行与 Ctrl+C 中止；
 * 2. {@link createPersistentSession}：Claude Code 风格的持久会话，支持多轮对话
 *    上下文延续。
 */

import path from "node:path";
import {
  AgentOrchestrator,
  DefaultSubAgentLauncher,
  resolvePlanSnapshotMaxItems,
} from "@paw/agent";
import type { StubRunSession } from "@paw/cli-core";
import {
  type AppState,
  CostTracker,
  FileSystemAppStateStore,
  FileSystemSessionStore,
  InMemoryTodoStore,
} from "@paw/core";
import type { RunResult } from "@paw/core";
import type { McpServerConfig } from "@paw/harness";
import { createDeepSeekFlashModel, createDefaultLanguageModel } from "@paw/models";
import type { LanguageModel } from "@paw/models";
import type { ChatMessage } from "@paw/models";
import { defaultSettingsPath, loadPawSettingsLocal } from "@paw/settings";
import { WorkspaceWatcher } from "@paw/workspace";

/**
 * 运行会话控制器接口。
 *
 * 负责串行化用户提交，并在需要时向底层 stub-run 发送 AbortSignal。
 */
export interface RunSessionController {
  /** 当前是否已有提交在处理中。 */
  readonly isSubmissionBusy: () => boolean;
  /** 尝试开始一次新提交；若已有提交在运行则返回 false。 */
  readonly tryBeginSubmission: () => boolean;
  readonly endSubmission: () => void;
  /** 透传给 {@link submitUserLine} → {@link runStubRun} 的会话句柄。 */
  readonly runSession: StubRunSession;
  /** 中止当前正在运行的任务；若无可运行任务返回 false。 */
  readonly abortIfRunning: () => boolean;
}

/**
 * 创建运行会话控制器。
 *
 * @returns 控制器实例
 */
export function createRunSessionController(): RunSessionController {
  let submissionBusy = false;
  let activeAbort: AbortController | null = null;

  return {
    isSubmissionBusy: () => submissionBusy,

    tryBeginSubmission() {
      if (submissionBusy) {
        return false;
      }
      submissionBusy = true;
      return true;
    },

    endSubmission() {
      submissionBusy = false;
    },

    runSession: {
      begin() {
        const ac = new AbortController();
        activeAbort = ac;
        return ac.signal;
      },
      end() {
        activeAbort = null;
      },
    },

    abortIfRunning() {
      const ac = activeAbort;
      if (!ac) {
        return false;
      }
      activeAbort = null;
      ac.abort();
      return true;
    },
  };
}

// ── 持久会话（Claude Code 风格）───────────────────────────────────────────────

/** 创建持久会话的选项。 */
export interface PersistentSessionOptions {
  readonly workspaceRoot: string;
  readonly skillsDir?: string;
  readonly model?: LanguageModel;
  readonly maxSteps?: number;
  /** 询问用户桥接函数，与 StubRunOptions.resolveAskUser 语义一致。 */
  readonly resolveAskUser?: (input: {
    question: string;
    timeoutSec: number | null;
  }) => Promise<string>;
  /** 工具审批桥接函数，与 StubRunOptions.resolveToolApproval 语义一致。 */
  readonly resolveToolApproval?: (input: {
    tool: string;
    args: unknown;
  }) => Promise<boolean>;
  readonly approvalPolicy?: (tool: string) => boolean | undefined;
  /** 事件回调：将 orchestrator 事件转发到 TUI 流。 */
  readonly onEvent?: (envelope: import("@paw/core").RunEventEnvelope) => void;
}

/** 持久会话接口。 */
export interface PersistentSession {
  readonly orch: AgentOrchestrator;
  readonly runId: string;
  /** 模型上下文窗口大小，用于 HUD 上下文条展示（默认 128K）。 */
  readonly contextWindow: number;
  /**
   * 提交用户输入（或展开后的 skill prompt）。
   * 当存在历史状态时会在原对话上继续，否则开启新 run。
   *
   * @param input 用户输入文本
   * @param abortSignal 可选中止信号
   */
  submit(input: string, abortSignal?: AbortSignal): Promise<RunResult>;
  /** 释放会话资源（如文件监听）。 */
  dispose(): void;
}

/**
 * 解析子 Agent 使用的模型。
 *
 * 优先使用 DeepSeek flash 模型；若不可用则回退到主模型。
 *
 * @param workspaceRoot 工作区根目录
 * @param mainModel 主模型
 */
function resolveSubAgentModel(
  workspaceRoot: string,
  mainModel: LanguageModel,
): LanguageModel {
  return createDeepSeekFlashModel(workspaceRoot) ?? mainModel;
}

/**
 * 从 settings.local.json 加载 MCP 服务器配置。
 *
 * @param workspaceRoot 工作区根目录
 */
function loadMcpServers(
  workspaceRoot: string,
): readonly McpServerConfig[] | undefined {
  try {
    const settings = loadPawSettingsLocal(defaultSettingsPath(workspaceRoot)) as Record<string, unknown>;
    const mcpServers = settings.mcp_servers as unknown[] | undefined;
    if (mcpServers && mcpServers.length > 0) {
      return mcpServers as McpServerConfig[];
    }
  } catch {
    /* 设置不存在或格式错误时忽略 */
  }
  return undefined;
}

/**
 * 创建持久会话。
 *
 * 初始化文件状态存储、会话存储、成本追踪、待办存储、工作区监听、
 * 子 Agent 启动器与主 orchestrator，并返回可复用的会话对象。
 *
 * @param opts 持久会话选项
 */
export function createPersistentSession(
  opts: PersistentSessionOptions,
): PersistentSession {
  const maxSteps = opts.maxSteps ?? 40;
  const runId = `session-${Date.now()}`;
  const workspaceRoot = opts.workspaceRoot;

  // 持久化状态与成本追踪
  const appStateStore = new FileSystemAppStateStore({
    statesDir: path.join(workspaceRoot, ".paw", "states"),
  });
  const sessionStore = new FileSystemSessionStore({ workspaceRoot });
  const costTracker = new CostTracker();
  const todoStore = new InMemoryTodoStore();

  // 启动工作区文件监听
  const watcher = new WorkspaceWatcher(workspaceRoot);
  watcher.start();

  // 模型与 MCP 配置
  const mainModel = opts.model ?? createDefaultLanguageModel(workspaceRoot);
  const subAgentModel = resolveSubAgentModel(workspaceRoot, mainModel);
  const mcpServers = loadMcpServers(workspaceRoot);

  // 子 Agent 启动器
  const subAgentLauncher = new DefaultSubAgentLauncher({
    workspaceRoot,
    model: mainModel,
    subAgentModel,
    skillsDir: opts.skillsDir,
    mcpServers,
    maxSteps: 5,
  });

  // 主 orchestrator
  const orch = new AgentOrchestrator({
    model: mainModel,
    skillsDir: opts.skillsDir,
    resolveAskUser: opts.resolveAskUser,
    resolveToolApproval: opts.resolveToolApproval,
    approvalPolicy: opts.approvalPolicy,
    subAgentLauncher,
    appStateStore,
    sessionStore,
    costTracker,
    todoStore,
    watcher,
    mcpServers,
    planSnapshotMaxItems: resolvePlanSnapshotMaxItems(workspaceRoot),
    memoryExtraction: "background",
    onEvent: opts.onEvent,
  });

  /**
   * 提交输入。
   *
   * 若存在历史 AppState，则追加用户消息后继续同一 run；否则新建 run。
   */
  async function submit(
    input: string,
    abortSignal?: AbortSignal,
  ): Promise<RunResult> {
    const state: AppState | null = appStateStore.load(runId);

    if (state) {
      const newMsg: ChatMessage = { role: "user", content: input };
      const messagesWithInput = [...state.messages, newMsg];

      return orch.run({
        runId,
        goal: input,
        workspaceRoot,
        maxSteps,
        abortSignal,
        resumeFromState: {
          ...state,
          messages: messagesWithInput,
          turn: 0,
        },
      });
    }

    return orch.run({
      runId,
      goal: input,
      workspaceRoot,
      maxSteps,
      abortSignal,
    });
  }

  function dispose(): void {
    watcher.stop();
  }

  return {
    orch,
    runId,
    contextWindow: mainModel.capabilities?.contextWindow ?? 128_000,
    submit,
    dispose,
  };
}
