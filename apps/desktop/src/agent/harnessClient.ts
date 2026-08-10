/**
 * 桌面 ↔ agent-host 一次性请求封装（复用 packages 能力，不重写业务）。
 */

import type {
  CheckpointRow,
  HostStatus,
  RunEventRow,
  RunSummaryRow,
} from "../vite-env";

function api() {
  return window.pawDesktop;
}

function waitForRequestId<T extends { requestId: string }>(
  requestId: string,
  subscribe: (cb: (payload: T) => void) => () => void,
  timeoutMs = 20_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error("请求超时"));
    }, timeoutMs);
    const off = subscribe((payload) => {
      if (payload.requestId !== requestId) return;
      clearTimeout(timer);
      off();
      resolve(payload);
    });
  });
}

export async function requestDoctor(workspaceRoot?: string): Promise<{
  ok: boolean;
  text: string;
}> {
  const desk = api();
  if (!desk?.doctor || !desk.onDoctorDone) {
    throw new Error("Doctor API 不可用");
  }
  const { requestId } = await desk.doctor({ workspaceRoot });
  if (!requestId) throw new Error("Doctor 未返回 requestId");
  const r = await waitForRequestId(requestId, desk.onDoctorDone);
  return { ok: r.ok, text: r.text };
}

export async function requestCheckpointList(
  runId: string,
  workspaceRoot?: string,
): Promise<{
  ok: boolean;
  runId: string;
  items: CheckpointRow[];
  error?: string;
}> {
  const desk = api();
  if (!desk?.listCheckpoints || !desk.onCheckpointListDone) {
    throw new Error("Checkpoint API 不可用");
  }
  const { requestId } = await desk.listCheckpoints({ runId, workspaceRoot });
  if (!requestId) throw new Error("checkpoint.list 未返回 requestId");
  return waitForRequestId(requestId, desk.onCheckpointListDone);
}

export async function requestCheckpointUndo(
  runId: string,
  workspaceRoot?: string,
): Promise<{
  ok: boolean;
  runId: string;
  restored: CheckpointRow | null;
  error?: string;
}> {
  const desk = api();
  if (!desk?.undoCheckpoint || !desk.onCheckpointUndoDone) {
    throw new Error("Checkpoint undo API 不可用");
  }
  const { requestId } = await desk.undoCheckpoint({ runId, workspaceRoot });
  if (!requestId) throw new Error("checkpoint.undo 未返回 requestId");
  return waitForRequestId(requestId, desk.onCheckpointUndoDone);
}

export async function requestRunsList(workspaceRoot?: string): Promise<{
  ok: boolean;
  items: RunSummaryRow[];
  error?: string;
}> {
  const desk = api();
  if (!desk?.listRuns || !desk.onRunsListDone) {
    throw new Error("Runs list API 不可用");
  }
  const { requestId } = await desk.listRuns({ workspaceRoot });
  if (!requestId) throw new Error("runs.list 未返回 requestId");
  return waitForRequestId(requestId, desk.onRunsListDone);
}

export async function requestRunLoad(
  runId: string,
  opts?: { workspaceRoot?: string; limit?: number },
): Promise<{
  ok: boolean;
  runId: string;
  events: RunEventRow[];
  total: number;
  error?: string;
}> {
  const desk = api();
  if (!desk?.loadRun || !desk.onRunsLoadDone) {
    throw new Error("Runs load API 不可用");
  }
  const { requestId } = await desk.loadRun({
    runId,
    workspaceRoot: opts?.workspaceRoot,
    limit: opts?.limit,
  });
  if (!requestId) throw new Error("runs.load 未返回 requestId");
  return waitForRequestId(requestId, desk.onRunsLoadDone);
}

export async function requestHostStatus(
  workspaceRoot?: string,
): Promise<HostStatus & { ok: boolean; error?: string }> {
  const desk = api();
  if (!desk?.fetchStatus || !desk.onStatusDone) {
    throw new Error("Status API 不可用");
  }
  const { requestId } = await desk.fetchStatus({ workspaceRoot });
  if (!requestId) throw new Error("status 未返回 requestId");
  const r = await waitForRequestId(requestId, desk.onStatusDone);
  return {
    ok: r.ok,
    workspaceRoot: r.workspaceRoot,
    modelLabel: r.modelLabel,
    skillsCount: r.skillsCount,
    skillsDir: r.skillsDir,
    ...(typeof r.agentsCount === "number"
      ? { agentsCount: r.agentsCount }
      : {}),
    ...(Array.isArray(r.agents) ? { agents: r.agents } : {}),
    ...(r.error ? { error: r.error } : {}),
  };
}

export interface SettingsState {
  ok: boolean;
  provider?: string;
  approvalMode: "ask" | "auto";
  presets: { id: string; model: string; baseUrl?: string }[];
  error?: string;
}

export async function requestSettings(
  workspaceRoot?: string,
): Promise<SettingsState> {
  const desk = api();
  if (!desk?.getSettings || !desk.onSettingsDone) {
    throw new Error("Settings API 不可用");
  }
  const { requestId } = await desk.getSettings({ workspaceRoot });
  if (!requestId) throw new Error("settings.get 未返回 requestId");
  return waitForRequestId(requestId, desk.onSettingsDone);
}

export async function requestSetSettings(
  patch: { provider?: string; approvalMode?: "ask" | "auto" },
  workspaceRoot?: string,
): Promise<SettingsState> {
  const desk = api();
  if (!desk?.setSettings || !desk.onSettingsDone) {
    throw new Error("Settings API 不可用");
  }
  const { requestId } = await desk.setSettings({ ...patch, workspaceRoot });
  if (!requestId) throw new Error("settings.set 未返回 requestId");
  return waitForRequestId(requestId, desk.onSettingsDone);
}
