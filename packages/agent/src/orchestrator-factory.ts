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
  resolveAllowedTools,
  resolveModelForSpec,
} from "./agents/index.js";
import { createAutonomyProfile } from "./autonomy/profile.js";
import {
  type CollaborationMode,
  resolveCollaborationMode,
} from "./collaboration-mode.js";
import type { ToolExecutionPolicy } from "./execution-policy.js";
import {
  type LifecycleBudget,
  resolveLifecycleBudget,
} from "./lifecycle/budget.js";
import type { VerificationPolicy } from "./lifecycle/verification-gate.js";
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
  readonly toolExecutionPolicy?: ToolExecutionPolicy;
  readonly verificationPolicy?: VerificationPolicy;
  /**
   * Autonomy profile (default headless for CLI/eval long-runs).
   * When set, merges resolvers + applies shell policy unless explicit
   * resolveToolApproval / resolveAskUser overrides are provided for interactive.
   */
  readonly autonomy?:
    | import("./autonomy/profile.js").AutonomyLevel
    | import("./autonomy/profile.js").AutonomyProfileOptions;
  /** Lifecycle budgets (steps / child steps / idle fuse). */
  readonly budget?: Partial<LifecycleBudget>;
  readonly mcpServers?: readonly McpServerConfig[];
  readonly planSnapshotMaxItems?: number;
  readonly memoryExtraction?: "background" | "await" | "off";
  readonly onEvent?: (envelope: RunEventEnvelope) => void;
  /**
   * Collaboration mode (default coding = single long-run agent).
   * orchestrated = 狸花 + 花名册. Also readable from settings.agent_mode.
   */
  readonly collaborationMode?: CollaborationMode;
  /**
   * Root Agent id. In orchestrated mode defaults to lihua.
   * In coding mode ignored (uses coding identity + full loop).
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
  /** Effective root maxSteps for callers that did not pass an explicit value */
  readonly rootMaxSteps?: number;
  /** Resolved collaboration mode (coding | orchestrated). */
  readonly collaborationMode: CollaborationMode;
}

function loadWorkspaceSettings(
  workspaceRoot: string,
): Record<string, unknown> | undefined {
  try {
    return loadPawSettingsLocal(defaultSettingsPath(workspaceRoot)) as Record<
      string,
      unknown
    >;
  } catch {
    return undefined;
  }
}

function loadMcpServers(
  workspaceRoot: string,
  settings?: Record<string, unknown>,
): readonly McpServerConfig[] | undefined {
  try {
    const s =
      settings ??
      (loadPawSettingsLocal(defaultSettingsPath(workspaceRoot)) as Record<
        string,
        unknown
      >);
    const mcpServers = s.mcp_servers as unknown[] | undefined;
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

  const settings = loadWorkspaceSettings(workspaceRoot);
  const collab = resolveCollaborationMode({
    collaborationMode: opts.collaborationMode,
    rootAgentId: opts.rootAgentId,
    settings,
  });

  // AutonomyProfile: default headless for long-run / eval; interactive when UI passes resolvers without autonomy override
  const autonomy = createAutonomyProfile(
    opts.autonomy ??
      (opts.resolveToolApproval || opts.resolveAskUser
        ? {
            level: "interactive",
            resolveToolApproval: opts.resolveToolApproval,
            resolveAskUser: opts.resolveAskUser,
            approvalPolicy: opts.approvalPolicy,
          }
        : "headless"),
  );
  autonomy.apply();

  const budget = resolveLifecycleBudget({
    ...collab.defaultBudget,
    ...opts.budget,
  });

  /**
   * 审批回调串行化：根 Agent 与并行子 Agent 共享同一审批通道。
   * 若并发调用，单槽 UI（TUI footer / 桌面审批卡）会互相覆盖导致 Promise 泄漏，
   * 这里用 Promise 链强制排队，一次只问一个。
   */
  let approvalChain: Promise<void> = Promise.resolve();
  const rawResolveApproval =
    opts.resolveToolApproval ?? autonomy.resolveToolApproval;
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
  const resolveAskUser = opts.resolveAskUser ?? autonomy.resolveAskUser;
  const approvalPolicy = opts.approvalPolicy ?? autonomy.approvalPolicy;

  const planSnapshotMaxItems =
    opts.planSnapshotMaxItems !== undefined
      ? opts.planSnapshotMaxItems
      : resolvePlanSnapshotMaxItems(workspaceRoot);

  const mcpServers = opts.mcpServers ?? loadMcpServers(workspaceRoot, settings);

  const costTracker = new CostTracker();
  const todoStore = new InMemoryTodoStore();
  const watcher = new WorkspaceWatcher(workspaceRoot);
  watcher.start();

  // Agent 注册表（种子 + 用户定义）—— orchestrated 需要；coding 也 ensure 以便日后 /team
  const agentRegistry = loadAgentRegistry(workspaceRoot);
  const rootId = collab.rootAgentId;
  const rootSpec = rootId
    ? (agentRegistry.get(rootId) ?? agentRegistry.getRoot())
    : undefined;

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
    maxSteps: budget.childMaxSteps,
    agentRegistry,
    // 子 Agent 走同一（已串行化）审批通道：编码犬的写文件/改 patch 也会进审批门
    resolveToolApproval,
    approvalPolicy,
    toolExecutionPolicy: opts.toolExecutionPolicy,
    verificationPolicy: opts.verificationPolicy,
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
      maxSteps: budget.childMaxSteps,
    };
    return createAgentInRegistry(agentRegistry, payload, {
      overwrite: input.overwrite === true,
    });
  };

  let allowedTools: readonly string[] | null;
  if (collab.mode === "coding") {
    // Full builtin surface minus spawn — single agent does the loop itself.
    allowedTools = resolveAllowedTools({
      tools: "inherit",
      canSpawn: false,
    });
  } else {
    const rootAllowed = rootSpec ? allowedToolsForSpec(rootSpec) : null;
    allowedTools = rootAllowed;
    if (collab.forceSpawnTools && allowedTools) {
      const set = new Set(allowedTools);
      set.add("workspace.run_agent");
      set.add("workspace.create_agent");
      allowedTools = [...set];
    }
  }

  const identityText =
    collab.identityText ??
    (rootSpec
      ? `${rootSpec.emoji ? `${rootSpec.emoji} ` : ""}${rootSpec.name}（${rootSpec.role}）\n${rootSpec.prompt}`
      : undefined);

  const orch = new AgentOrchestrator({
    model: mainModel,
    auxiliaryModel: subAgentModel,
    skillsDir: opts.skillsDir,
    resolveAskUser,
    resolveToolApproval,
    approvalPolicy,
    toolExecutionPolicy: opts.toolExecutionPolicy,
    verificationPolicy: opts.verificationPolicy,
    subAgentLauncher: collab.canSpawn ? subAgentLauncher : undefined,
    appStateStore,
    sessionStore,
    costTracker,
    todoStore,
    watcher,
    mcpServers,
    planSnapshotMaxItems,
    memoryExtraction:
      opts.memoryExtraction ??
      (collab.mode === "coding"
        ? "background"
        : (rootSpec?.memoryExtraction ?? "background")),
    onEvent: opts.onEvent,
    allowedTools,
    agentCatalogText: collab.injectRoster
      ? agentRegistry.catalogText()
      : undefined,
    agentIdentityText: identityText,
    createAgent: collab.canSpawn ? createAgent : undefined,
  });

  const rootMaxSteps =
    opts.budget?.maxSteps ??
    (collab.mode === "coding"
      ? budget.maxSteps
      : (rootSpec?.maxSteps ?? budget.maxSteps));

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
    rootMaxSteps,
    collaborationMode: collab.mode,
  };
}
