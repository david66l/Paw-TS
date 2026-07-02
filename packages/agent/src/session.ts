import path from "node:path";
import {
  type AppState,
  FileSystemAppStateStore,
  type RunResult,
} from "@paw/core";
import type { ChatMessage, LanguageModel } from "@paw/models";
import {
  type RunOrchestratorOptions,
  createRunOrchestrator,
} from "./orchestrator-factory.js";
import type { AgentOrchestrator } from "./orchestrator.js";
import type { StubRunSession } from "./stub-run.js";

/**
 * CLI 运行会话控制器。
 * ===================
 *
 * 负责串行化用户提交（防止并发 Run），并通过 AbortController 实现中断。
 *
 * PersistentSession 提供持久的 Agent 会话：
 * - 复用同一个 orchestrator 实例（保留 MCP 连接、文件监听器等资源）
 * - 每次 submit 检查是否有保存状态 → 有则恢复，否则全新启动
 * - dispose() 释放文件监听器等资源
 *
 * 面试要点：
 * - 为什么需要串行化？LLM 调用不能并发（上下文是线性的）
 * - 为什么复用 orchestrator？MCP 连接建立开销大，文件监听器需要持续运行
 */

/**
 * 运行会话控制器。
 *
 * 负责串行化用户提交，并在需要时向底层运行发送 AbortSignal。
 */
export interface RunSessionController {
  /** 当前是否已有提交在处理中。 */
  readonly isSubmissionBusy: () => boolean;
  /** 尝试开始一次新提交；若已有提交在运行则返回 false。 */
  readonly tryBeginSubmission: () => boolean;
  readonly endSubmission: () => void;
  /** 单次运行会话句柄。 */
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

/** 创建持久会话的选项。 */
export interface PersistentSessionOptions
  extends Omit<RunOrchestratorOptions, "memoryExtraction"> {
  readonly model?: LanguageModel;
  readonly maxSteps?: number;
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
 * 创建持久会话。
 *
 * 使用统一的 orchestrator 工厂初始化运行所需对象，并返回可复用的会话对象。
 *
 * @param opts 持久会话选项
 */
export function createPersistentSession(
  opts: PersistentSessionOptions,
): PersistentSession {
  const maxSteps = opts.maxSteps ?? 40;
  const runId = `session-${Date.now()}`;
  const workspaceRoot = opts.workspaceRoot;

  const { orch, mainModel, watcher } = createRunOrchestrator({
    workspaceRoot,
    skillsDir: opts.skillsDir,
    resolveAskUser: opts.resolveAskUser,
    resolveToolApproval: opts.resolveToolApproval,
    approvalPolicy: opts.approvalPolicy,
    mcpServers: opts.mcpServers,
    planSnapshotMaxItems: opts.planSnapshotMaxItems,
    memoryExtraction: "background",
    onEvent: opts.onEvent,
  });

  const appStateStore = new FileSystemAppStateStore({
    statesDir: path.join(workspaceRoot, ".paw", "states"),
  });

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
