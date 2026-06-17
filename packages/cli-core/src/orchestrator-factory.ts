import path from "node:path";
import {
  AgentOrchestrator,
  type AskUserResolveInput,
  DefaultSubAgentLauncher,
  type ToolApprovalInput,
  resolvePlanSnapshotMaxItems,
} from "@paw/agent";
import {
  CostTracker,
  FileSystemAppStateStore,
  FileSystemSessionStore,
  InMemoryTodoStore,
} from "@paw/core";
import type { RunEventEnvelope } from "@paw/core";
import type { McpServerConfig } from "@paw/harness";
import { createDeepSeekFlashModel, createDefaultLanguageModel } from "@paw/models";
import type { LanguageModel } from "@paw/models";
import { defaultSettingsPath, loadPawSettingsLocal } from "@paw/settings";
import { WorkspaceWatcher } from "@paw/workspace";

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
 * @param workspaceRoot 工作区根目录
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
 * @param opts 工厂选项
 */
export function createRunOrchestrator(
  opts: RunOrchestratorOptions,
): RunOrchestrator {
  const { workspaceRoot } = opts;

  const planSnapshotMaxItems =
    opts.planSnapshotMaxItems !== undefined
      ? opts.planSnapshotMaxItems
      : resolvePlanSnapshotMaxItems(workspaceRoot);

  const mcpServers = opts.mcpServers ?? loadMcpServers(workspaceRoot);

  const costTracker = new CostTracker();
  const todoStore = new InMemoryTodoStore();
  const watcher = new WorkspaceWatcher(workspaceRoot);
  watcher.start();

  // 主模型使用默认模型，子 Agent 优先使用 DeepSeek flash 模型以降低成本
  const mainModel = createDefaultLanguageModel(workspaceRoot);
  const subAgentModel = createDeepSeekFlashModel(workspaceRoot) ?? mainModel;

  const sessionStore = new FileSystemSessionStore({ workspaceRoot });
  const appStateStore = new FileSystemAppStateStore({
    statesDir: path.join(workspaceRoot, ".paw", "states"),
  });

  const subAgentLauncher = new DefaultSubAgentLauncher({
    workspaceRoot,
    model: mainModel,
    subAgentModel,
    skillsDir: opts.skillsDir,
    mcpServers,
    maxSteps: 5,
  });

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
