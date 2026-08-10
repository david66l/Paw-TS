import { useCallback, useEffect, useRef, useState } from "react";
import type { ConversationTurn } from "./conversationHistory";
import {
  formatModelOutputForUi,
  formatModelTextForUi,
  mergeThinking,
} from "./formatModelText";
import {
  requestHostStatus,
  requestSetSettings,
  requestSettings,
} from "./harnessClient";
import {
  type ChatSession,
  createEmptySession,
  deriveSessionTitle,
  loadSessionsFromStorage,
  sameSessionHistory,
  sameSessionMessages,
  saveSessionsToStorage,
} from "./sessionTypes";
import { tryHandleSlashCommand } from "./slashCommands";
import {
  appendAgentTool,
  mergeFileChanges,
  resolveAgentTool,
  summarizeToolCallArgs,
  toolBatchSummaryLine,
  toolRowStatusFromResult,
  totalChangeStats,
} from "./toolCards";
import type {
  AgentRunStatus,
  FileChangeItem,
  PendingApprovalItem,
  PendingAskItem,
  RunActivity,
  RunStatus,
  SubAgentInfo,
  ToolBatch,
  UiMessage,
} from "./types";
import { extractPathFromArgs } from "./useRightPanelData";

const SUB_AGENT_TOOL = "workspace.run_agent";

/** 从 run_agent 的 args 抠出子 Agent 目标（展示标签）。 */
function runAgentGoal(args: unknown): string {
  if (args && typeof args === "object") {
    const o = args as Record<string, unknown>;
    for (const k of ["goal", "task", "description", "objective", "prompt"]) {
      const v = o[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return "子任务";
}

/** 从 run_agent args 取注册表 agent_id（花名册绿点用） */
function runAgentSpecId(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const o = args as Record<string, unknown>;
  const raw = o.agent_id ?? o.agentId;
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  return undefined;
}

/** 定格执行卡的单行摘要文本（重载会话时作静态兜底）。 */
function activitySummaryLine(a: RunActivity): string {
  const ops = a.agents.reduce((n, x) => n + x.toolCount, 0);
  const secs =
    a.finishedAt && a.startedAt
      ? Math.max(1, Math.round((a.finishedAt - a.startedAt) / 1000))
      : 0;
  const failed = a.agents.filter((x) => x.status === "failed").length;
  const label =
    a.status === "failed" ? "并行执行 · 部分失败" : "并行执行 · 已完成";
  const tail = failed > 0 ? ` · ${failed} 失败` : "";
  return `${label} · ${a.agents.length} 个 Agent · ${ops} 次操作 · ${secs} 秒${tail}`;
}

/** Changed files 卡定格后的单行 fallback 文本 */
function changesSummaryLine(changes: readonly FileChangeItem[]): string {
  const { added, removed } = totalChangeStats(changes);
  return `变更 ${changes.length} 个文件 · +${added} −${removed}`;
}

function api() {
  return window.pawDesktop;
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 从 UI 消息列表抽出可进入多轮 history 的最后一条助手正文 */
function lastAssistantContent(messages: readonly UiMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "assistant" && m.content.trim() && !m.streaming) {
      return m.content.trim();
    }
  }
  return "";
}

function upsertAssistant(
  prev: UiMessage[],
  assistantId: string,
  patch: {
    content?: string;
    thinking?: string;
    streaming: boolean;
  },
): UiMessage[] {
  const exists = prev.some((m) => m.id === assistantId);
  if (!exists) {
    const content = patch.content ?? "";
    const thinking = patch.thinking ?? "";
    if (!content && !thinking && patch.streaming) {
      return [
        ...prev,
        {
          id: assistantId,
          role: "assistant",
          content: "",
          streaming: true,
        },
      ];
    }
    if (!content && !thinking) return prev;
    return [
      ...prev,
      {
        id: assistantId,
        role: "assistant",
        content,
        ...(thinking ? { thinking } : {}),
        streaming: patch.streaming,
      },
    ];
  }
  return prev.map((m) => {
    if (m.id !== assistantId) return m;
    return {
      ...m,
      content: patch.content !== undefined ? patch.content : m.content,
      thinking: patch.thinking !== undefined ? patch.thinking : m.thinking,
      streaming: patch.streaming,
    };
  });
}

function ensureAssistantId(
  ref: { current: string | null },
  streamRaw: { current: string },
  streamThinking: { current: string },
): string {
  if (!ref.current) {
    ref.current = newId("a");
    streamRaw.current = "";
    streamThinking.current = "";
  }
  return ref.current;
}

/**
 * 桌面端 Agent 运行状态：发任务、收事件、更新消息列表。
 * 支持多会话列表：保留 / 切换 / 新建。
 */
export function useAgentRun() {
  const initial = loadSessionsFromStorage();
  const initialActive =
    initial.sessions.find((s) => s.id === initial.activeId) ??
    initial.sessions[0]!;

  const [sessions, setSessions] = useState<ChatSession[]>(initial.sessions);
  const [activeSessionId, setActiveSessionId] = useState(initial.activeId);
  const [messages, setMessages] = useState<UiMessage[]>([
    ...initialActive.messages,
  ]);
  const [status, setStatus] = useState<RunStatus>("idle");
  const [statusText, setStatusText] = useState("等待任务");
  const [repoRoot, setRepoRoot] = useState<string>("");
  const [hostReady, setHostReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 最近一次 agent runId（checkpoint / undo） */
  const [lastRunId, setLastRunId] = useState<string | null>(null);
  const [modelLabel, setModelLabel] = useState<string>("—");
  const [skillsCount, setSkillsCount] = useState(0);
  const [agentRoster, setAgentRoster] = useState<
    readonly {
      id: string;
      name: string;
      role: string;
      emoji?: string;
      kind: string;
    }[]
  >([]);
  /** 花名册运行态：id → idle|running|done|failed */
  const [agentRunStatus, setAgentRunStatus] = useState<
    Record<string, AgentRunStatus>
  >({});
  /** run_agent callId → 注册表 agent_id，用于 tool.result 收尾 */
  const runAgentSpecByCallRef = useRef<Map<string, string>>(new Map());

  /** 待审批队列（根 Agent 与并行子 Agent 共享一条已串行化的审批通道） */
  const [pendingApprovals, setPendingApprovals] = useState<
    PendingApprovalItem[]
  >([]);
  /** 待回答的模型提问（ask_user，一次一条） */
  const [pendingAsk, setPendingAsk] = useState<PendingAskItem | null>(null);
  const pendingAskRef = useRef<PendingAskItem | null>(null);
  /** 最近一次失败的任务目标（errorBar 重试用） */
  const [failedGoal, setFailedGoal] = useState<string | null>(null);

  /** 工作区设置：审批模式 + 模型预设（来自 settings.local.json） */
  const [approvalMode, setApprovalMode] = useState<"ask" | "auto">("ask");
  const [modelPresets, setModelPresets] = useState<
    readonly { id: string; model: string }[]
  >([]);
  const [provider, setProvider] = useState<string | undefined>(undefined);

  /** run 结束 / 切换会话时，清空待审批与待提问 */
  const clearPendingInteractions = useCallback(() => {
    setPendingApprovals([]);
    pendingAskRef.current = null;
    setPendingAsk(null);
  }, []);

  const setSpecRunStatus = useCallback(
    (specId: string, status: AgentRunStatus) => {
      if (!specId) return;
      setAgentRunStatus((prev) => {
        if (prev[specId] === status) return prev;
        return { ...prev, [specId]: status };
      });
    },
    [],
  );

  const requestIdRef = useRef<string | null>(null);
  const assistantIdRef = useRef<string | null>(null);
  /** 当前助手气泡的原始流式缓冲（未 format） */
  const streamRawRef = useRef<string>("");
  /** 当前轮 thinking 通道缓冲（model.thinking 事件） */
  const streamThinkingRef = useRef<string>("");
  /** 当前会话 id（= conversationId，多轮 + 记忆绑定） */
  const conversationIdRef = useRef<string>(initialActive.id);
  /** 已完成的多轮 turns（不含当前进行中的 user） */
  const historyRef = useRef<ConversationTurn[]>([...initialActive.history]);
  /** 当前 run 的用户原文，成功后写入 history */
  const pendingUserRef = useRef<string | null>(null);
  /** 防止同一 run 重复提交 history */
  const historyCommittedRef = useRef(false);
  const sessionsRef = useRef(sessions);
  const activeIdRef = useRef(activeSessionId);
  const messagesRef = useRef(messages);
  sessionsRef.current = sessions;
  activeIdRef.current = activeSessionId;
  messagesRef.current = messages;

  /** 并行子 Agent 执行卡（RunActivity）状态 —— 供 ChatStream + RightPanel 共享读取 */
  const activitiesRef = useRef<RunActivity[]>([]);
  const [activities, setActivities] = useState<RunActivity[]>([]);
  /** 当前开启中的 activity id（null = 无进行中的子 Agent 批次） */
  const openActivityIdRef = useRef<string | null>(null);
  const [selectedActivityId, setSelectedActivityId] = useState<string | null>(
    null,
  );
  const selectActivity = useCallback(
    (id: string) => setSelectedActivityId(id),
    [],
  );

  /** 连续工具调用的执行卡（toolbatch 锚点消息 → ToolBatch） */
  const toolBatchesRef = useRef<ToolBatch[]>([]);
  const [toolBatches, setToolBatches] = useState<ToolBatch[]>([]);
  const openToolBatchIdRef = useRef<string | null>(null);
  /** 本 run 的文件变更聚合（changes 锚点消息 → ChangedFilesCard 数据） */
  const fileChangesRef = useRef<FileChangeItem[]>([]);
  const [fileChanges, setFileChanges] = useState<FileChangeItem[]>([]);
  const changesMarkerIdRef = useRef<string | null>(null);
  /** 切换/清空会话时丢弃活的 activity（重载后标记消息按 content 静态渲染） */
  const clearLiveActivities = useCallback(() => {
    activitiesRef.current = [];
    openActivityIdRef.current = null;
    setActivities([]);
    setSelectedActivityId(null);
    runAgentSpecByCallRef.current.clear();
    setAgentRunStatus({});
    toolBatchesRef.current = [];
    openToolBatchIdRef.current = null;
    setToolBatches([]);
    fileChangesRef.current = [];
    changesMarkerIdRef.current = null;
    setFileChanges([]);
  }, []);

  /**
   * 把当前 UI 状态写回 sessions 列表中的对应项。
   * 仅在消息/历史实质变化时 touch updatedAt 并置顶；纯切换不改顺序。
   */
  const persistActiveIntoSessions = useCallback(
    (msgs: readonly UiMessage[], history: readonly ConversationTurn[]) => {
      const id = conversationIdRef.current;
      setSessions((prev) => {
        let touched = false;
        let next: ChatSession[] = prev.map((s) => {
          if (s.id !== id) return s;
          const title = deriveSessionTitle(msgs, s.title || "新对话");
          const messages = msgs.map((m) => ({ ...m, streaming: false }));
          const hist = [...history];
          touched =
            !sameSessionMessages(s.messages, messages) ||
            !sameSessionHistory(s.history, hist) ||
            s.title !== title;
          return {
            ...s,
            title,
            messages,
            history: hist,
            updatedAt: touched ? Date.now() : s.updatedAt,
          };
        });
        if (!next.some((s) => s.id === id)) {
          next = [
            {
              id,
              title: deriveSessionTitle(msgs),
              messages: msgs.map((m) => ({ ...m, streaming: false })),
              history: [...history],
              updatedAt: Date.now(),
            },
            ...next,
          ];
          touched = true;
        } else if (touched) {
          const idx = next.findIndex((s) => s.id === id);
          if (idx > 0) {
            const item = next[idx]!;
            next = [item, ...next.slice(0, idx), ...next.slice(idx + 1)];
          }
        }
        saveSessionsToStorage(next, id);
        return next;
      });
    },
    [],
  );

  const finalizeSessionMemory = useCallback((conversationId: string) => {
    const desk = api();
    if (!desk?.finalizeConversation || !conversationId) return;
    void desk
      .finalizeConversation({ conversationId })
      .catch((e) => console.warn("[finalizeConversation]", e));
  }, []);

  const commitHistoryIfNeeded = useCallback(
    (assistantText: string) => {
      if (historyCommittedRef.current) return;
      const user = pendingUserRef.current?.trim();
      const assistant = assistantText.trim();
      if (!user || !assistant) return;
      // 跳过 aborted / 纯错误
      if (assistant === "Run aborted." || assistant.startsWith("错误："))
        return;
      const next: ConversationTurn[] = [
        ...historyRef.current,
        { role: "user" as const, content: user },
        { role: "assistant" as const, content: assistant },
      ];
      historyRef.current = next.slice(-32);
      historyCommittedRef.current = true;
      pendingUserRef.current = null;
      // 同步标题到会话列表
      persistActiveIntoSessions(messagesRef.current, historyRef.current);
    },
    [persistActiveIntoSessions],
  );

  // messages 变化时同步到 sessions
  // 切换会话只同步内容，不 touch updatedAt / 不重排；真实内容变更才置顶
  useEffect(() => {
    // ponytail: 流式期间跳过落盘。model.chunk 每秒几十次，每次都
    // JSON.stringify 全部会话 + 同步 localStorage.setItem 会卡主线程。
    // run 结束时 streaming 全部翻 false → 该 effect 再触发一次，落盘一次。
    if (messages.some((m) => m.streaming)) return;
    const id = activeSessionId;
    setSessions((prev) => {
      let touched = false;
      let next = prev.map((s) => {
        if (s.id !== id) return s;
        const title = deriveSessionTitle(messages, s.title || "新对话");
        const nextMessages = messages.map((m) => ({
          ...m,
          streaming: m.streaming === true,
        }));
        const hist = [...historyRef.current];
        touched =
          !sameSessionMessages(s.messages, nextMessages) ||
          !sameSessionHistory(s.history, hist) ||
          s.title !== title;
        return {
          ...s,
          title,
          messages: nextMessages,
          history: hist,
          updatedAt: touched ? Date.now() : s.updatedAt,
        };
      });
      if (touched) {
        const idx = next.findIndex((s) => s.id === id);
        if (idx > 0) {
          const item = next[idx]!;
          next = [item, ...next.slice(0, idx), ...next.slice(idx + 1)];
        }
      }
      saveSessionsToStorage(next, id);
      return next;
    });
  }, [messages, activeSessionId]);

  useEffect(() => {
    const desk = api();
    if (!desk) {
      setStatusText("非 Electron 环境（可用浏览器预览 UI）");
      return;
    }

    // ---- RunActivity 变更助手（闭包持有 refs + 稳定 setter）----
    const commitActivities = () => setActivities([...activitiesRef.current]);
    const patchActivity = (id: string, fn: (a: RunActivity) => RunActivity) => {
      activitiesRef.current = activitiesRef.current.map((a) =>
        a.id === id ? fn(a) : a,
      );
      commitActivities();
    };
    const upsertAgent = (
      activityId: string,
      agentId: string,
      patch: Partial<SubAgentInfo>,
    ) => {
      patchActivity(activityId, (a) => {
        const exists = a.agents.some((g) => g.id === agentId);
        const agents = exists
          ? a.agents.map((g) => (g.id === agentId ? { ...g, ...patch } : g))
          : [
              ...a.agents,
              {
                id: agentId,
                label: agentId,
                status: "running" as const,
                toolCount: 0,
                files: [],
                tools: [],
                ...patch,
              },
            ];
        return { ...a, agents };
      });
    };
    const finalizeOpenActivity = () => {
      const id = openActivityIdRef.current;
      if (!id) return;
      openActivityIdRef.current = null;
      patchActivity(id, (a) => {
        const failed = a.agents.some((g) => g.status === "failed");
        return {
          ...a,
          status: failed ? "failed" : "done",
          finishedAt: Date.now(),
        };
      });
      const finalA = activitiesRef.current.find((a) => a.id === id);
      if (finalA) {
        const line = activitySummaryLine(finalA);
        setMessages((prev) =>
          prev.map((m) =>
            m.role === "activity" && m.activityId === id
              ? { ...m, content: line }
              : m,
          ),
        );
      }
    };

    // ---- 工具执行卡（ToolBatch）与 Changed files 卡 ----
    const commitToolBatches = () => setToolBatches([...toolBatchesRef.current]);
    /** 定格开启中的工具卡（新模型轮 / run 结束 / 子 Agent 批次接管时调用） */
    const finalizeOpenToolBatch = () => {
      const id = openToolBatchIdRef.current;
      if (!id) return;
      openToolBatchIdRef.current = null;
      toolBatchesRef.current = toolBatchesRef.current.map((b) =>
        b.id === id ? { ...b, status: "done", finishedAt: Date.now() } : b,
      );
      commitToolBatches();
      const b = toolBatchesRef.current.find((x) => x.id === id);
      if (b) {
        const line = toolBatchSummaryLine(b.rows);
        setMessages((prev) =>
          prev.map((m) =>
            m.role === "toolbatch" && m.toolBatchId === id
              ? { ...m, content: line }
              : m,
          ),
        );
      }
    };
    /** run 结束时定格 Changed files 卡的 fallback 文本 */
    const finalizeChangesCard = () => {
      const id = changesMarkerIdRef.current;
      if (!id || fileChangesRef.current.length === 0) return;
      const line = changesSummaryLine(fileChangesRef.current);
      setMessages((prev) =>
        prev.map((m) =>
          m.role === "changes" && m.id === id ? { ...m, content: line } : m,
        ),
      );
    };

    /**
     * model 标签：成功一次即可停。
     * agent 花名册：必须拿到 agents 数组后才停（避免旧 host / 早到的 status 把列表卡死为空）。
     */
    let modelFetched = false;
    let rosterFetched = false;
    const refreshHostStatus = (force = false) => {
      if (modelFetched && rosterFetched && !force) return;
      void requestHostStatus()
        .then((s) => {
          if (!s.ok) return;
          if (!modelFetched || force) {
            modelFetched = true;
            setModelLabel(s.modelLabel || "—");
            setSkillsCount(
              typeof s.skillsCount === "number" ? s.skillsCount : 0,
            );
            if (s.workspaceRoot) setRepoRoot(s.workspaceRoot);
          }
          if (Array.isArray(s.agents)) {
            setAgentRoster(s.agents);
            if (s.agents.length > 0) rosterFetched = true;
          }
        })
        .catch(() => {
          /* host 未就绪时忽略，下次 meta/ready 再试 */
        });
    };

    const refreshSettings = () => {
      void requestSettings()
        .then((s) => {
          if (!s.ok) return;
          setApprovalMode(s.approvalMode);
          setModelPresets(s.presets);
          setProvider(s.provider);
        })
        .catch(() => {});
    };

    const refreshMeta = () => {
      void desk.getMeta().then((m) => {
        setRepoRoot(m.repoRoot);
        setHostReady(m.agentReady);
        if (m.agentReady) {
          setStatusText((s) =>
            s === "等待任务" || s === "等待 Agent" ? "Agent 就绪" : s,
          );
          // 就绪后持续补拉，直到花名册非空（或用户 force）
          refreshHostStatus();
          refreshSettings();
        }
      });
    };
    refreshMeta();
    const metaTimer = setInterval(refreshMeta, 2000);

    const offReady = desk.onReady(() => {
      setHostReady(true);
      setStatusText((s) =>
        s === "等待任务" || s === "等待 Agent" ? "Agent 就绪" : s,
      );
      refreshHostStatus(true);
      refreshSettings();
    });

    const offEvent = desk.onEvent(({ requestId, event: envelope }) => {
      if (requestIdRef.current && requestId !== requestIdRef.current) return;

      const ev = envelope?.event;
      if (!ev || typeof ev.type !== "string") return;
      const t = ev.type;

      // 信封级 runId
      if (typeof envelope?.runId === "string" && envelope.runId.trim()) {
        setLastRunId(envelope.runId.trim());
      }

      if (t === "run.started") {
        setStatus("running");
        setStatusText("运行中…");
        if (typeof ev.runId === "string" && ev.runId.trim()) {
          setLastRunId(ev.runId.trim());
        }
        // 总控狸花点亮（不依赖闭包里的 roster）
        setSpecRunStatus("lihua", "running");
        return;
      }
      if (t === "model.request") {
        setStatusText("调用模型…");
        // 新一轮模型调用 = 上一批工具执行告一段落
        finalizeOpenToolBatch();
        ensureAssistantId(assistantIdRef, streamRawRef, streamThinkingRef);
        return;
      }
      if (t === "model.thinking" && typeof ev.text === "string") {
        setStatusText("思考中…");
        const aid = ensureAssistantId(
          assistantIdRef,
          streamRawRef,
          streamThinkingRef,
        );
        // orchestrator 已发累计快照（thinkingAcc），直接采用最新全文，禁止再 merge 拼接
        streamThinkingRef.current = ev.text;
        const formatted = formatModelOutputForUi(streamRawRef.current, {
          streaming: true,
        });
        const thinking = mergeThinking(
          streamThinkingRef.current,
          formatted.thinking,
        );
        setMessages((prev) =>
          upsertAssistant(prev, aid, {
            content: formatted.content ?? "",
            thinking,
            streaming: true,
          }),
        );
        return;
      }
      if (t === "model.chunk" && typeof ev.text === "string") {
        setStatusText("生成回复…");
        const aid = ensureAssistantId(
          assistantIdRef,
          streamRawRef,
          streamThinkingRef,
        );
        // model.chunk 同样是累计快照 acc
        streamRawRef.current = ev.text;
        const formatted = formatModelOutputForUi(streamRawRef.current, {
          streaming: true,
        });
        const thinking = mergeThinking(
          streamThinkingRef.current,
          formatted.thinking,
        );
        setMessages((prev) =>
          upsertAssistant(prev, aid, {
            content: formatted.content ?? "",
            thinking,
            streaming: true,
          }),
        );
        return;
      }
      if (t === "model.done" && typeof ev.text === "string") {
        const aid = ensureAssistantId(
          assistantIdRef,
          streamRawRef,
          streamThinkingRef,
        );
        streamRawRef.current = ev.text;
        // model.done 可能自带 thinking 字段（推理通道汇总）
        if (typeof ev.thinking === "string" && ev.thinking.trim()) {
          // 优先 done 汇总；若比通道更长/更完整则采用
          const doneThink = ev.thinking.trim();
          if (
            !streamThinkingRef.current ||
            doneThink.length >= streamThinkingRef.current.length
          ) {
            streamThinkingRef.current = doneThink;
          }
        }
        const formatted = formatModelOutputForUi(ev.text, { streaming: false });
        const thinking = mergeThinking(
          streamThinkingRef.current,
          formatted.thinking,
        );

        if (formatted.content === null && !thinking) {
          // 纯工具调用且无思考：去掉空助手气泡
          setMessages((prev) => prev.filter((m) => m.id !== aid));
          assistantIdRef.current = null;
          streamRawRef.current = "";
          streamThinkingRef.current = "";
        } else {
          setMessages((prev) =>
            upsertAssistant(prev, aid, {
              content: formatted.content ?? "",
              thinking,
              streaming: false,
            }),
          );
          // 工具轮结束后清空 id，下一轮 model.request 新建气泡
          // 若本轮有正文，保留当前气泡，下一轮再 new
          if (formatted.content === null) {
            assistantIdRef.current = null;
            streamRawRef.current = "";
            streamThinkingRef.current = "";
          }
        }
        setStatusText("处理中…");
        return;
      }
      if (t === "tool.call" && typeof ev.tool === "string") {
        // 子 Agent 派生：开/写执行卡，不再出工具胶囊
        if (ev.tool === SUB_AGENT_TOOL) {
          const callId =
            typeof ev.callId === "string" ? ev.callId : newId("child");
          const specId = runAgentSpecId(ev.args);
          if (specId) {
            runAgentSpecByCallRef.current.set(callId, specId);
            setSpecRunStatus(specId, "running");
          }
          if (!openActivityIdRef.current) {
            const actId = newId("act");
            openActivityIdRef.current = actId;
            activitiesRef.current = [
              ...activitiesRef.current,
              {
                id: actId,
                status: "running",
                startedAt: Date.now(),
                agents: [],
              },
            ];
            commitActivities();
            setSelectedActivityId(actId);
            setMessages((prev) => [
              ...prev,
              {
                id: newId("actmsg"),
                role: "activity",
                content: "并行执行 · 运行中",
                activityId: actId,
              },
            ]);
          }
          upsertAgent(openActivityIdRef.current, callId, {
            label: runAgentGoal(ev.args),
            status: "running",
          });
          setStatusText("并行子 Agent…");
          // 子 Agent 批次接管，此前的普通工具批定格
          finalizeOpenToolBatch();
          assistantIdRef.current = null;
          streamRawRef.current = "";
          streamThinkingRef.current = "";
          return;
        }
        // 普通工具调用：归入当前工具批（无则开新批 + 插锚点消息）
        {
          const summary = summarizeToolCallArgs(ev.args);
          if (!openToolBatchIdRef.current) {
            const bid = newId("tb");
            openToolBatchIdRef.current = bid;
            toolBatchesRef.current = [
              ...toolBatchesRef.current,
              { id: bid, rows: [], status: "running", startedAt: Date.now() },
            ];
            setMessages((prev) => [
              ...prev,
              {
                id: newId("tbmsg"),
                role: "toolbatch",
                content: "调用工具…",
                toolBatchId: bid,
              },
            ]);
          }
          const bid = openToolBatchIdRef.current;
          toolBatchesRef.current = toolBatchesRef.current.map((b) =>
            b.id === bid
              ? {
                  ...b,
                  rows: [
                    ...b.rows,
                    {
                      id: newId("tr"),
                      tool: ev.tool as string,
                      summary,
                      status: "running" as const,
                      at: Date.now(),
                    },
                  ],
                }
              : b,
          );
          commitToolBatches();
        }
        setStatusText(`工具 ${ev.tool}…`);
        assistantIdRef.current = null;
        streamRawRef.current = "";
        streamThinkingRef.current = "";
        return;
      }
      if (t === "tool.result" && typeof ev.tool === "string") {
        // 子 Agent 结果由执行卡承载，不出胶囊；花名册绿点收尾
        if (ev.tool === SUB_AGENT_TOOL) {
          const callId = typeof ev.callId === "string" ? ev.callId : undefined;
          const fromCall = callId
            ? runAgentSpecByCallRef.current.get(callId)
            : undefined;
          const fromArgs = runAgentSpecId(ev.args);
          const fromSummary =
            typeof ev.summary === "string"
              ? ev.summary.match(/\[([a-zA-Z0-9_-]+)\]/)?.[1]
              : undefined;
          const specId = fromCall ?? fromArgs ?? fromSummary;
          if (specId) {
            setSpecRunStatus(specId, ev.ok === false ? "failed" : "done");
            if (callId) runAgentSpecByCallRef.current.delete(callId);
          }
          return;
        }
        const ok = ev.ok !== false;
        const summary =
          typeof ev.summary === "string" ? ev.summary : ok ? "完成" : "失败";
        // 修改性工具的变更统计 → Changed files 卡（首个变更到达时插锚点）
        if (Array.isArray(ev.fileChanges) && ev.fileChanges.length > 0) {
          const incoming: FileChangeItem[] = [];
          for (const c of ev.fileChanges) {
            if (!c || typeof c !== "object") continue;
            const r = c as Record<string, unknown>;
            if (typeof r.path !== "string") continue;
            incoming.push({
              path: r.path,
              added: typeof r.added === "number" ? r.added : 0,
              removed: typeof r.removed === "number" ? r.removed : 0,
              ...(typeof r.diff === "string" && r.diff ? { diff: r.diff } : {}),
            });
          }
          if (incoming.length > 0) {
            fileChangesRef.current = mergeFileChanges(
              fileChangesRef.current,
              incoming,
            );
            setFileChanges([...fileChangesRef.current]);
            if (!changesMarkerIdRef.current) {
              const markerId = newId("chgmsg");
              changesMarkerIdRef.current = markerId;
              setMessages((prev) => [
                ...prev,
                { id: markerId, role: "changes", content: "文件变更" },
              ]);
            }
          }
        }
        // 更新工具批里对应行（FIFO：最后一个 running 且同工具的行）
        const bid = openToolBatchIdRef.current;
        if (bid) {
          const status = toolRowStatusFromResult(ok, summary);
          toolBatchesRef.current = toolBatchesRef.current.map((b) => {
            if (b.id !== bid) return b;
            let idx = -1;
            for (let i = b.rows.length - 1; i >= 0; i--) {
              const r = b.rows[i]!;
              if (r.status === "running" && r.tool === ev.tool) {
                idx = i;
                break;
              }
            }
            if (idx === -1) {
              idx = b.rows.findIndex((r) => r.status === "running");
            }
            if (idx === -1) return b;
            return {
              ...b,
              rows: b.rows.map((r, i) =>
                i === idx
                  ? { ...r, status, result: summary, finishedAt: Date.now() }
                  : r,
              ),
            };
          });
          commitToolBatches();
        }
        return;
      }
      // 子 Agent 事件（child.*）驱动执行卡的每 agent 状态
      if (t.startsWith("child.")) {
        const activityId = openActivityIdRef.current;
        if (!activityId) return;
        const agentId =
          typeof ev.callId === "string"
            ? ev.callId
            : typeof ev.agentId === "string"
              ? ev.agentId
              : "";
        if (!agentId) return;
        const orig =
          ev.originalEvent && typeof ev.originalEvent === "object"
            ? (ev.originalEvent as Record<string, unknown>)
            : undefined;
        // 文件锁等待/冲突事件 → 子 Agent 工具流
        if (orig?.type === "agent.file_lock") {
          const lockPath = typeof orig.path === "string" ? orig.path : "";
          const holder =
            typeof orig.holder === "string" && orig.holder
              ? orig.holder
              : "另一只 Agent";
          const denied = orig.status === "denied";
          const label = denied
            ? `锁冲突：${lockPath} 正被 ${holder} 占用`
            : `等待文件锁：${lockPath}（被 ${holder} 占用）`;
          patchActivity(activityId, (a) => ({
            ...a,
            agents: a.agents.map((g) =>
              g.id === agentId
                ? {
                    ...g,
                    tools: appendAgentTool(g.tools ?? [], {
                      id: newId("ate"),
                      tool: "file_lock",
                      summary: label,
                      ...(denied ? { ok: false, result: label } : {}),
                      at: Date.now(),
                    }),
                  }
                : g,
            ),
          }));
          return;
        }
        if (t === "child.tool_call") {
          const tool = typeof orig?.tool === "string" ? orig.tool : undefined;
          const path = extractPathFromArgs(orig?.args);
          patchActivity(activityId, (a) => ({
            ...a,
            agents: a.agents.map((g) => {
              if (g.id !== agentId) return g;
              const isRead = tool ? /read_file/.test(tool) : false;
              const files =
                path && isRead && !g.files.includes(path)
                  ? [...g.files, path]
                  : g.files;
              const tools = tool
                ? appendAgentTool(g.tools ?? [], {
                    id: newId("ate"),
                    tool,
                    summary: summarizeToolCallArgs(orig?.args),
                    at: Date.now(),
                  })
                : (g.tools ?? []);
              return {
                ...g,
                toolCount: g.toolCount + 1,
                lastTool: tool ?? g.lastTool,
                files,
                tools,
              };
            }),
          }));
        } else if (t === "child.tool_result") {
          // 回填工具流里最后一个同工具且未完成的事件
          const tool = typeof orig?.tool === "string" ? orig.tool : undefined;
          if (tool) {
            const ok = orig?.ok !== false;
            const result =
              typeof orig?.summary === "string"
                ? orig.summary
                : ok
                  ? "完成"
                  : "失败";
            patchActivity(activityId, (a) => ({
              ...a,
              agents: a.agents.map((g) =>
                g.id === agentId
                  ? {
                      ...g,
                      tools: resolveAgentTool(g.tools ?? [], tool, ok, result),
                    }
                  : g,
              ),
            }));
          }
        } else if (t === "child.completed") {
          upsertAgent(activityId, agentId, {
            status: "done",
            ...(typeof orig?.message === "string"
              ? { summary: orig.message }
              : {}),
          });
        } else if (t === "child.failed") {
          upsertAgent(activityId, agentId, {
            status: "failed",
            ...(typeof orig?.message === "string"
              ? { error: orig.message }
              : {}),
          });
        } else if (t === "child.started") {
          const goal =
            typeof ev.goal === "string"
              ? ev.goal
              : typeof orig?.goal === "string"
                ? orig.goal
                : undefined;
          if (goal) upsertAgent(activityId, agentId, { label: goal });
        }
        return;
      }
      // 批次结束：合并阶段 → 定格执行卡
      if (t === "phase") {
        if (ev.name === "merging_results") finalizeOpenActivity();
        return;
      }
      if (t === "run.completed") {
        finalizeOpenActivity();
        finalizeOpenToolBatch();
        finalizeChangesCard();
        const aborted = ev.status === "aborted";
        const failed = ev.status === "failed";
        if (failed) setFailedGoal(pendingUserRef.current);
        clearPendingInteractions();
        setStatus(aborted ? "aborted" : failed ? "failed" : "completed");
        setStatusText(aborted ? "已中止" : failed ? "失败" : "完成");
        // 本轮结束：全部回到空闲（灰点）；失败的可短暂保持 failed 后也归 idle
        setAgentRunStatus((prev) => {
          const next: Record<string, AgentRunStatus> = { ...prev };
          for (const k of Object.keys(next)) {
            next[k] = failed && next[k] === "running" ? "failed" : "idle";
          }
          return next;
        });
        runAgentSpecByCallRef.current.clear();
        setMessages((prev) => {
          let next = prev.map((m) =>
            m.streaming ? { ...m, streaming: false } : m,
          );
          if (typeof ev.message === "string" && ev.message.trim()) {
            // format 返回 null = 纯工具 JSON 等，禁止回退成原文（否则会把整份 CSS 刷进气泡）
            const msg = formatModelTextForUi(ev.message);
            const last = [...next]
              .reverse()
              .find((m) => m.role === "assistant");
            if (msg && !last?.content.trim()) {
              next = [
                ...next,
                { id: newId("a"), role: "assistant", content: msg },
              ];
            } else if (last?.content.trim()) {
              // 清洗已上屏的工具 JSON / 半截文件内容
              const cleaned = formatModelTextForUi(last.content);
              if (cleaned !== last.content) {
                next = next.map((m) =>
                  m.id === last.id
                    ? { ...m, content: cleaned ?? "", streaming: false }
                    : m,
                );
                if (!cleaned) {
                  next = next.filter(
                    (m) => m.id !== last.id || m.thinking?.trim(),
                  );
                }
              }
            }
          }
          if (!failed) {
            commitHistoryIfNeeded(lastAssistantContent(next));
          }
          return next;
        });
        return;
      }
      if (t === "memory.retrieve.done") {
        const raw = ev.selectedCount;
        const n = typeof raw === "number" ? raw : 0;
        // 降噪：0 命中是常态，不再上屏（Memory tab 有完整检索信息）
        if (n > 0) {
          setMessages((prev) => [
            ...prev,
            {
              id: newId("sys"),
              role: "system",
              content: `记忆检索 · ${n} 条`,
            },
          ]);
        }
      }
    });

    const offDone = desk.onRunDone(({ requestId, result }) => {
      if (requestIdRef.current && requestId !== requestIdRef.current) return;
      finalizeOpenActivity();
      finalizeOpenToolBatch();
      finalizeChangesCard();
      const aborted = result.status === "aborted";
      const failed = result.status === "failed";
      if (failed) setFailedGoal(pendingUserRef.current);
      clearPendingInteractions();
      setStatus(aborted ? "aborted" : failed ? "failed" : "completed");
      setStatusText(aborted ? "已中止" : failed ? "失败" : "完成");
      setAgentRunStatus((prev) => {
        const next: Record<string, AgentRunStatus> = { ...prev };
        for (const k of Object.keys(next)) {
          next[k] = "idle";
        }
        return next;
      });
      runAgentSpecByCallRef.current.clear();
      if (typeof result.runId === "string" && result.runId.trim()) {
        setLastRunId(result.runId.trim());
      }
      requestIdRef.current = null;
      assistantIdRef.current = null;
      streamRawRef.current = "";
      streamThinkingRef.current = "";
      setMessages((prev) => {
        let next = prev.map((m) =>
          m.streaming ? { ...m, streaming: false } : m,
        );
        if (result.message?.trim()) {
          const msg = formatModelTextForUi(result.message);
          const last = [...next].reverse().find((m) => m.role === "assistant");
          if (msg && !last?.content.trim()) {
            next = [
              ...next,
              { id: newId("a"), role: "assistant", content: msg },
            ];
          } else if (last?.content.trim()) {
            const cleaned = formatModelTextForUi(last.content);
            if (cleaned !== last.content) {
              next = next.map((m) =>
                m.id === last.id
                  ? { ...m, content: cleaned ?? "", streaming: false }
                  : m,
              );
              if (!cleaned && !last.thinking?.trim()) {
                next = next.filter((m) => m.id !== last.id);
              }
            }
          }
        }
        if (!failed) {
          commitHistoryIfNeeded(lastAssistantContent(next));
        }
        return next;
      });
    });

    const offErr = desk.onError(({ requestId, message }) => {
      const isCurrentRun =
        requestIdRef.current && requestId === requestIdRef.current;
      if (requestIdRef.current && requestId !== "?" && !isCurrentRun) {
        return;
      }
      if (isCurrentRun) setFailedGoal(pendingUserRef.current);
      clearPendingInteractions();
      finalizeOpenToolBatch();
      finalizeChangesCard();
      setError(message);
      setStatus("failed");
      setStatusText("错误");
      finalizeOpenActivity();
      setMessages((prev) => [
        ...prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)),
        { id: newId("sys"), role: "system", content: `错误：${message}` },
      ]);
      requestIdRef.current = null;
      assistantIdRef.current = null;
      streamRawRef.current = "";
      streamThinkingRef.current = "";
    });

    const offApprovalReq = desk.onApprovalRequest((p) => {
      if (requestIdRef.current && p.requestId !== requestIdRef.current) return;
      setPendingApprovals((prev) =>
        prev.some((a) => a.approvalId === p.approvalId)
          ? prev
          : [
              ...prev,
              {
                approvalId: p.approvalId,
                tool: p.tool,
                summary: p.summary,
                argsPreview: p.argsPreview,
              },
            ],
      );
      setStatusText(`等待审批 · ${p.tool}`);
    });

    const offAskReq = desk.onAskUserRequest((p) => {
      if (requestIdRef.current && p.requestId !== requestIdRef.current) return;
      const item: PendingAskItem = {
        askId: p.askId,
        question: p.question,
        timeoutSec: p.timeoutSec,
      };
      pendingAskRef.current = item;
      setPendingAsk(item);
      setStatusText("Paw 想问你一个问题…");
    });

    const offHost = desk.onHostExit(() => {
      // 宿主中断：若在 run 中，按失败收场并允许重试（看门狗会自动重启宿主）
      const interrupted = requestIdRef.current !== null;
      if (interrupted) {
        setFailedGoal(pendingUserRef.current);
        setError("Agent 宿主中断，任务已终止；宿主将自动重启，可点重试");
        requestIdRef.current = null;
        assistantIdRef.current = null;
        streamRawRef.current = "";
        streamThinkingRef.current = "";
        finalizeOpenActivity();
        finalizeOpenToolBatch();
        finalizeChangesCard();
        clearPendingInteractions();
        setStatus("failed");
        setStatusText("宿主中断");
        setMessages((prev) => [
          ...prev.map((m) => (m.streaming ? { ...m, streaming: false } : m)),
          {
            id: newId("sys"),
            role: "system",
            content: "Agent 宿主已退出（自动重启中）",
          },
        ]);
      }
      setHostReady(false);
      setStatusText((s) => (interrupted ? s : "Agent 宿主已退出"));
    });

    const offLog = desk.onLog(({ level, text }) => {
      if (level === "stderr" && /error|Error|ERROR/.test(text)) {
        console.warn("[agent-host]", text);
      }
    });

    return () => {
      clearInterval(metaTimer);
      offReady();
      offEvent();
      offDone();
      offErr();
      offApprovalReq();
      offAskReq();
      offHost();
      offLog();
    };
  }, [commitHistoryIfNeeded, clearPendingInteractions]);

  const send = useCallback(
    async (goal: string) => {
      const desk = api();
      const text = goal.trim();
      if (!text) return;
      if (!desk) {
        setError("当前不在 Electron 中，无法运行 Agent");
        return;
      }
      if (requestIdRef.current) {
        setError("已有任务在运行，请先等待结束或中止");
        return;
      }

      // slash：本地执行，不进入 agent run
      if (text.startsWith("/")) {
        setError(null);
        setMessages((prev) => [
          ...prev,
          { id: newId("u"), role: "user", content: text },
        ]);
        setStatusText("执行命令…");
        try {
          const result = await tryHandleSlashCommand(text, {
            lastRunId,
            workspaceRoot: repoRoot || undefined,
          });
          if (result.clearMessages) {
            setMessages([
              {
                id: newId("sys"),
                role: "system",
                content: result.messages[0] ?? "已清空",
              },
            ]);
            historyRef.current = [];
            pendingUserRef.current = null;
            historyCommittedRef.current = false;
          } else {
            setMessages((prev) => [
              ...prev,
              ...result.messages.map((m) => ({
                id: newId("sys"),
                role: "system" as const,
                content: m,
              })),
            ]);
          }
          setStatus("idle");
          setStatusText(hostReady ? "Agent 就绪" : "等待 Agent");
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          setError(message);
          setMessages((prev) => [
            ...prev,
            {
              id: newId("sys"),
              role: "system",
              content: `命令错误：${message}`,
            },
          ]);
          setStatus("failed");
          setStatusText("命令失败");
        }
        return;
      }

      setError(null);
      setFailedGoal(null);
      setStatus("running");
      setStatusText("启动中…");
      assistantIdRef.current = null;
      streamRawRef.current = "";
      streamThinkingRef.current = "";
      pendingUserRef.current = text;
      historyCommittedRef.current = false;
      clearPendingInteractions();
      // 新 run：清空上一轮的变更卡与工具卡（锚点消息保留，按 content 静态渲染）
      toolBatchesRef.current = [];
      openToolBatchIdRef.current = null;
      setToolBatches([]);
      fileChangesRef.current = [];
      changesMarkerIdRef.current = null;
      setFileChanges([]);

      const clientRequestId = newId("req");
      requestIdRef.current = clientRequestId;

      // 快照当前 history（不含本条 user）
      const historySnapshot = historyRef.current.map((t) => ({
        role: t.role,
        content: t.content,
      }));

      setMessages((prev) => [
        ...prev,
        { id: newId("u"), role: "user", content: text },
      ]);

      try {
        const { requestId } = await desk.startRun({
          goal: text,
          maxSteps: 24,
          requestId: clientRequestId,
          conversationId: conversationIdRef.current,
          history: historySnapshot,
        });
        requestIdRef.current = requestId;
        setStatusText("运行中…");
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setError(message);
        setStatus("failed");
        setStatusText("启动失败");
        requestIdRef.current = null;
        pendingUserRef.current = null;
      }
    },
    [lastRunId, repoRoot, hostReady, clearPendingInteractions],
  );

  const abort = useCallback(async () => {
    const desk = api();
    const id = requestIdRef.current;
    if (!desk || !id) return;
    await desk.abortRun(id);
    clearPendingInteractions();
    setStatusText("已请求中止…");
  }, [clearPendingInteractions]);

  /** 审批卡决策：允许 / 拒绝 / 本会话始终允许 */
  const resolveApproval = useCallback(
    (approvalId: string, approved: boolean, always: boolean) => {
      const desk = api();
      const requestId = requestIdRef.current;
      setPendingApprovals((prev) =>
        prev.filter((a) => a.approvalId !== approvalId),
      );
      if (desk && requestId) {
        void desk.respondApproval({ requestId, approvalId, approved, always });
      }
      setStatusText(
        approved ? "已批准，继续执行…" : "已拒绝，等待 Agent 调整…",
      );
    },
    [],
  );

  /** 提问卡回答：回传宿主 + 以「系统问题条 + 用户气泡」沉淀进聊天流 */
  const answerAsk = useCallback((answer: string) => {
    const cur = pendingAskRef.current;
    pendingAskRef.current = null;
    setPendingAsk(null);
    if (!cur) return;
    setMessages((prev) => [
      ...prev,
      {
        id: newId("sys"),
        role: "system",
        content: `Paw 提问：${cur.question}`,
      },
      { id: newId("u"), role: "user", content: answer },
    ]);
    const desk = api();
    const requestId = requestIdRef.current;
    if (desk && requestId) {
      void desk.respondAskUser({ requestId, askId: cur.askId, answer });
    }
    setStatusText("已回答，继续执行…");
  }, []);

  /** errorBar：重试最近一次失败的任务 */
  const retryFailed = useCallback(() => {
    const goal = failedGoal;
    if (!goal || status === "running") return;
    setError(null);
    setFailedGoal(null);
    void send(goal);
  }, [failedGoal, status, send]);

  const dismissError = useCallback(() => {
    setError(null);
    setFailedGoal(null);
  }, []);

  /** 切换模型预设（settings.local.json 的 provider 字段） */
  const changeProvider = useCallback(
    (id: string) => {
      setProvider(id); // 乐观更新
      void requestSetSettings({ provider: id }, repoRoot || undefined)
        .then((s) => {
          if (!s.ok) return;
          setProvider(s.provider);
          setApprovalMode(s.approvalMode);
          setModelPresets(s.presets);
          // provider 变了，顶栏模型标签重新拉
          void requestHostStatus()
            .then((st) => {
              if (st.ok) setModelLabel(st.modelLabel || "—");
            })
            .catch(() => {});
        })
        .catch(() => {});
    },
    [repoRoot],
  );

  /** 切换审批模式（ask 逐条询问 / auto 自动批准） */
  const changeApprovalMode = useCallback(
    (mode: "ask" | "auto") => {
      setApprovalMode(mode); // 乐观更新
      void requestSetSettings({ approvalMode: mode }, repoRoot || undefined)
        .then((s) => {
          if (!s.ok) return;
          setApprovalMode(s.approvalMode);
        })
        .catch(() => {});
    },
    [repoRoot],
  );

  /** 清空当前会话消息（不删会话、不 finalize） */
  const clearCurrentMessages = useCallback(() => {
    if (status === "running") return;
    setMessages([]);
    setError(null);
    setFailedGoal(null);
    setStatus("idle");
    setStatusText(hostReady ? "Agent 就绪" : "等待 Agent");
    historyRef.current = [];
    pendingUserRef.current = null;
    historyCommittedRef.current = false;
    clearLiveActivities();
    clearPendingInteractions();
    persistActiveIntoSessions([], []);
  }, [
    status,
    hostReady,
    persistActiveIntoSessions,
    clearLiveActivities,
    clearPendingInteractions,
  ]);

  /** 新建会话并切换过去（旧会话保留在列表） */
  const newConversation = useCallback(() => {
    if (status === "running") return;
    // 离开当前会话：沉淀 memory
    finalizeSessionMemory(conversationIdRef.current);
    persistActiveIntoSessions(messagesRef.current, historyRef.current);

    const s = createEmptySession();
    setSessions((prev) => {
      const next = [s, ...prev.filter((x) => x.id !== s.id)];
      saveSessionsToStorage(next, s.id);
      return next;
    });
    setActiveSessionId(s.id);
    conversationIdRef.current = s.id;
    historyRef.current = [];
    setMessages([]);
    setError(null);
    setFailedGoal(null);
    setStatus("idle");
    setStatusText(hostReady ? "Agent 就绪" : "等待 Agent");
    pendingUserRef.current = null;
    historyCommittedRef.current = false;
    assistantIdRef.current = null;
    streamRawRef.current = "";
    streamThinkingRef.current = "";
    clearLiveActivities();
    clearPendingInteractions();
  }, [
    status,
    hostReady,
    finalizeSessionMemory,
    persistActiveIntoSessions,
    clearLiveActivities,
    clearPendingInteractions,
  ]);

  /** 切换到已有会话 */
  const selectSession = useCallback(
    (sessionId: string) => {
      if (status === "running") return;
      if (sessionId === conversationIdRef.current) return;
      const target = sessionsRef.current.find((s) => s.id === sessionId);
      if (!target) return;

      // 离开当前
      finalizeSessionMemory(conversationIdRef.current);
      persistActiveIntoSessions(messagesRef.current, historyRef.current);

      setActiveSessionId(target.id);
      conversationIdRef.current = target.id;
      historyRef.current = [...target.history];
      setMessages([...target.messages]);
      setError(null);
      setFailedGoal(null);
      setStatus("idle");
      setStatusText(hostReady ? "Agent 就绪" : "等待 Agent");
      pendingUserRef.current = null;
      historyCommittedRef.current = false;
      assistantIdRef.current = null;
      streamRawRef.current = "";
      streamThinkingRef.current = "";
      clearLiveActivities();
      clearPendingInteractions();
      saveSessionsToStorage(sessionsRef.current, target.id);
    },
    [
      status,
      hostReady,
      finalizeSessionMemory,
      persistActiveIntoSessions,
      clearLiveActivities,
      clearPendingInteractions,
    ],
  );

  /** 删除会话（finalize + 从列表移除） */
  const deleteSession = useCallback(
    (sessionId: string) => {
      if (status === "running") return;
      finalizeSessionMemory(sessionId);

      setSessions((prev) => {
        let next = prev.filter((s) => s.id !== sessionId);
        if (next.length === 0) {
          next = [createEmptySession()];
        }
        const switchingAway = conversationIdRef.current === sessionId;
        const nextActive = switchingAway
          ? next[0]!.id
          : conversationIdRef.current;
        saveSessionsToStorage(next, nextActive);

        if (switchingAway) {
          const t = next[0]!;
          conversationIdRef.current = t.id;
          historyRef.current = [...t.history];
          setActiveSessionId(t.id);
          setMessages([...t.messages]);
          setError(null);
          setStatus("idle");
          setStatusText(hostReady ? "Agent 就绪" : "等待 Agent");
        }
        return next;
      });
    },
    [status, hostReady, finalizeSessionMemory],
  );

  /** 兼容：清空 → 当前会话消息；侧栏「新对话」用 newConversation */
  const clear = newConversation;

  return {
    messages,
    status,
    statusText,
    repoRoot,
    hostReady,
    error,
    send,
    abort,
    clear,
    clearCurrentMessages,
    newConversation,
    selectSession,
    deleteSession,
    sessions,
    activeSessionId,
    isRunning: status === "running",
    conversationId: conversationIdRef.current,
    lastRunId,
    activities,
    selectedActivityId,
    selectActivity,
    modelLabel,
    skillsCount,
    agentRoster,
    agentRunStatus,
    pendingApprovals,
    pendingAsk,
    resolveApproval,
    answerAsk,
    failedGoal,
    retryFailed,
    dismissError,
    toolBatches,
    fileChanges,
    approvalMode,
    modelPresets,
    provider,
    changeProvider,
    changeApprovalMode,
  };
}
