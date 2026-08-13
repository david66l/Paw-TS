/**
 * Harness 上下文类型定义。
 * =======================
 *
 * HarnessContext 是工具执行所需的完整环境上下文。
 * 包含了工作区路径、MCP 管理器、子 Agent 启动器、
 * Skill 注册表等所有执行工具需要的依赖。
 *
 * 子 Agent 相关类型也在此定义（与 @paw/agent 中的类型平行）：
 * - SubAgentLauncher：子 Agent 的抽象启动接口
 * - SubAgentResult：子 Agent 返回的结果结构
 * - SubAgentLaunchOptions：启动参数
 *
 * 面试要点：
 * - HarnessContext 体现依赖注入模式：所有外部依赖通过接口传入，
 *   方便测试和替换
 * - SubAgentLauncher 是抽象接口：DefaultSubAgentLauncher（在 @paw/agent）
 *   使用 AgentOrchestrator 实现，但接口不耦合到具体实现
 */

import type {
  AgentAcceptanceUpdateAction,
  SkillRegistry,
  TodoStore,
} from "@paw/core";
import type { ArtifactRegistry as CoreArtifactRegistry } from "@paw/core";
import type { WorkspaceWatcher } from "@paw/workspace";

import type { McpClientManager } from "./mcp-client.js";
import type { ShellSandboxConfig } from "./sandbox/index.js";

/**
 * P3 冷库：可寻址归档注册表的最小接口（context.recall 工具依赖）。
 * 由 @paw/agent 注入真实 ArtifactRegistry（类型 Pick 保证鸭子类型解耦）。
 */
export type ArtifactRegistryLike = Pick<
  CoreArtifactRegistry,
  "tryRecall" | "toStub" | "markCited" | "search" | "get"
>;

export interface SubAgentArtifact {
  readonly type: "file" | "code" | "test_result" | "search_result";
  readonly path?: string;
  readonly content: string;
  readonly summary: string;
}

export interface SubAgentResult {
  readonly status: "completed" | "failed";
  readonly summary: string;
  readonly findings?: readonly string[];
  readonly changedFiles?: readonly string[];
  readonly testsRun?: readonly {
    readonly name: string;
    readonly passed: boolean;
  }[];
  readonly errors?: readonly string[];
  readonly artifacts?: readonly SubAgentArtifact[];
  /** 完整追踪数据：调试/回放/TUI 用 — 不注入父 Agent 上下文。 */
  readonly trace?: {
    readonly messages: readonly import("@paw/core").ChatMessage[];
    readonly events: readonly import("@paw/core").RunEventEnvelope[];
    readonly stepsTaken: number;
  };
}

export interface SubAgentLaunchOptions {
  readonly args?: Record<string, unknown>;
  readonly sharedContext?: unknown;
  readonly signal?: AbortSignal;
  readonly parentRunId?: string;
  readonly agentId?: string;
  readonly onEvent?: (envelope: import("@paw/core").RunEventEnvelope) => void;
  /** 并行子 Agent 的文件锁（同批子 Agent 共享一把锁表） */
  readonly fileLock?: FileLockLike;
}

/** 文件锁最小接口（由 agent 层的 FileLockManager 实现；harness 不依赖具体实现） */
export interface FileLockLike {
  tryAcquire(
    paths: readonly string[],
    owner: string,
  ): { ok: boolean; holder?: string; path?: string };
  acquire(
    paths: readonly string[],
    owner: string,
    timeoutMs: number,
    onWait?: (conflict: {
      ok: boolean;
      holder?: string;
      path?: string;
    }) => void,
  ): Promise<{ ok: boolean; holder?: string; path?: string }>;
  releaseAll(owner: string): void;
}

export interface SubAgentLauncher {
  /** 非流式启动（兼容旧接口） */
  launch(
    goal: string,
    maxSteps?: number,
    options?: SubAgentLaunchOptions,
  ): Promise<SubAgentResult>;
  /** 流式启动：实时转发事件到父 Agent */
  launchStreaming(options: {
    goal: string;
    maxSteps?: number;
    signal?: AbortSignal;
    parentRunId: string;
    agentId: string;
    onEvent: (envelope: import("@paw/core").RunEventEnvelope) => void;
    sharedContext?: unknown;
    args?: Record<string, unknown>;
    fileLock?: FileLockLike;
  }): Promise<SubAgentResult>;
}

/** 工具执行所需的完整环境上下文 */
export interface HarnessContext {
  readonly workspaceRoot: string;
  readonly mcp?: McpClientManager;
  readonly todoStore?: TodoStore;
  /**
   * Session-owned acceptance ledger. The agent layer injects the durable
   * implementation so harness can expose a native tool without depending on
   * @paw/agent (the same dependency-inversion pattern as memoryRuntime).
   */
  readonly acceptanceLedger?: {
    apply(input: Omit<AgentAcceptanceUpdateAction, "type">):
      | {
          readonly ok: boolean;
          readonly error?: string;
          readonly state?: unknown;
        }
      | Promise<{
          readonly ok: boolean;
          readonly error?: string;
          readonly state?: unknown;
        }>;
  };
  readonly subAgentLauncher?: SubAgentLauncher;
  readonly skillRegistry?: SkillRegistry;
  /** Shell 命令实时输出回调（流式推送到 TUI） */
  readonly onShellChunk?: (
    tool: string,
    chunk: string,
    isStderr: boolean,
  ) => void;
  readonly watcher?: WorkspaceWatcher;
  readonly abortSignal?: AbortSignal;
  readonly parentRunId?: string;
  /** 构建子 Agent 共享上下文的回调 */
  readonly buildSubAgentSharedContext?: (input: {
    readonly goal: string;
    readonly args: Record<string, unknown>;
  }) => unknown;
  /**
   * 创建业务 Agent（写 .paw/agents + 可选 registry reload）。
   * 由 @paw/agent 注入；未注入时 harness 回退为直接写 md。
   */
  readonly createAgent?: (input: {
    readonly id: string;
    readonly name: string;
    readonly role: string;
    readonly prompt: string;
    readonly tools?: string;
    readonly childPolicy?: "read_only" | "read_write";
    readonly model?: "flash" | "pro" | "inherit";
    readonly outputFormat?: string;
    readonly emoji?: string;
    readonly description?: string;
    readonly overwrite?: boolean;
  }) =>
    | Promise<{
        readonly ok: boolean;
        readonly id?: string;
        readonly path?: string;
        readonly error?: string;
      }>
    | {
        readonly ok: boolean;
        readonly id?: string;
        readonly path?: string;
        readonly error?: string;
      };
  /** Docker/Podman 沙箱策略配置 */
  readonly shellSandbox?: ShellSandboxConfig;
  /**
   * Unified approval bus: when true, shell "ask" policy was already approved
   * at the tool-approval gate — execute must not re-block as a second gate.
   */
  readonly shellCommandPreApproved?: boolean;
  /**
   * 记忆 Runtime 门面（duck-typed，避免 harness→memory 硬依赖）。
   * memory.list/read/save 唯一在线入口。
   */
  readonly memoryRuntime?: {
    listMemories(query?: {
      limit?: number;
      type?: string;
    }): Promise<
      readonly {
        id: string;
        title: string;
        summary: string;
        type: string;
        status: string;
        confidence: number;
      }[]
    >;
    readMemory(idOrSubject: string): Promise<{
      id: string;
      title: string;
      summary: string;
      type: string;
      status: string;
      confidence: number;
      relatedFiles?: readonly string[];
    } | null>;
    saveMemory(input: {
      title: string;
      summary: string;
      type?: string;
      content?: string;
      taskId?: string;
    }): Promise<{
      candidateId: string;
      decision: string;
      decisionStatus: string;
      memoryId?: string;
    }>;
  };
  /** 当前 TaskSession id（与 memoryRuntime 配套） */
  readonly memoryTaskId?: string;
  /** P3 冷库：可寻址归档注册表（context.recall 工具的执行后端） */
  readonly artifactRegistry?: ArtifactRegistryLike;
}
