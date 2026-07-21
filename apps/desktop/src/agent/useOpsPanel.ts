/**
 * 右栏 Ops：Checkpoints + Run 历史（复用 harnessClient）。
 */

import { useCallback, useEffect, useState } from "react";
import type { CheckpointRow, RunEventRow, RunSummaryRow } from "../vite-env";
import {
  requestCheckpointList,
  requestCheckpointUndo,
  requestDoctor,
  requestHostStatus,
  requestRunLoad,
  requestRunsList,
} from "./harnessClient";

export function useOpsPanel(opts: {
  readonly lastRunId: string | null;
  readonly hostReady: boolean;
  readonly workspaceRoot?: string;
}) {
  const { lastRunId, hostReady, workspaceRoot } = opts;

  const [modelLabel, setModelLabel] = useState<string>("—");
  const [skillsCount, setSkillsCount] = useState(0);
  const [checkpoints, setCheckpoints] = useState<CheckpointRow[]>([]);
  const [checkpointRunId, setCheckpointRunId] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunSummaryRow[]>([]);
  const [replayRunId, setReplayRunId] = useState<string | null>(null);
  const [replayEvents, setReplayEvents] = useState<RunEventRow[]>([]);
  const [replayTotal, setReplayTotal] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [doctorText, setDoctorText] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    if (!hostReady) return;
    try {
      const r = await requestHostStatus(workspaceRoot);
      if (r.ok) {
        setModelLabel(r.modelLabel);
        setSkillsCount(r.skillsCount);
      }
    } catch {
      /* ignore */
    }
  }, [hostReady, workspaceRoot]);

  const refreshCheckpoints = useCallback(
    async (runId?: string | null) => {
      const id = (runId ?? lastRunId)?.trim();
      if (!id || !hostReady) {
        setCheckpoints([]);
        setCheckpointRunId(id || null);
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const r = await requestCheckpointList(id, workspaceRoot);
        setCheckpointRunId(id);
        if (!r.ok) {
          setError(r.error ?? "checkpoint.list 失败");
          setCheckpoints([]);
        } else {
          setCheckpoints(r.items);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [hostReady, lastRunId, workspaceRoot],
  );

  const undoLast = useCallback(async () => {
    const id = (checkpointRunId ?? lastRunId)?.trim();
    if (!id || !hostReady) {
      setError("没有 runId，无法 undo");
      return null as CheckpointRow | null;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await requestCheckpointUndo(id, workspaceRoot);
      if (!r.ok || !r.restored) {
        setError(r.error ?? "没有可撤销的检查点");
        return null;
      }
      await refreshCheckpoints(id);
      return r.restored;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setBusy(false);
    }
  }, [checkpointRunId, lastRunId, hostReady, workspaceRoot, refreshCheckpoints]);

  const refreshRuns = useCallback(async () => {
    if (!hostReady) return;
    setBusy(true);
    setError(null);
    try {
      const r = await requestRunsList(workspaceRoot);
      if (!r.ok) {
        setError(r.error ?? "runs.list 失败");
        setRuns([]);
      } else {
        setRuns(r.items);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [hostReady, workspaceRoot]);

  const loadReplay = useCallback(
    async (runId: string) => {
      if (!hostReady || !runId.trim()) return;
      setBusy(true);
      setError(null);
      try {
        const r = await requestRunLoad(runId.trim(), {
          workspaceRoot,
          limit: 120,
        });
        if (!r.ok) {
          setError(r.error ?? "runs.load 失败");
          setReplayEvents([]);
          setReplayTotal(0);
          setReplayRunId(runId);
        } else {
          setReplayRunId(r.runId);
          setReplayEvents(r.events);
          setReplayTotal(r.total);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [hostReady, workspaceRoot],
  );

  const runDoctor = useCallback(async () => {
    if (!hostReady) return;
    setBusy(true);
    setError(null);
    try {
      const r = await requestDoctor(workspaceRoot);
      setDoctorText(r.text);
      if (!r.ok) setError("Doctor 报告存在问题（见下方）");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [hostReady, workspaceRoot]);

  useEffect(() => {
    if (!hostReady) return;
    void refreshStatus();
  }, [hostReady, refreshStatus]);

  useEffect(() => {
    if (!hostReady || !lastRunId) return;
    void refreshCheckpoints(lastRunId);
  }, [hostReady, lastRunId, refreshCheckpoints]);

  return {
    modelLabel,
    skillsCount,
    checkpoints,
    checkpointRunId,
    runs,
    replayRunId,
    replayEvents,
    replayTotal,
    busy,
    error,
    doctorText,
    refreshStatus,
    refreshCheckpoints,
    undoLast,
    refreshRuns,
    loadReplay,
    runDoctor,
  };
}
