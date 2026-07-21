import { useCallback, useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PlanItem {
  id: string;
  text: string;
  status?: string;
}

export interface PlanState {
  revision?: number;
  reason?: string;
  items: PlanItem[];
}

// ---------------------------------------------------------------------------
// Plan 进度可视化纯逻辑
// ---------------------------------------------------------------------------

/** 与 @paw/store PlanItemStatus 对齐的完成判定（completed/skipped 计入进度） */
function isPlanItemDone(status: string | undefined): boolean {
  return status === "completed" || status === "done" || status === "skipped";
}

/** 计划进度：done/total + 百分比（0-100） */
export function planProgress(items: readonly PlanItem[]): {
  done: number;
  total: number;
  pct: number;
} {
  const total = items.length;
  const done = items.filter((i) => isPlanItemDone(i.status)).length;
  return {
    done,
    total,
    pct: total > 0 ? Math.round((done / total) * 100) : 0,
  };
}

/** 当前步骤 id：第一个 running；无 running 则第一个未完成项；全部完成返回 null */
export function currentPlanItemId(items: readonly PlanItem[]): string | null {
  const running = items.find((i) => i.status === "running");
  if (running) return running.id;
  const next = items.find((i) => !isPlanItemDone(i.status));
  return next ? next.id : null;
}

export interface ChangeEntry {
  path: string;
  tool: string;
  ok?: boolean;
  summary?: string;
  /** 结构化 diff 统计（来自 tool.result 的 fileChanges） */
  added?: number;
  removed?: number;
  at: number;
}

export interface ContextSnapshot {
  turn?: number;
  maxSteps?: number;
  estimatedTokens?: number;
  /** 本 run 触达的相关路径（读/写），供 Context 面板展示 */
  recentFiles?: readonly string[];
  budget?: {
    contextWindow: number;
    systemUsed: number;
    systemBudget: number;
    toolsUsed: number;
    toolsBudget: number;
    historyUsed: number;
    historyBudget: number;
  };
  cost?: {
    totalTokens: number;
    estimatedCostUsd: number;
    promptTokens: number;
    completionTokens: number;
  };
}

export interface MemoryHit {
  id: string;
  title: string;
  summary: string;
  type?: string;
  score?: number;
  source?: string;
}

export interface MemoryLibraryItem {
  id: string;
  title: string;
  summary: string;
  type: string;
  status: string;
  confidence: number;
  updatedAt?: string;
}

export interface MemorySnapshot {
  selectedCount: number;
  query: string;
  totalCandidates: number;
  /** 本 run 检索注入的条目 */
  sessionHits: MemoryHit[];
  /** 工作区总库 */
  library: MemoryLibraryItem[];
  libraryOk: boolean | null;
  libraryError?: string;
  libraryLoading?: boolean;
}

export interface RightPanelData {
  plan: PlanState;
  changes: ChangeEntry[];
  context: ContextSnapshot | null;
  memory: MemorySnapshot | null;
  refreshMemoryLibrary: () => void;
}

// ---------------------------------------------------------------------------
// Pure reducers (exported for testing)
// ---------------------------------------------------------------------------

/** Parse a plan item from the flexible union form emitted by plan_update. */
export function parsePlanItem(raw: unknown): PlanItem | null {
  if (typeof raw === "string") {
    const id = raw.length < 80 ? raw : raw.slice(0, 40);
    return { id, text: raw };
  }
  if (raw !== null && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const id = String(o.task_id ?? o.id ?? o.text ?? o.content ?? "");
    const text = String(o.text ?? o.content ?? o.task_id ?? o.id ?? "");
    if (!id && !text) return null;
    const status = typeof o.status === "string" ? o.status : undefined;
    return { id: id || text, text: text || id, status };
  }
  return null;
}

/** Merge plan_update items into the plan list. */
export function mergePlanItems(
  items: PlanItem[],
  newItems: readonly unknown[],
  deprecatedItems: readonly string[],
): PlanItem[] {
  const depSet = new Set(deprecatedItems);
  const next = items.filter((it) => !depSet.has(it.id));
  for (const raw of newItems) {
    const parsed = parsePlanItem(raw);
    if (!parsed) continue;
    const idx = next.findIndex((it) => it.id === parsed.id);
    if (idx >= 0) {
      next[idx] = parsed;
    } else {
      next.push(parsed);
    }
  }
  return next;
}

/** Try to extract a filesystem path from tool args. */
export function extractPathFromArgs(args: unknown): string | null {
  if (args === null || typeof args !== "object") return null;
  const o = args as Record<string, unknown>;
  for (const k of ["path", "relPath", "file", "file_path"]) {
    const v = o[k];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return null;
}

export function parseSelectedMemories(raw: unknown): MemoryHit[] {
  if (!Array.isArray(raw)) return [];
  const out: MemoryHit[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id : "";
    const title = typeof o.title === "string" ? o.title : "";
    if (!id && !title) continue;
    const summary =
      typeof o.summary === "string" && o.summary.trim() ? o.summary : title;
    out.push({
      id: id || title,
      title: title || id,
      summary,
      ...(typeof o.type === "string" ? { type: o.type } : {}),
      ...(typeof o.score === "number" ? { score: o.score } : {}),
      ...(typeof o.source === "string" ? { source: o.source } : {}),
    });
  }
  return out;
}

export function parseLibraryItems(raw: unknown): MemoryLibraryItem[] {
  if (!Array.isArray(raw)) return [];
  const out: MemoryLibraryItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id : "";
    const title = typeof o.title === "string" ? o.title : "";
    if (!id && !title) continue;
    out.push({
      id: id || title,
      title: title || id,
      summary: typeof o.summary === "string" ? o.summary : "",
      type: typeof o.type === "string" ? o.type : "unknown",
      status: typeof o.status === "string" ? o.status : "active",
      confidence: typeof o.confidence === "number" ? o.confidence : 0,
      ...(typeof o.updatedAt === "string" ? { updatedAt: o.updatedAt } : {}),
    });
  }
  return out;
}

const WRITE_TOOLS = new Set(["workspace.write_file", "workspace.edit_file"]);

const PATH_TOOLS = new Set([
  "workspace.write_file",
  "workspace.edit_file",
  "workspace.read_file",
  "workspace.list_dir",
]);

function isWriteTool(tool: string): boolean {
  return WRITE_TOOLS.has(tool);
}

function isPathTool(tool: string): boolean {
  return (
    PATH_TOOLS.has(tool) ||
    tool.includes("read_file") ||
    tool.includes("write_file") ||
    tool.includes("edit_file")
  );
}

function pushRecentPath(paths: string[], path: string, max = 24): string[] {
  const next = [path, ...paths.filter((p) => p !== path)];
  return next.slice(0, max);
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

function api() {
  return window.pawDesktop;
}

const emptyMemory = (): MemorySnapshot => ({
  selectedCount: 0,
  query: "",
  totalCandidates: 0,
  sessionHits: [],
  library: [],
  libraryOk: null,
});

export function useRightPanelData(): RightPanelData {
  const [plan, setPlan] = useState<PlanState>({ items: [] });
  const [changes, setChanges] = useState<ChangeEntry[]>([]);
  const [context, setContext] = useState<ContextSnapshot | null>(null);
  const [memory, setMemory] = useState<MemorySnapshot | null>(null);

  const changesRef = useRef<ChangeEntry[]>([]);
  const recentFilesRef = useRef<string[]>([]);
  const pendingListReq = useRef<string | null>(null);

  const reset = useCallback(() => {
    setPlan({ items: [] });
    changesRef.current = [];
    recentFilesRef.current = [];
    setChanges([]);
    setContext(null);
    // 保留总库；清空本 run 命中
    setMemory((prev) => ({
      ...emptyMemory(),
      library: prev?.library ?? [],
      libraryOk: prev?.libraryOk ?? null,
      libraryError: prev?.libraryError,
    }));
  }, []);

  const refreshMemoryLibrary = useCallback(() => {
    const desk = api();
    if (!desk?.listMemories) {
      setMemory((prev) => ({
        ...(prev ?? emptyMemory()),
        libraryOk: false,
        libraryError: "listMemories API 不可用（需重启桌面）",
        libraryLoading: false,
      }));
      return;
    }
    setMemory((prev) => ({
      ...(prev ?? emptyMemory()),
      libraryLoading: true,
      libraryError: undefined,
    }));
    void desk.listMemories({ limit: 40 }).then((r) => {
      if (r?.requestId) pendingListReq.current = r.requestId;
    });
  }, []);

  useEffect(() => {
    const desk = api();
    if (!desk) return;

    // 启动后拉一次总库
    const t = window.setTimeout(() => refreshMemoryLibrary(), 400);

    const offEvent = desk.onEvent(
      ({
        event: envelope,
      }: {
        requestId: string;
        event: { event?: { type?: string } & Record<string, unknown> };
      }) => {
        const ev = envelope?.event;
        if (!ev || typeof ev.type !== "string") return;
        const typ = ev.type;

        if (typ === "run.started") {
          reset();
          return;
        }

        if (typ === "plan.updated") {
          const revision =
            typeof ev.revision === "number" ? ev.revision : undefined;
          const itemCount =
            typeof ev.itemCount === "number" ? ev.itemCount : undefined;
          const reason = typeof ev.reason === "string" ? ev.reason : undefined;
          const rawItems = Array.isArray(ev.items) ? ev.items : null;

          setPlan((prev) => {
            if (rawItems) {
              const items = rawItems
                .map((x) => parsePlanItem(x))
                .filter((x): x is PlanItem => x !== null);
              return { revision, reason, items };
            }
            const items = itemCount === 0 ? [] : prev.items;
            return { ...prev, revision, reason, items };
          });
          return;
        }

        if (typ === "agent.action") {
          const action = ev.action as
            | {
                type?: string;
                newItems?: readonly unknown[];
                deprecatedItems?: readonly string[];
                reason?: string;
              }
            | undefined;
          if (action?.type === "plan_update") {
            const newItems: readonly unknown[] = Array.isArray(action.newItems)
              ? action.newItems
              : [];
            const deprecatedItems: readonly string[] = Array.isArray(
              action.deprecatedItems,
            )
              ? (action.deprecatedItems.filter(
                  (d: unknown) => typeof d === "string",
                ) as string[])
              : [];
            setPlan((prev) => ({
              ...prev,
              items: mergePlanItems(prev.items, newItems, deprecatedItems),
              reason:
                typeof action.reason === "string" ? action.reason : prev.reason,
            }));
          }
          return;
        }

        if (typ === "tool.call") {
          const tool = typeof ev.tool === "string" ? ev.tool : "";
          const path = extractPathFromArgs(ev.args);
          if (path && isPathTool(tool)) {
            recentFilesRef.current = pushRecentPath(
              recentFilesRef.current,
              path,
            );
            setContext((prev) => ({
              ...prev,
              recentFiles: [...recentFilesRef.current],
            }));
          }
          if (!isWriteTool(tool)) return;
          if (!path) return;
          const entry: ChangeEntry = {
            path,
            tool,
            at: Date.now(),
          };
          changesRef.current = [
            entry,
            ...changesRef.current.filter((c) => c.path !== path),
          ];
          setChanges([...changesRef.current]);
          return;
        }

        if (typ === "tool.result") {
          const tool = typeof ev.tool === "string" ? ev.tool : "";
          const ok = ev.ok !== false;
          const summary =
            typeof ev.summary === "string" ? ev.summary : undefined;
          const entry = changesRef.current.find(
            (c) => c.tool === tool && c.ok === undefined,
          );
          if (entry) {
            entry.ok = ok;
            if (summary !== undefined) entry.summary = summary;
            setChanges([...changesRef.current]);
          }
          // 结构化变更统计：按路径回填/新建条目（覆盖 apply_patch 等多文件情形）
          if (Array.isArray(ev.fileChanges)) {
            let touched = false;
            for (const fc of ev.fileChanges) {
              if (!fc || typeof fc !== "object") continue;
              const r = fc as Record<string, unknown>;
              if (typeof r.path !== "string") continue;
              const added = typeof r.added === "number" ? r.added : 0;
              const removed = typeof r.removed === "number" ? r.removed : 0;
              const existing = changesRef.current.find(
                (c) => c.path === r.path,
              );
              if (existing) {
                existing.added = (existing.added ?? 0) + added;
                existing.removed = (existing.removed ?? 0) + removed;
                existing.ok = ok;
                if (summary !== undefined) existing.summary = summary;
              } else {
                changesRef.current = [
                  {
                    path: r.path,
                    tool,
                    ok,
                    summary,
                    added,
                    removed,
                    at: Date.now(),
                  },
                  ...changesRef.current,
                ];
              }
              touched = true;
            }
            if (touched) setChanges([...changesRef.current]);
          }
          return;
        }

        if (typ === "loop.tick") {
          setContext((prev) => ({
            ...prev,
            turn: typeof ev.turn === "number" ? ev.turn : prev?.turn,
            maxSteps:
              typeof ev.maxSteps === "number" ? ev.maxSteps : prev?.maxSteps,
            estimatedTokens:
              typeof ev.estimatedTokens === "number"
                ? ev.estimatedTokens
                : prev?.estimatedTokens,
            recentFiles: recentFilesRef.current.length
              ? [...recentFilesRef.current]
              : prev?.recentFiles,
          }));
          return;
        }

        if (typ === "context.budget") {
          setContext((prev) => ({
            ...prev,
            budget: {
              contextWindow:
                typeof ev.contextWindow === "number" ? ev.contextWindow : 0,
              systemUsed: typeof ev.systemUsed === "number" ? ev.systemUsed : 0,
              systemBudget:
                typeof ev.systemBudget === "number" ? ev.systemBudget : 0,
              toolsUsed: typeof ev.toolsUsed === "number" ? ev.toolsUsed : 0,
              toolsBudget:
                typeof ev.toolsBudget === "number" ? ev.toolsBudget : 0,
              historyUsed:
                typeof ev.historyUsed === "number" ? ev.historyUsed : 0,
              historyBudget:
                typeof ev.historyBudget === "number" ? ev.historyBudget : 0,
            },
            recentFiles: recentFilesRef.current.length
              ? [...recentFilesRef.current]
              : prev?.recentFiles,
          }));
          return;
        }

        if (typ === "cost.update") {
          setContext((prev) => ({
            ...prev,
            cost: {
              totalTokens:
                typeof ev.totalTokens === "number" ? ev.totalTokens : 0,
              estimatedCostUsd:
                typeof ev.estimatedCostUsd === "number"
                  ? ev.estimatedCostUsd
                  : 0,
              promptTokens:
                typeof ev.promptTokens === "number" ? ev.promptTokens : 0,
              completionTokens:
                typeof ev.completionTokens === "number"
                  ? ev.completionTokens
                  : 0,
            },
            recentFiles: recentFilesRef.current.length
              ? [...recentFilesRef.current]
              : prev?.recentFiles,
          }));
          return;
        }

        if (typ === "memory.retrieve.done") {
          const sessionHits = parseSelectedMemories(ev.selectedMemories);
          setMemory((prev) => ({
            ...(prev ?? emptyMemory()),
            selectedCount:
              typeof ev.selectedCount === "number"
                ? ev.selectedCount
                : sessionHits.length,
            query: typeof ev.query === "string" ? ev.query : "",
            totalCandidates:
              typeof ev.totalCandidates === "number"
                ? ev.totalCandidates
                : sessionHits.length,
            sessionHits,
          }));
          return;
        }

        // 子 Agent 事件（child.*）已迁移到 useAgentRun 的 RunActivity 引擎
      },
    );

    const offList =
      desk.onMemoryListDone?.(
        (payload: {
          requestId: string;
          ok: boolean;
          items: unknown;
          error?: string;
        }) => {
          if (
            pendingListReq.current &&
            payload.requestId !== pendingListReq.current
          ) {
            // still accept if we only track last request
          }
          pendingListReq.current = null;
          setMemory((prev) => ({
            ...(prev ?? emptyMemory()),
            library: parseLibraryItems(payload.items),
            libraryOk: payload.ok === true,
            libraryError:
              typeof payload.error === "string"
                ? payload.error
                : payload.ok
                  ? undefined
                  : "list failed",
            libraryLoading: false,
          }));
        },
      ) ?? (() => {});

    return () => {
      window.clearTimeout(t);
      offEvent();
      offList();
    };
  }, [reset, refreshMemoryLibrary]);

  return {
    plan,
    changes,
    context,
    memory,
    refreshMemoryLibrary,
  };
}
