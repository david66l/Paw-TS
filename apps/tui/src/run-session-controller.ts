/**
 * TUI-only: serializes Enter submissions and exposes {@link StubRunSession} for
 * Ctrl+C abort. Pairing of begin/end for stub-run lives in `@paw/cli-core` {@link runStubRun}.
 *
 * Also provides {@link createPersistentSession} for Claude Code-style persistent
 * conversations where context carries across user inputs.
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

export interface RunSessionController {
  /** True if Enter already dispatched a line and it has not finished. */
  readonly isSubmissionBusy: () => boolean;
  /** Start handling one submitted line; false if another is still running. */
  readonly tryBeginSubmission: () => boolean;
  readonly endSubmission: () => void;
  /** Passed through {@link submitUserLine} → {@link runStubRun}. */
  readonly runSession: StubRunSession;
  /** Abort active stub-run if any; returns whether an abort was sent. */
  readonly abortIfRunning: () => boolean;
}

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

// ── Persistent session (Claude Code-style) ──────────────────────────

export interface PersistentSessionOptions {
  readonly workspaceRoot: string;
  readonly skillsDir?: string;
  readonly model?: LanguageModel;
  readonly maxSteps?: number;
  /** Ask-user bridge — same as StubRunOptions.resolveAskUser. */
  readonly resolveAskUser?: (input: {
    question: string;
    timeoutSec: number | null;
  }) => Promise<string>;
  /** Tool-approval bridge — same as StubRunOptions.resolveToolApproval. */
  readonly resolveToolApproval?: (input: {
    tool: string;
    args: unknown;
  }) => Promise<boolean>;
  readonly approvalPolicy?: (tool: string) => boolean | undefined;
  /** Event callback — forwards orchestrator events to the TUI stream. */
  readonly onEvent?: (envelope: import("@paw/core").RunEventEnvelope) => void;
}

export interface PersistentSession {
  readonly orch: AgentOrchestrator;
  readonly runId: string;
  /** Model context window for HUD context bar (defaults to 128K). */
  readonly contextWindow: number;
  /** Submit user input (or expanded skill prompt). Returns when model completes this turn. */
  submit(input: string, abortSignal?: AbortSignal): Promise<RunResult>;
  /** Release watcher and other session resources. */
  dispose(): void;
}

function resolveSubAgentModel(
  workspaceRoot: string,
  mainModel: LanguageModel,
): LanguageModel {
  return createDeepSeekFlashModel(workspaceRoot) ?? mainModel;
}

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
    /* ignore */
  }
  return undefined;
}

export function createPersistentSession(
  opts: PersistentSessionOptions,
): PersistentSession {
  const maxSteps = opts.maxSteps ?? 40;
  const runId = `session-${Date.now()}`;
  const workspaceRoot = opts.workspaceRoot;

  const appStateStore = new FileSystemAppStateStore({
    statesDir: path.join(workspaceRoot, ".paw", "states"),
  });
  const sessionStore = new FileSystemSessionStore({ workspaceRoot });
  const costTracker = new CostTracker();
  const todoStore = new InMemoryTodoStore();
  const watcher = new WorkspaceWatcher(workspaceRoot);
  watcher.start();

  const mainModel = opts.model ?? createDefaultLanguageModel(workspaceRoot);
  const subAgentModel = resolveSubAgentModel(workspaceRoot, mainModel);
  const mcpServers = loadMcpServers(workspaceRoot);
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
