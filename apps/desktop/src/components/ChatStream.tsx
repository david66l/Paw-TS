import {
  type KeyboardEvent,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { formatModelTextForUi } from "../agent/formatModelText";
import type {
  FileChangeItem,
  PendingApprovalItem,
  PendingAskItem,
  RunActivity,
  RunStatus,
  SubAgentInfo,
  ToolBatch,
  UiMessage,
} from "../agent/types";
import { ApprovalCard } from "./ApprovalCard";
import { AskUserCard } from "./AskUserCard";
import { ChangedFilesCard } from "./ChangedFilesCard";
import styles from "./ChatStream.module.css";
import { GlassPanel } from "./GlassPanel";
import { Markdown } from "./Markdown";
import { ToolBatchCard } from "./ToolBatchCard";

/** 展示时再洗一遍：历史里可能残留 final_answer JSON 原文 */
function displayAssistantText(raw: string): string {
  if (!raw) return raw;
  if (!/"action"\s*:|"tool"\s*:/.test(raw)) return raw;
  const cleaned = formatModelTextForUi(raw);
  return cleaned ?? "";
}

export type ChatStreamProps = {
  readonly messages: readonly UiMessage[];
  readonly status: RunStatus;
  readonly statusText: string;
  readonly isRunning: boolean;
  readonly error: string | null;
  readonly hostReady: boolean;
  readonly modelLabel?: string;
  readonly skillsCount?: number;
  readonly lastRunId?: string | null;
  readonly activities: readonly RunActivity[];
  readonly selectedActivityId: string | null;
  readonly toolBatches: readonly ToolBatch[];
  readonly fileChanges: readonly FileChangeItem[];
  readonly onViewDetails: (id: string) => void;
  readonly onSend: (text: string) => void;
  readonly onAbort: () => void;
  readonly onClear: () => void;
  readonly pendingApprovals: readonly PendingApprovalItem[];
  readonly onResolveApproval: (
    approvalId: string,
    approved: boolean,
    always: boolean,
  ) => void;
  readonly pendingAsk: PendingAskItem | null;
  readonly onAnswerAsk: (answer: string) => void;
  /** 最近一次失败的任务目标（errorBar 重试）；null = 无可重试 */
  readonly failedGoal: string | null;
  readonly onRetry: () => void;
  readonly onDismissError: () => void;
  readonly approvalMode: "ask" | "auto";
};

function Avatar({ role }: { role: "user" | "assistant" }) {
  if (role === "user") {
    return <div className={styles.avatarUser}>你</div>;
  }
  return <div className={styles.avatarPaw}>🐾</div>;
}

/**
 * 思考过程：默认收起，只显示「思考中/思考过程」标题，点开才展开。
 * 限高 + 块内滚动，避免撑爆对话区。
 */
function ThinkingBlock({
  text,
  streaming,
}: {
  text: string;
  streaming?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 流式时自动滚到底，方便看最新思考
  useEffect(() => {
    if (!streaming || !open) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text, streaming, open]);

  if (!text.trim()) return null;

  return (
    <div className={styles.thinking}>
      <button
        type="button"
        className={styles.thinkingHeader}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className={styles.thinkingLabel}>
          {streaming ? "思考中" : "思考过程"}
          {streaming ? <span className={styles.thinkingPulse} /> : null}
        </span>
        <span className={styles.thinkingToggle}>{open ? "收起" : "展开"}</span>
      </button>
      {open ? (
        <div ref={scrollRef} className={styles.thinkingBody}>
          <Markdown text={text} className={styles.thinkingMd} />
        </div>
      ) : (
        <div className={styles.thinkingPreview}>
          {text.slice(0, 80)}
          {text.length > 80 ? "…" : ""}
        </div>
      )}
    </div>
  );
}

/** 复制文本：优先 clipboard API，窗口未聚焦时回退 execCommand */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/** 消息行悬停操作：复制（+ 用户消息的编辑重发） */
function RowActions({
  text,
  onEdit,
}: {
  text: string;
  onEdit?: (text: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={styles.rowActions}>
      {onEdit ? (
        <button
          type="button"
          className={styles.rowActionBtn}
          title="编辑重发"
          onClick={() => onEdit(text)}
        >
          ✎
        </button>
      ) : null}
      <button
        type="button"
        className={copied ? styles.rowActionBtnCopied : styles.rowActionBtn}
        title={copied ? "已复制" : "复制"}
        onClick={() => {
          void copyText(text).then((ok) => {
            if (!ok) return;
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          });
        }}
      >
        {copied ? "✓" : "⧉"}
      </button>
    </div>
  );
}

/**
 * 单条消息行。memo：upsertAssistant 只 new 变化的那条消息对象，
 * 未变的历史消息保持引用不变 → 流式时跳过重渲染。
 * 用户气泡保留液态玻璃；Paw 回答改纯内容层（去玻璃，提升密度/可读性/合成负担）。
 */
const MessageRow = memo(function MessageRow({
  m,
  onEdit,
}: {
  m: UiMessage;
  onEdit?: (text: string) => void;
}) {
  if (m.role === "system") {
    return (
      <div className={styles.rowSystem}>
        <div className={styles.systemChip}>{m.content}</div>
      </div>
    );
  }
  if (m.role === "user") {
    return (
      <div className={styles.rowUser}>
        <div className={styles.msgRow}>
          <Avatar role="user" />
          <GlassPanel
            variant="strong"
            padding="md"
            className={styles.bubbleUser}
          >
            <div className={styles.roleRow}>
              <span className={styles.role}>You</span>
            </div>
            <div className={styles.body}>{m.content}</div>
          </GlassPanel>
          <RowActions text={m.content} onEdit={onEdit} />
        </div>
      </div>
    );
  }
  // assistant —— 纯内容层，不包玻璃
  const body = displayAssistantText(m.content);
  return (
    <div className={styles.rowAssistant}>
      <div className={styles.msgRow}>
        <Avatar role="assistant" />
        <div className={styles.assistantPlain}>
          <div className={styles.roleRow}>
            <span className={styles.role}>Paw</span>
            {m.streaming ? (
              <span className={styles.streaming}>
                {m.thinking && !m.content ? "思考中…" : "生成中…"}
              </span>
            ) : null}
          </div>
          {m.thinking ? (
            <ThinkingBlock
              text={m.thinking}
              streaming={m.streaming && !m.content}
            />
          ) : null}
          {body ? (
            <Markdown text={body} className={styles.body} />
          ) : m.streaming ? (
            <div className={styles.bodyPlaceholder}>
              {m.thinking ? "等待回答…" : "…"}
            </div>
          ) : null}
        </div>
        {body && !m.streaming ? <RowActions text={body} /> : null}
      </div>
    </div>
  );
});

function execDotClass(status: SubAgentInfo["status"]): string {
  if (status === "done") return styles.execDotDone ?? "";
  if (status === "failed") return styles.execDotFail ?? "";
  return styles.execDotRun ?? "";
}

/**
 * 执行摘要卡：并行子 Agent 的聊天流入口（非玻璃，中性数据卡）。
 * 运行中展开每 agent 状态行；完成后收成一行 + 查看详情。
 * 无实时 activity（重载会话）→ 用标记消息的 content 静态单行兜底。
 */
const ExecutionCard = memo(function ExecutionCard({
  activityId,
  activity,
  fallback,
  selected,
  onViewDetails,
}: {
  activityId: string;
  activity?: RunActivity;
  fallback: string;
  selected: boolean;
  onViewDetails: (id: string) => void;
}) {
  if (!activity) {
    return (
      <div className={styles.execCard}>
        <div className={styles.execDone}>{fallback}</div>
      </div>
    );
  }
  const ops = activity.agents.reduce((n, a) => n + a.toolCount, 0);
  if (activity.status === "running") {
    return (
      <div className={styles.execCard}>
        <div className={styles.execHead}>
          <span className={`${styles.execDot} ${styles.execDotRun}`} />
          <span className={styles.execTitle}>并行执行 · 运行中</span>
          <span className={styles.execMeta}>
            {activity.agents.length} 个 Agent
          </span>
        </div>
        <div className={styles.execRows}>
          {activity.agents.map((a) => (
            <div key={a.id} className={styles.execRow}>
              <span className={`${styles.execDot} ${execDotClass(a.status)}`} />
              <span className={styles.execLabel} title={a.label}>
                {a.label}
              </span>
              <span className={styles.execCount}>{a.toolCount} 次操作</span>
              {a.lastTool ? (
                <span className={styles.execTool}>{a.lastTool}</span>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    );
  }
  const failed = activity.status === "failed";
  const secs =
    activity.finishedAt && activity.startedAt
      ? Math.max(
          1,
          Math.round((activity.finishedAt - activity.startedAt) / 1000),
        )
      : 0;
  return (
    <div className={`${styles.execCard} ${selected ? styles.execCardSel : ""}`}>
      <div className={styles.execDone}>
        <span
          className={`${styles.execDot} ${
            failed ? styles.execDotFail : styles.execDotDone
          }`}
        />
        <span className={styles.execTitle}>
          {failed ? "并行执行 · 部分失败" : "并行执行 · 已完成"}
        </span>
        <span className={styles.execMeta}>
          {activity.agents.length} 个 Agent · {ops} 次操作 · {secs} 秒
        </span>
        <button
          type="button"
          className={styles.execViewBtn}
          onClick={() => onViewDetails(activityId)}
        >
          查看详情 →
        </button>
      </div>
    </div>
  );
});

export function ChatStream({
  messages,
  status,
  statusText,
  isRunning,
  error,
  hostReady,
  modelLabel,
  skillsCount,
  lastRunId,
  activities,
  selectedActivityId,
  toolBatches,
  fileChanges,
  onViewDetails,
  onSend,
  onAbort,
  onClear,
  pendingApprovals,
  onResolveApproval,
  pendingAsk,
  onAnswerAsk,
  failedGoal,
  onRetry,
  onDismissError,
  approvalMode,
}: ChatStreamProps) {
  const [draft, setDraft] = useState("");
  const streamRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const stickBottomRef = useRef(true);

  /** 编辑重发：把历史用户消息灌回输入框（运行中禁用，由调用处控制） */
  const handleEditMessage = useCallback((text: string) => {
    setDraft(text);
    inputRef.current?.focus();
  }, []);
  const byId = useMemo(
    () => Object.fromEntries(activities.map((a) => [a.id, a])),
    [activities],
  );
  const batchById = useMemo(
    () => Object.fromEntries(toolBatches.map((b) => [b.id, b])),
    [toolBatches],
  );

  useEffect(() => {
    const el = streamRef.current;
    if (!el || !stickBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, isRunning, statusText]);

  const onStreamScroll = () => {
    const el = streamRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickBottomRef.current = dist < 80;
  };

  const submit = () => {
    const t = draft.trim();
    if (!t || isRunning) return;
    setDraft("");
    stickBottomRef.current = true;
    onSend(t);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const statusBadge =
    status === "running"
      ? styles.badgeRunning
      : status === "failed"
        ? styles.badgeFailed
        : status === "completed"
          ? styles.badgeDone
          : status === "aborted"
            ? styles.badgeAborted
            : styles.badgeIdle;

  const statusLabel =
    status === "running"
      ? "运行中"
      : status === "failed"
        ? "失败"
        : status === "completed"
          ? "完成"
          : status === "aborted"
            ? "已中止"
            : hostReady
              ? "就绪"
              : "连接中";

  const firstUser = messages.find((m) => m.role === "user")?.content?.trim();
  const sessionTitle = firstUser
    ? firstUser.length > 36
      ? `${firstUser.slice(0, 36)}…`
      : firstUser
    : "当前会话";
  const firstApproval = pendingApprovals[0];

  return (
    <section className={styles.main}>
      <header className={styles.topBar}>
        <div className={styles.topLeft}>
          <div className={styles.topTitle} title={firstUser || undefined}>
            {sessionTitle}
          </div>
          <div className={styles.topMeta}>
            {[
              status === "completed" || status === "failed"
                ? hostReady
                  ? "Agent 就绪"
                  : statusText
                : statusText,
              lastRunId ? `run ${lastRunId.slice(0, 16)}` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </div>
        </div>
        <div className={styles.topRight}>
          <span
            className={styles.modelChip}
            title={
              modelLabel && modelLabel !== "—"
                ? `当前模型：${modelLabel}${
                    typeof skillsCount === "number"
                      ? ` · ${skillsCount} skills`
                      : ""
                  }`
                : hostReady
                  ? "正在读取模型配置…"
                  : "Agent 未就绪"
            }
          >
            {modelLabel && modelLabel !== "—"
              ? modelLabel
              : hostReady
                ? "模型…"
                : "—"}
          </span>
          <span className={`${styles.badge} ${statusBadge}`}>
            <span className={styles.badgeDot} />
            {statusLabel}
          </span>
        </div>
      </header>

      <div
        ref={streamRef}
        className={`${styles.stream} selectable`}
        onScroll={onStreamScroll}
      >
        {messages.length === 0 ? (
          <div className={styles.empty}>
            <div className={styles.emptyIcon}>🐾</div>
            <div className={styles.emptyTitle}>开始和 Paw 协作</div>
            <div className={styles.emptyBody}>
              描述任务，或输入 /help 查看 doctor、undo、run 历史等命令
            </div>
            <div className={styles.suggestions}>
              {["列出工作区顶层目录", "/doctor", "/help"].map((s) => (
                <button
                  key={s}
                  type="button"
                  className={styles.chip}
                  disabled={isRunning || !hostReady}
                  onClick={() => onSend(s)}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m) => {
            if (m.role === "activity") {
              return (
                <ExecutionCard
                  key={m.id}
                  activityId={m.activityId ?? ""}
                  activity={m.activityId ? byId[m.activityId] : undefined}
                  fallback={m.content}
                  selected={selectedActivityId === m.activityId}
                  onViewDetails={onViewDetails}
                />
              );
            }
            if (m.role === "toolbatch") {
              return (
                <ToolBatchCard
                  key={m.id}
                  batch={m.toolBatchId ? batchById[m.toolBatchId] : undefined}
                  fallback={m.content}
                />
              );
            }
            if (m.role === "changes") {
              return (
                <ChangedFilesCard
                  key={m.id}
                  changes={fileChanges}
                  fallback={m.content}
                />
              );
            }
            return (
              <MessageRow
                key={m.id}
                m={m}
                onEdit={isRunning ? undefined : handleEditMessage}
              />
            );
          })
        )}
      </div>

      {pendingAsk ? (
        <AskUserCard
          question={pendingAsk.question}
          timeoutSec={pendingAsk.timeoutSec}
          onSubmit={onAnswerAsk}
        />
      ) : null}

      {firstApproval ? (
        <ApprovalCard
          item={firstApproval}
          queueSize={pendingApprovals.length}
          onResolve={onResolveApproval}
        />
      ) : null}

      {error || failedGoal ? (
        <div className={styles.errorBar} role="alert">
          <span className={styles.errorText}>{error ?? "任务失败"}</span>
          {failedGoal ? (
            <button
              type="button"
              className={styles.retryBtn}
              title={`重试：${failedGoal.slice(0, 80)}`}
              onClick={onRetry}
            >
              重试
            </button>
          ) : null}
          <button
            type="button"
            className={styles.errorClose}
            aria-label="关闭错误提示"
            onClick={onDismissError}
          >
            ×
          </button>
        </div>
      ) : null}

      <div className={styles.composerWrap}>
        <GlassPanel variant="strong" padding="sm" className={styles.composer}>
          <textarea
            ref={inputRef}
            className={styles.input}
            rows={2}
            placeholder={
              isRunning
                ? "任务运行中… 可点中止"
                : hostReady
                  ? "描述任务，Enter 发送，Shift+Enter 换行"
                  : "等待 Agent 宿主…"
            }
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={isRunning || !hostReady}
          />
          <div className={styles.composerBar}>
            <span className={styles.hint}>
              {isRunning
                ? "Agent 正在执行"
                : hostReady
                  ? approvalMode === "auto"
                    ? "本机 Bun · 自动批准工具"
                    : "本机 Bun · 修改性工具需审批"
                  : "宿主未就绪"}
            </span>
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.secondaryBtn}
                onClick={onClear}
                disabled={isRunning || messages.length === 0}
              >
                清空
              </button>
              {isRunning ? (
                <button
                  type="button"
                  className={styles.abortBtn}
                  onClick={onAbort}
                >
                  中止
                </button>
              ) : (
                <button
                  type="button"
                  className={styles.sendBtn}
                  onClick={submit}
                  disabled={!draft.trim() || !hostReady}
                  aria-label="发送"
                >
                  发送
                  <span className={styles.sendIcon} aria-hidden>
                    ↵
                  </span>
                </button>
              )}
            </div>
          </div>
        </GlassPanel>
      </div>
    </section>
  );
}
