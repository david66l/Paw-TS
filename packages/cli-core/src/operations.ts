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
  SessionMemoryStore,
  findPawRoot,
  isAppStateFinished,
} from "@paw/core";
import type { RunEventEnvelope, RunResult } from "@paw/core";
import type { McpServerConfig } from "@paw/harness";
import { createDeepSeekFlashModel, createDefaultLanguageModel } from "@paw/models";
import {
  defaultSettingsPath,
  loadPawSettingsLocal,
  redactSettingsForDisplay,
} from "@paw/settings";
import {
  WorkspaceWatcher,
  listWorkspaceFiles,
  readWorkspaceFile,
} from "@paw/workspace";
import { createTemporaryWorktree } from "./worktree.js";

export function formatDoctorOutput(root: string): {
  ok: boolean;
  text: string;
} {
  const settingsPath = defaultSettingsPath(root);
  try {
    const s = loadPawSettingsLocal(settingsPath);
    const text = [
      `workspace: ${root}`,
      `settings:  ${settingsPath}`,
      JSON.stringify(redactSettingsForDisplay(s), null, 2),
    ].join("\n");
    return { ok: true, text };
  } catch (e) {
    return {
      ok: false,
      text: e instanceof Error ? e.message : String(e),
    };
  }
}

export function formatFsReadOutput(
  root: string,
  rel: string,
): { ok: boolean; text: string } {
  const r = readWorkspaceFile(root, rel);
  const text = JSON.stringify(r, null, 2);
  return { ok: !r.error, text };
}

export function formatFsListOutput(
  root: string,
  dir: string,
  recursive: boolean,
): { ok: boolean; text: string } {
  const r = listWorkspaceFiles(root, dir, { recursive });
  const text = JSON.stringify(r, null, 2);
  return { ok: !r.error, text };
}

/**
 * Optional bracket around `runStubRun` / orchestrator: `begin()` yields the
 * `AbortSignal` for that run; `end()` runs in `finally` (success, failure, or abort).
 */
export interface StubRunSession {
  readonly begin: () => AbortSignal;
  readonly end: () => void;
}

export interface StubRunOptions {
  readonly workspaceRoot?: string;
  readonly runId?: string;
  readonly onEvent?: (envelope: RunEventEnvelope) => void;
  /** Cap model rounds; when omitted, orchestrator uses settings / default. */
  readonly maxSteps?: number;
  /**
   * Overrides `plan_snapshot_max_items` from `.paw/settings.local.json` for
   * {@link AgentOrchestrator} plan snapshots after `plan_update`.
   */
  readonly planSnapshotMaxItems?: number;
  readonly abortSignal?: AbortSignal;
  /**
   * When set, wraps the orchestrator call: pairs `begin`/`end` and passes
   * `begin()`'s signal into the run. Ignores {@link StubRunOptions.abortSignal}.
   */
  readonly runSession?: StubRunSession;
  /** Passed to {@link AgentOrchestrator} — interactive ask-user continuation. */
  readonly resolveAskUser?: (input: AskUserResolveInput) => Promise<string>;
  /** Passed to {@link AgentOrchestrator} — gate risky tools before execution. */
  readonly resolveToolApproval?: (input: ToolApprovalInput) => Promise<boolean>;
  readonly approvalPolicy?: (tool: string) => boolean | undefined;
  /**
   * Returned `text` shape for the caller.
   * - `json` (default): full {@link RunResult} as JSON (`paw-ts stub-run` CLI).
   * - `minimal`: empty on success; human message only on failure / unimplemented (TUI).
   */
  readonly resultTextFormat?: "json" | "minimal";
  /**
   * MCP server configurations to expose as tools during the run.
   * When omitted, the runner attempts to read `mcp_servers` from `.paw/settings.local.json`.
   */
  readonly mcpServers?: readonly McpServerConfig[];
  /**
   * When true, create a temporary git worktree from the repo containing
   * `workspaceRoot`, run the agent inside it, and clean up on exit.
   * Throws if `workspaceRoot` is not inside a git repository.
   */
  readonly useWorktree?: boolean;
  /**
   * When true, load previous session memory and inject it as context
   * so the model remembers what was done in previous runs.
   */
  readonly resumeSession?: boolean;
  /**
   * Directory to load skills from (recursively, `.json` files).
   * Passed to {@link AgentOrchestrator} so the model can use `workspace.run_skill`.
   */
  readonly skillsDir?: string;
}

export type { AskUserResolveInput, ToolApprovalInput };

function formatStubRunResult(
  result: RunResult,
  format: "json" | "minimal",
): {
  ok: boolean;
  text: string;
  exitCode: number;
} {
  const exitCode =
    result.status === "failed" ? 1 : result.status === "unimplemented" ? 3 : 0;
  const ok = result.status !== "failed";
  if (format === "minimal") {
    if (result.status === "failed" || result.status === "unimplemented") {
      return { ok, text: result.message, exitCode };
    }
    return { ok, text: "", exitCode };
  }
  const text = JSON.stringify(result, null, 2);
  return { ok, text, exitCode };
}

/**
 * Build a context prefix from the most recent session memory, so the model
 * understands what was discussed in previous runs.
 */
function buildSessionContext(workspaceRoot: string): string | null {
  try {
    const sessionStore = new SessionMemoryStore({ workspaceRoot });
    const latest = sessionStore.loadLatest();
    if (!latest) return null;

    // Skip useless compaction meta-summaries (e.g. "Compressing a conversation...")
    const task = latest.task ?? "";
    const isGarbage =
      task.includes("Compressing a conversation") ||
      task.includes("Compression") ||
      (!latest.currentState &&
        !latest.keyDecisions?.length &&
        !latest.filesAndFunctions?.length);
    if (isGarbage) return null;

    const parts: string[] = [];
    if (latest.task) parts.push(`Previous task: ${latest.task}`);
    if (latest.currentState)
      parts.push(`Previous progress: ${latest.currentState}`);
    if (latest.keyDecisions?.length)
      parts.push(`Key decisions: ${latest.keyDecisions.join("; ")}`);
    if (latest.filesAndFunctions?.length)
      parts.push(`Files: ${latest.filesAndFunctions.join(", ")}`);

    if (parts.length === 0) return null;
    return `[Background: what you worked on with the user previously. The user has a NEW request below — act on it.]\n${parts.join("\n")}`;
  } catch {
    return null;
  }
}

/**
 * Build a context prefix from the most recent app state that has useful context.
 * Includes previous goal, plan, and progress even from completed runs.
 */
function buildAppStateContext(workspaceRoot: string): string | null {
  try {
    const statesDir = path.join(workspaceRoot, ".paw", "states");
    const stateStore = new FileSystemAppStateStore({ statesDir });
    const list = stateStore.list();
    if (list.length === 0) return null;

    // list() is sorted newest-first; prefer unfinished runs, but also
    // accept finished runs that still have a plan or meaningful history
    const latest = list.find((s) => !isAppStateFinished(s)) ?? list[0];
    if (!latest) return null;

    // Skip runs that finished trivially (no plan, few messages)
    const hasPlan = latest.plan && latest.plan.items.length > 0;
    const hasHistory = latest.messages && latest.messages.length > 3;
    if (!hasPlan && !hasHistory) return null;

    const parts: string[] = [];
    parts.push(`Previous goal: ${latest.goal}`);
    parts.push(`Progress: reached turn ${latest.turn}/${latest.maxSteps}`);

    if (hasPlan) {
      const planItems = (
        latest.plan?.items as Array<{
          id?: string;
          content?: string;
          status?: string;
        }>
      ).map(
        (item) =>
          `  [${item.status ?? "pending"}] ${item.content ?? item.id ?? "?"}`,
      );
      parts.push(`Plan from previous session:\n${planItems.join("\n")}`);
    }

    // Summarize what was accomplished without saying "completed"
    // (which would make the model think the task is done and stop)
    if (latest.outcome) {
      const summary = latest.outcome.message?.slice(0, 300) ?? "";
      if (summary) {
        parts.push(`Previous session ended with: ${summary}`);
      }
    }

    return `[Background: this is context from your previous conversation with the user. The user has a NEW request below — take action on it, do NOT just describe what happened before.]\n${parts.join("\n")}`;
  } catch {
    return null;
  }
}

async function doRun(
  goal: string,
  workspaceRoot: string,
  options: StubRunOptions | undefined,
): Promise<{ ok: boolean; text: string; exitCode: number }> {
  const planSnapshotMaxItems =
    options?.planSnapshotMaxItems !== undefined
      ? options.planSnapshotMaxItems
      : resolvePlanSnapshotMaxItems(workspaceRoot);
  let mcpServers = options?.mcpServers;
  if (!mcpServers) {
    try {
      const settings = loadPawSettingsLocal(defaultSettingsPath(workspaceRoot));
      if (settings.mcp_servers && settings.mcp_servers.length > 0) {
        mcpServers = settings.mcp_servers as McpServerConfig[];
      }
    } catch {
      // settings file may not exist; ignore
    }
  }

  const costTracker = new CostTracker();
  const todoStore = new InMemoryTodoStore();
  const watcher = new WorkspaceWatcher(workspaceRoot);
  watcher.start();

  // Create models: main = pro, sub-agent = flash (for deepseek)
  const mainModel = createDefaultLanguageModel(workspaceRoot);
  const subAgentModel =
    createDeepSeekFlashModel(workspaceRoot) ?? mainModel;

  // Wire up persistence stores so conversation state survives across runs
  const sessionStore = new FileSystemSessionStore({ workspaceRoot });
  const appStateStore = new FileSystemAppStateStore({
    statesDir: path.join(workspaceRoot, ".paw", "states"),
  });
  const subAgentLauncher = new DefaultSubAgentLauncher({
    workspaceRoot,
    model: mainModel,
    subAgentModel,
    maxSteps: 5,
  });

  // Inject previous session context into the goal if resume is enabled
  let effectiveGoal = goal;
  if (options?.resumeSession !== false) {
    const sessionCtx = buildSessionContext(workspaceRoot);
    const stateCtx = buildAppStateContext(workspaceRoot);
    const contextParts = [sessionCtx, stateCtx].filter(Boolean);
    if (contextParts.length > 0) {
      effectiveGoal = `${contextParts.join("\n\n")}\n\n[Current user request]\n${goal}`;
    }
  }

  const orch = new AgentOrchestrator({
    model: mainModel,
    auxiliaryModel: subAgentModel ?? mainModel,
    onEvent: options?.onEvent,
    planSnapshotMaxItems,
    resolveAskUser: options?.resolveAskUser,
    resolveToolApproval: options?.resolveToolApproval,
    approvalPolicy: options?.approvalPolicy,
    mcpServers,
    costTracker,
    todoStore,
    watcher,
    sessionStore,
    appStateStore,
    subAgentLauncher,
    skillsDir: options?.skillsDir,
  });
  const runId = options?.runId ?? `stub-${Date.now()}`;
  const base = {
    runId,
    goal: effectiveGoal,
    workspaceRoot,
    maxSteps: options?.maxSteps,
  };

  const resultFormat = options?.resultTextFormat ?? "json";

  try {
    const rs = options?.runSession;
    if (rs) {
      const signal = rs.begin();
      try {
        const result = await orch.run({
          ...base,
          abortSignal: signal,
        });
        return formatStubRunResult(result, resultFormat);
      } finally {
        rs.end();
      }
    }

    const result = await orch.run({
      ...base,
      abortSignal: options?.abortSignal,
    });
    return formatStubRunResult(result, resultFormat);
  } finally {
    watcher.stop();
  }
}

/** Same execution path as `paw-ts stub-run` (AgentOrchestrator). */
export async function runStubRun(
  goal: string,
  options?: StubRunOptions,
): Promise<{ ok: boolean; text: string; exitCode: number }> {
  // Auto-detect paw root: walk up from given or cwd to find .paw/.
  const workspaceRoot = (() => {
    const given = options?.workspaceRoot?.trim()
      ? path.resolve(options.workspaceRoot)
      : path.resolve(".");
    return findPawRoot(given) ?? given;
  })();

  if (options?.useWorktree) {
    const wt = createTemporaryWorktree(workspaceRoot);
    try {
      return await doRun(goal, wt.worktreeRoot, options);
    } finally {
      wt.cleanup();
    }
  }

  return doRun(goal, workspaceRoot, options);
}
