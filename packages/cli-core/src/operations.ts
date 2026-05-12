import path from "node:path";

import {
  AgentOrchestrator,
  type AskUserResolveInput,
  type ToolApprovalInput,
  resolvePlanSnapshotMaxItems,
} from "@paw/agent";
import { CostTracker } from "@paw/core";
import type { RunEventEnvelope, RunResult } from "@paw/core";
import {
  defaultSettingsPath,
  loadPawSettingsLocal,
  redactSettingsForDisplay,
} from "@paw/settings";
import { listWorkspaceFiles, readWorkspaceFile, WorkspaceWatcher } from "@paw/workspace";
import type { McpServerConfig } from "@paw/harness";
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
   * `begin()`’s signal into the run. Ignores {@link StubRunOptions.abortSignal}.
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
  const watcher = new WorkspaceWatcher(workspaceRoot);
  watcher.start();
  const orch = new AgentOrchestrator({
    onEvent: options?.onEvent,
    planSnapshotMaxItems,
    resolveAskUser: options?.resolveAskUser,
    resolveToolApproval: options?.resolveToolApproval,
    approvalPolicy: options?.approvalPolicy,
    mcpServers,
    costTracker,
    watcher,
  });
  const runId = options?.runId ?? `stub-${Date.now()}`;
  const base = {
    runId,
    goal,
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
  let workspaceRoot = path.resolve(
    options?.workspaceRoot?.trim() ? options.workspaceRoot : ".",
  );

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
