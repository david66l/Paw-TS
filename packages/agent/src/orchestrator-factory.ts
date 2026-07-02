/**
 * Orchestrator 工厂 —— 一站式创建配置完整的 AgentOrchestrator 及其依赖。
 *
 * ## 为什么需要这个模块
 * 创建一个可用的 AgentOrchestrator 需要组装大量依赖：
 * LanguageModel、SubAgentLauncher、CostTracker、各种持久化 Store、
 * WorkspaceWatcher、MCP Server 配置等。
 * 每个调用方（CLI、TUI、API server）都需要相同的组装逻辑。
 * 本模块将这些"装配步骤"封装为单一工厂函数，确保一致性。
 *
 * ## 核心设计决策
 * 1. **统一装配入口**：`createRunOrchestrator()` 返回 `RunOrchestrator`，
 *    包含 orch 实例和所有相关组件，调用方无需了解内部构造。
 * 2. **主/子模型分层**：主模型使用 `createDefaultLanguageModel()`，
 *    子 Agent 优先使用 DeepSeek Flash（成本优化，deepseek-chat）。
 * 3. **MCP 自动加载**：未显式指定 mcpServers 时，自动从 settings.local.json 读取。
 * 4. **planSnapshotMaxItems 优先级**：显式参数 > 自动从设置文件解析。
 * 5. **内存提取策略**：默认 `background`（后台异步），可选 `await`（同步等待）
 *    或 `off`（禁用）。
 * 6. **SubAgentLauncher maxSteps=5**：限制子 agent 的执行步数，防止无限循环。
 */

import path from "node:path";
import {
  CostTracker,
  FileSystemAppStateStore,
  FileSystemSessionStore,
  InMemoryTodoStore,
} from "@paw/core";
import type { RunEventEnvelope } from "@paw/core";
import type { McpServerConfig } from "@paw/harness";
import {
  createDeepSeekFlashModel,
  createDefaultLanguageModel,
} from "@paw/models";
import type { LanguageModel } from "@paw/models";
import { defaultSettingsPath, loadPawSettingsLocal } from "@paw/settings";
import { WorkspaceWatcher } from "@paw/workspace";
import {
  AgentOrchestrator,
  type AskUserResolveInput,
  type ToolApprovalInput,
} from "./orchestrator.js";
import { resolvePlanSnapshotMaxItems } from "./resolve-plan-snapshot-max-items.js";
import { DefaultSubAgentLauncher } from "./sub-agent-launcher.js";

/**
 * 运行 orchestrator 工厂选项。
 *
 * 与 UI 无关，封装构造一次正确配置的 AgentOrchestrator 所需的全部参数。
 */
export interface RunOrchestratorOptions {
  readonly workspaceRoot: string;
  readonly skillsDir?: string;
  /** 询问用户桥接函数。 */
  readonly resolveAskUser?: (input: AskUserResolveInput) => Promise<string>;
  /** 工具审批桥接函数。 */
  readonly resolveToolApproval?: (input: ToolApprovalInput) => Promise<boolean>;
  readonly approvalPolicy?: (tool: string) => boolean | undefined;
  /** 显式指定 MCP 服务器；省略时自动从 settings.local.json 读取。 */
  readonly mcpServers?: readonly McpServerConfig[];
  readonly planSnapshotMaxItems?: number;
  /**
   * 记忆提取策略：
   * - `background`：异步后台提取（默认）
   * - `await`：同步等待提取完成
   * - `off`：不提取记忆
   */
  readonly memoryExtraction?: "background" | "await" | "off";
  /** 事件回调：转发 orchestrator 事件到调用方。 */
  readonly onEvent?: (envelope: RunEventEnvelope) => void;
}

/**
 * 运行 orchestrator 及其配套对象。
 *
 * 调用方负责生命周期：需要持久会话时自行保持 watcher 运行；
 * 单次运行结束后应调用 `watcher.stop()`。
 */
export interface RunOrchestrator {
  readonly orch: AgentOrchestrator;
  readonly mainModel: LanguageModel;
  readonly subAgentModel: LanguageModel;
  readonly costTracker: CostTracker;
  readonly todoStore: InMemoryTodoStore;
  readonly watcher: WorkspaceWatcher;
  readonly sessionStore: FileSystemSessionStore;
  readonly appStateStore: FileSystemAppStateStore;
  readonly runId: string;
}

/**
 * 从 settings.local.json 加载 MCP 服务器配置。
 *
 * 读取失败（文件不存在等）时静默忽略，返回 undefined。
 *
 * @param workspaceRoot 工作区根目录
 * @returns MCP 服务器配置数组，无配置则返回 undefined
 */
function loadMcpServers(
  workspaceRoot: string,
): readonly McpServerConfig[] | undefined {
  try {
    const settings = loadPawSettingsLocal(
      defaultSettingsPath(workspaceRoot),
    ) as Record<string, unknown>;
    const mcpServers = settings.mcp_servers as unknown[] | undefined;
    if (mcpServers && mcpServers.length > 0) {
      return mcpServers as McpServerConfig[];
    }
  } catch {
    // 设置文件可能不存在，忽略
  }
  return undefined;
}

/**
 * 创建并启动一个配置完整的运行 orchestrator。
 *
 * 统一完成：模型选择、MCP 加载、SubAgentLauncher、持久化 store、
 * 工作区监听、AgentOrchestrator 装配。
 *
 * 装配流程：
 * 1. 解析 planSnapshotMaxItems
 * 2. 加载 MCP 服务器配置
 * 3. 创建核心组件：CostTracker、TodoStore、WorkspaceWatcher
 * 4. 选择主模型和子 Agent 模型（子 Agent 优先用 DeepSeek Flash 降低成本）
 * 5. 创建持久化 store（SessionStore、AppStateStore）
 * 6. 创建 SubAgentLauncher（限制 maxSteps=5）
 * 7. 组装 AgentOrchestrator
 *
 * @param opts 工厂选项
 * @returns 完整装配的 RunOrchestrator 对象
 */
export function createRunOrchestrator(
  opts: RunOrchestratorOptions,
): RunOrchestrator {
  const { workspaceRoot } = opts;

  // 解析快照上限：显式值优先，否则从设置文件读取
  const planSnapshotMaxItems =
    opts.planSnapshotMaxItems !== undefined
      ? opts.planSnapshotMaxItems
      : resolvePlanSnapshotMaxItems(workspaceRoot);

  // 加载 MCP 服务器配置
  const mcpServers = opts.mcpServers ?? loadMcpServers(workspaceRoot);

  const costTracker = new CostTracker();
  const todoStore = new InMemoryTodoStore();
  // 启动工作区文件监听器
  const watcher = new WorkspaceWatcher(workspaceRoot);
  watcher.start();

  // 主模型使用默认模型，子 Agent 优先使用 DeepSeek flash 模型以降低成本
  const mainModel = createDefaultLanguageModel(workspaceRoot);
  const subAgentModel = createDeepSeekFlashModel(workspaceRoot) ?? mainModel;

  // 创建持久化 store
  const sessionStore = new FileSystemSessionStore({ workspaceRoot });
  const appStateStore = new FileSystemAppStateStore({
    statesDir: path.join(workspaceRoot, ".paw", "states"),
  });

  // 创建子 Agent 启动器，maxSteps=5 限制子 Agent 的递归深度
  const subAgentLauncher = new DefaultSubAgentLauncher({
    workspaceRoot,
    model: mainModel,
    subAgentModel,
    skillsDir: opts.skillsDir,
    mcpServers,
    maxSteps: 5,
  });

  // 组装最终的 AgentOrchestrator
  const orch = new AgentOrchestrator({
    model: mainModel,
    auxiliaryModel: subAgentModel,
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
    planSnapshotMaxItems,
    memoryExtraction: opts.memoryExtraction ?? "background",
    onEvent: opts.onEvent,
  });

  return {
    orch,
    mainModel,
    subAgentModel,
    costTracker,
    todoStore,
    watcher,
    sessionStore,
    appStateStore,
    runId: `stub-${Date.now()}`,
  };
}
