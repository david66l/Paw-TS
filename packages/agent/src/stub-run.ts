import path from "node:path";
import {
  FileSystemAppStateStore,
  SessionMemoryStore,
  findPawRoot,
  isAppStateFinished,
} from "@paw/core";
import type { RunEventEnvelope, RunResult } from "@paw/core";
import type { McpServerConfig } from "@paw/harness";
import {
  defaultSettingsPath,
  loadPawSettingsLocal,
  redactSettingsForDisplay,
} from "@paw/settings";
import { listWorkspaceFiles, readWorkspaceFile } from "@paw/workspace";
import { createTemporaryWorktree } from "@paw/workspace";
import { createRunOrchestrator } from "./orchestrator-factory.js";
import type { AskUserResolveInput, ToolApprovalInput } from "./orchestrator.js";

export interface StubRunSession {
  readonly begin: () => AbortSignal;
  readonly end: () => void;
}

export interface StubRunOptions {
  readonly workspaceRoot?: string;
  readonly runId?: string;
  readonly onEvent?: (envelope: RunEventEnvelope) => void;
  readonly maxSteps?: number;
  readonly planSnapshotMaxItems?: number;
  readonly abortSignal?: AbortSignal;
  readonly runSession?: StubRunSession;
  readonly resolveAskUser?: (input: AskUserResolveInput) => Promise<string>;
  readonly resolveToolApproval?: (input: ToolApprovalInput) => Promise<boolean>;
  readonly approvalPolicy?: (tool: string) => boolean | undefined;
  readonly resultTextFormat?: "json" | "minimal";
  readonly mcpServers?: readonly McpServerConfig[];
  readonly useWorktree?: boolean;
  readonly resumeSession?: boolean;
  readonly skillsDir?: string;
}

export type { AskUserResolveInput, ToolApprovalInput };

function formatStubRunResult(
  result: RunResult,
  format: "json" | "minimal",
): { ok: boolean; text: string; exitCode: number } {
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

function buildSessionContext(workspaceRoot: string): string | null {
  try {
    const sessionStore = new SessionMemoryStore({ workspaceRoot });
    const latest = sessionStore.loadLatest();
    if (!latest) return null;
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

function buildAppStateContext(workspaceRoot: string): string | null {
  try {
    const statesDir = path.join(workspaceRoot, ".paw", "states");
    const stateStore = new FileSystemAppStateStore({ statesDir });
    const list = stateStore.list();
    if (list.length === 0) return null;
    const latest = list.find((s) => !isAppStateFinished(s)) ?? list[0];
    if (!latest) return null;
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
  const { orch, watcher } = createRunOrchestrator({
    workspaceRoot,
    skillsDir: options?.skillsDir,
    resolveAskUser: options?.resolveAskUser,
    resolveToolApproval: options?.resolveToolApproval,
    approvalPolicy: options?.approvalPolicy,
    mcpServers: options?.mcpServers,
    planSnapshotMaxItems: options?.planSnapshotMaxItems,
    onEvent: options?.onEvent,
  });

  let effectiveGoal = goal;
  if (options?.resumeSession !== false) {
    const sessionCtx = buildSessionContext(workspaceRoot);
    const stateCtx = buildAppStateContext(workspaceRoot);
    const contextParts = [sessionCtx, stateCtx].filter(Boolean);
    if (contextParts.length > 0) {
      effectiveGoal = `${contextParts.join("\n\n")}\n\n[Current user request]\n${goal}`;
    }
  }

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
        const result = await orch.run({ ...base, abortSignal: signal });
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

export async function runStubRun(
  goal: string,
  options?: StubRunOptions,
): Promise<{ ok: boolean; text: string; exitCode: number }> {
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
    return { ok: false, text: e instanceof Error ? e.message : String(e) };
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
