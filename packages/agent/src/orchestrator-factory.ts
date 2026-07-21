/**
 * Orchestrator 工厂 —— 一站式创建配置完整的 AgentOrchestrator 及其依赖。
 *
 * 含 AgentRegistry：加载 `.paw/agents`、种子狸花等、按 Spec 装配总控与子 Agent。
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
  type AgentRegistry,
  type CreateAgentInput,
  allowedToolsForSpec,
  createAgentInRegistry,
  loadAgentRegistry,
  resolveModelForSpec,
} from "./agents/index.js";
import {
  AgentOrchestrator,
  type AskUserResolveInput,
  type ToolApprovalInput,
} from "./orchestrator.js";
import { resolvePlanSnapshotMaxItems } from "./resolve-plan-snapshot-max-items.js";
import { DefaultSubAgentLauncher } from "./sub-agent-launcher.js";

export interface RunOrchestratorOptions {
  readonly workspaceRoot: string;
  readonly skillsDir?: string;
  readonly resolveAskUser?: (input: AskUserResolveInput) => Promise<string>;
  readonly resolveToolApproval?: (input: ToolApprovalInput) => Promise<boolean>;
  readonly approvalPolicy?: (tool: string) => boolean | undefined;
  readonly mcpServers?: readonly McpServerConfig[];
  readonly planSnapshotMaxItems?: number;
  readonly memoryExtraction?: "background" | "await" | "off";
  readonly onEvent?: (envelope: RunEventEnvelope) => void;
  /**
   * 总控 Agent id（默认 lihua）。
   * 若注册表无此 id，仍创建全量 Orchestrator，但不注入花名册身份。
   */
  readonly rootAgentId?: string;
  /** 跳过 ensure 种子（测试） */
  readonly skipAgentSeeds?: boolean;
}

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
  readonly agentRegistry: AgentRegistry;
  /** root Spec 的 maxSteps（如狸花 32）；调用方未显式指定时应作为默认值 */
  readonly rootMaxSteps?: number;
}

function loadMcpServers(
  workspaceRoot: string,
): readonly McpServerConfig[] | undefined {
  try {
    const settings = loadPawSettingsLocal(
      defaultSettingsPath(workspaceRoot),
    ) as Record<string, unknown>;
    const mcpServers = settings.mcp_servers as unknown[] | undefined;
    if (mcpServers && mcpServers.length > 0) {
      return mcpServers as readonly McpServerConfig[];
    }
  } catch {
    // ignore
  }
  return undefined;
}

export function createRunOrchestrator(
  opts: RunOrchestratorOptions,
): RunOrchestrator {
  const { workspaceRoot } = opts;

  /**
   * 审批回调串行化：根 Agent 与并行子 Agent 共享同一审批通道。
   * 若并发调用，单槽 UI（TUI footer / 桌面审批卡）会互相覆盖导致 Promise 泄漏，
   * 这里用 Promise 链强制排队，一次只问一个。
   */
  let approvalChain: Promise<void> = Promise.resolve();
  const rawResolveApproval = opts.resolveToolApproval;
  const resolveToolApproval = rawResolveApproval
    ? (input: ToolApprovalInput): Promise<boolean> => {
        const p = approvalChain.then(() => rawResolveApproval(input));
        approvalChain = p.then(
          () => undefined,
          () => undefined,
        );
        return p;
      }
    : undefined;

  const planSnapshotMaxItems =
    opts.planSnapshotMaxItems !== undefined
      ? opts.planSnapshotMaxItems
      : resolvePlanSnapshotMaxItems(workspaceRoot);

  const mcpServers = opts.mcpServers ?? loadMcpServers(workspaceRoot);

  const costTracker = new CostTracker();
  const todoStore = new InMemoryTodoStore();
  const watcher = new WorkspaceWatcher(workspaceRoot);
  watcher.start();

  // Agent 注册表（种子 + 用户定义）
  const agentRegistry = loadAgentRegistry(workspaceRoot);
  const rootId = opts.rootAgentId ?? "lihua";
  const rootSpec = agentRegistry.get(rootId) ?? agentRegistry.getRoot();

  const mainModel =
    rootSpec && opts.workspaceRoot
      ? (resolveModelForSpec(rootSpec, workspaceRoot) ??
        createDefaultLanguageModel(workspaceRoot))
      : createDefaultLanguageModel(workspaceRoot);
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
    maxSteps: 12,
    agentRegistry,
    // 子 Agent 走同一（已串行化）审批通道：编码犬的写文件/改 patch 也会进审批门
    resolveToolApproval,
    approvalPolicy: opts.approvalPolicy,
  });

  const createAgent = (input: {
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
  }) => {
    const payload: CreateAgentInput = {
      id: input.id,
      name: input.name,
      role: input.role,
      prompt: input.prompt,
      tools: input.tools ?? "inherit",
      childPolicy: input.childPolicy ?? "read_only",
      model: input.model ?? "inherit",
      outputFormat: input.outputFormat,
      emoji: input.emoji,
      description: input.description,
      kind: "worker",
      canSpawn: false,
      memoryExtraction: "off",
      maxSteps: 12,
    };
    return createAgentInRegistry(agentRegistry, payload, {
      overwrite: input.overwrite === true,
    });
  };

  const rootAllowed = rootSpec ? allowedToolsForSpec(rootSpec) : null;
  // root 总控必须能 run_agent + create_agent
  let allowedTools = rootAllowed;
  if (allowedTools) {
    const set = new Set(allowedTools);
    set.add("workspace.run_agent");
    set.add("workspace.create_agent");
    allowedTools = [...set];
  }

  const orch = new AgentOrchestrator({
    model: mainModel,
    auxiliaryModel: subAgentModel,
    skillsDir: opts.skillsDir,
    resolveAskUser: opts.resolveAskUser,
    resolveToolApproval,
    approvalPolicy: opts.approvalPolicy,
    subAgentLauncher,
    appStateStore,
    sessionStore,
    costTracker,
    todoStore,
    watcher,
    mcpServers,
    planSnapshotMaxItems,
    memoryExtraction:
      opts.memoryExtraction ?? rootSpec?.memoryExtraction ?? "background",
    onEvent: opts.onEvent,
    allowedTools,
    agentCatalogText: agentRegistry.catalogText(),
    agentIdentityText: rootSpec
      ? `${rootSpec.emoji ? rootSpec.emoji + " " : ""}${rootSpec.name}（${rootSpec.role}）\n${rootSpec.prompt}`
      : undefined,
    createAgent,
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
    agentRegistry,
    rootMaxSteps: rootSpec?.maxSteps,
  };
}
