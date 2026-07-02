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

import type { SkillRegistry, TodoStore } from "@paw/core";
import type { WorkspaceWatcher } from "@paw/workspace";

import type { ShellSandboxConfig } from "./sandbox/index.js";
import type { McpClientManager } from "./mcp-client.js";

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
  readonly testsRun?: readonly { readonly name: string; readonly passed: boolean }[];
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
}

export interface SubAgentLauncher {
  /** 非流式启动（兼容旧接口） */
  launch(goal: string, maxSteps?: number, options?: SubAgentLaunchOptions): Promise<SubAgentResult>;
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
  }): Promise<SubAgentResult>;
}

/** 工具执行所需的完整环境上下文 */
export interface HarnessContext {
  readonly workspaceRoot: string;
  readonly mcp?: McpClientManager;
  readonly todoStore?: TodoStore;
  readonly subAgentLauncher?: SubAgentLauncher;
  readonly skillRegistry?: SkillRegistry;
  /** Shell 命令实时输出回调（流式推送到 TUI） */
  readonly onShellChunk?: (tool: string, chunk: string, isStderr: boolean) => void;
  readonly watcher?: WorkspaceWatcher;
  readonly abortSignal?: AbortSignal;
  readonly parentRunId?: string;
  /** 构建子 Agent 共享上下文的回调 */
  readonly buildSubAgentSharedContext?: (input: { readonly goal: string; readonly args: Record<string, unknown> }) => unknown;
  /** Docker/Podman 沙箱策略配置 */
  readonly shellSandbox?: ShellSandboxConfig;
}
