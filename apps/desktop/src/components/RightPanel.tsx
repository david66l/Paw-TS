import { memo, useEffect, useRef, useState } from "react";
import { shortToolName } from "../agent/toolCards";
import type { AgentRunStatus, RunActivity, SubAgentInfo } from "../agent/types";
import type {
  ChangeEntry,
  ContextSnapshot,
  MemorySnapshot,
  PlanState,
} from "../agent/useRightPanelData";
import { currentPlanItemId, planProgress } from "../agent/useRightPanelData";
import { GlassPanel } from "./GlassPanel";
import styles from "./RightPanel.module.css";

export type RightTabId = "plan" | "changes" | "context" | "memory" | "agents";

const TABS: readonly { id: RightTabId; label: string }[] = [
  { id: "plan", label: "Plan" },
  { id: "changes", label: "Changes" },
  { id: "context", label: "Context" },
  { id: "memory", label: "Memory" },
  { id: "agents", label: "Agents" },
];

const AGENT_DOT: Record<SubAgentInfo["status"], string> = {
  running: styles.agentDotRunning ?? "",
  done: styles.agentDotDone ?? "",
  failed: styles.agentDotFail ?? "",
};

const AGENT_STATUS_TEXT: Record<SubAgentInfo["status"], string> = {
  running: "运行中",
  done: "完成",
  failed: "失败",
};

export type AgentRosterItem = {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly emoji?: string;
  readonly kind: string;
  readonly description?: string;
  readonly childPolicy?: string;
  readonly canSpawn?: boolean;
  readonly model?: string;
  readonly maxSteps?: number;
  readonly tools?: "inherit" | readonly string[];
};

export interface RightPanelProps {
  readonly plan: PlanState;
  readonly changes: readonly ChangeEntry[];
  readonly context: ContextSnapshot | null;
  readonly memory: MemorySnapshot | null;
  readonly activities: readonly RunActivity[];
  readonly selectedActivityId: string | null;
  /** 注册表花名册（.paw/agents） */
  readonly agentRoster?: readonly AgentRosterItem[];
  /** 各 agent id 的运行态：running=绿点，idle=灰点 */
  readonly agentRunStatus?: Record<string, AgentRunStatus>;
  readonly tab: RightTabId;
  readonly onTabChange: (tab: RightTabId) => void;
  readonly onRefreshMemoryLibrary?: () => void;
}

// ---------------------------------------------------------------------------
// Empty states
// ---------------------------------------------------------------------------

function EmptyState({ icon, label }: { icon: string; label: string }) {
  return (
    <div className={styles.empty}>
      <div className={styles.emptyIcon}>{icon}</div>
      <div className={styles.emptyTitle}>{label}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab content renderers
// ---------------------------------------------------------------------------

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

/** 状态 → 图标内容（文本）与样式键 */
function planItemIcon(status: string | undefined): {
  glyph: string;
  cls: string;
} {
  switch (status) {
    case "completed":
    case "done":
      return { glyph: "✓", cls: styles.planIconDone ?? "" };
    case "skipped":
      return { glyph: "⤼", cls: styles.planIconSkipped ?? "" };
    case "running":
      return { glyph: "", cls: styles.planIconRunning ?? "" };
    case "failed":
      return { glyph: "✗", cls: styles.planIconFailed ?? "" };
    case "blocked":
      return { glyph: "⊘", cls: styles.planIconBlocked ?? "" };
    default:
      return { glyph: "", cls: styles.planIconPending ?? "" };
  }
}

function PlanTab({ plan }: { plan: PlanState }) {
  const hasItems = plan.items.length > 0;
  const hasMeta = plan.revision !== undefined || plan.reason !== undefined;

  const { done, total, pct } = planProgress(plan.items);
  const currentId = currentPlanItemId(plan.items);
  const currentItem = currentId
    ? plan.items.find((i) => i.id === currentId)
    : undefined;
  const currentRunning = currentItem?.status === "running";

  // 当前步骤计时：id 变化时重置；running 期间每秒走表
  const sinceRef = useRef<{ id: string | null; since: number }>({
    id: null,
    since: 0,
  });
  if (sinceRef.current.id !== currentId) {
    sinceRef.current = { id: currentId, since: Date.now() };
  }
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!currentRunning) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [currentRunning]);

  if (!hasItems && !hasMeta) {
    return <EmptyState icon="◎" label="暂无执行计划" />;
  }

  return (
    <div className={styles.tabContent}>
      {hasItems && (
        <>
          <div className={styles.planHeadRow}>
            <span className={styles.planHeadCount}>
              {done} of {total} steps
            </span>
            <span className={styles.planHeadPct}>{pct}%</span>
          </div>
          <div className={styles.planTrack}>
            <div className={styles.planFill} style={{ width: `${pct}%` }} />
          </div>
          <ol className={styles.planList}>
            {plan.items.map((item, idx) => {
              const isDone =
                item.status === "completed" ||
                item.status === "done" ||
                item.status === "skipped";
              const isCurrent = item.id === currentId;
              const icon = planItemIcon(item.status);
              return (
                <li
                  key={item.id}
                  className={`${styles.planItem} ${
                    isCurrent ? styles.planItemCurrent : ""
                  }`}
                >
                  <span className={`${styles.planIcon} ${icon.cls}`}>
                    {icon.glyph}
                  </span>
                  <span className={styles.planIndex}>{idx + 1}</span>
                  <div className={styles.planTextCol}>
                    <span
                      className={`${styles.planText} ${
                        isDone ? styles.planTextDone : ""
                      } ${isCurrent ? styles.planTextCurrent : ""}`}
                    >
                      {item.text}
                    </span>
                    {isCurrent && currentRunning ? (
                      <span className={styles.planElapsed}>
                        进行中 · {formatElapsed(now - sinceRef.current.since)}
                      </span>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
        </>
      )}
      {(plan.revision !== undefined || plan.reason) && (
        <div className={styles.planMeta}>
          {plan.revision !== undefined && (
            <span className={styles.badge}>rev {plan.revision}</span>
          )}
          {plan.reason && (
            <span className={styles.planReason}>{plan.reason}</span>
          )}
        </div>
      )}
    </div>
  );
}

function ChangesTab({ changes }: { changes: readonly ChangeEntry[] }) {
  if (changes.length === 0) {
    return <EmptyState icon="Δ" label="暂无文件变更" />;
  }

  return (
    <ul className={styles.changeList}>
      {changes.map((c) => (
        <li key={`${c.path}-${c.at}`} className={styles.changeItem}>
          <span
            className={`${styles.changeDot} ${
              c.ok === false ? styles.changeDotFail : styles.changeDotOk
            }`}
          />
          <span className={styles.changePath} title={c.path}>
            {c.path}
          </span>
          {typeof c.added === "number" || typeof c.removed === "number" ? (
            <span className={styles.changeStats}>
              {(c.added ?? 0) > 0 ? (
                <span className={styles.changeAdd}>+{c.added}</span>
              ) : null}
              {(c.removed ?? 0) > 0 ? (
                <span className={styles.changeDel}>−{c.removed}</span>
              ) : null}
            </span>
          ) : null}
          {c.summary && (
            <span className={styles.changeSummary}>{c.summary}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

function agentDurationSecs(a: RunActivity): number {
  if (!a.finishedAt || !a.startedAt) return 0;
  return Math.max(1, Math.round((a.finishedAt - a.startedAt) / 1000));
}

function roleDotClass(status: AgentRunStatus | undefined): string {
  switch (status) {
    case "running":
      return styles.roleDotRunning ?? "";
    case "done":
      return styles.roleDotDone ?? "";
    case "failed":
      return styles.roleDotFail ?? "";
    default:
      return styles.roleDotIdle ?? "";
  }
}

function roleStatusText(status: AgentRunStatus | undefined): string {
  switch (status) {
    case "running":
      return "运行中";
    case "done":
      return "完成";
    case "failed":
      return "失败";
    default:
      return "空闲";
  }
}

/** 花名册顺序：狸花 → 暹罗 → 边牧 → 德牧 → 萨摩 → 柯基 → 布偶 → 金毛 */
const ROSTER_ORDER = [
  "lihua",
  "xianluo",
  "bianmu",
  "demu",
  "samo",
  "keji",
  "buou",
  "jinmao",
] as const;

function sortRoster(roster: readonly AgentRosterItem[]): AgentRosterItem[] {
  const rank = new Map(ROSTER_ORDER.map((id, i) => [id, i]));
  return [...roster]
    .filter((r) => !r.id.startsWith("tmp-"))
    .sort((a, b) => {
      const ra = rank.get(a.id as (typeof ROSTER_ORDER)[number]);
      const rb = rank.get(b.id as (typeof ROSTER_ORDER)[number]);
      if (ra !== undefined && rb !== undefined) return ra - rb;
      if (ra !== undefined) return -1;
      if (rb !== undefined) return 1;
      return a.name.localeCompare(b.name, "zh");
    });
}

/** 子 Agent 实时工具流（最近 N 条） */
function AgentToolStream({ agent }: { agent: SubAgentInfo }) {
  const tools = agent.tools ?? [];
  if (tools.length === 0) return null;
  return (
    <div className={styles.agentField}>
      <div className={styles.agentFieldLabel}>实时工具流 · {tools.length}</div>
      <ul className={styles.toolStream}>
        {tools.map((t) => (
          <li key={t.id} className={styles.toolStreamItem}>
            <span
              className={`${styles.toolStreamDot} ${
                t.ok === undefined
                  ? styles.toolStreamDotRun
                  : t.ok
                    ? styles.toolStreamDotOk
                    : styles.toolStreamDotFail
              }`}
            />
            <span className={styles.toolStreamTool}>
              {shortToolName(t.tool)}
            </span>
            <span
              className={styles.toolStreamSummary}
              title={t.result ?? t.summary}
            >
              {t.result ?? t.summary}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function AgentsTab({
  activities,
  selectedActivityId,
  roster,
  runStatus,
}: {
  activities: readonly RunActivity[];
  selectedActivityId: string | null;
  roster: readonly AgentRosterItem[];
  runStatus: Record<string, AgentRunStatus>;
}) {
  const activity =
    activities.find((a) => a.id === selectedActivityId) ?? activities.at(-1);
  const [openId, setOpenId] = useState<string | null>(null);
  /** 花名册展开详情的 agent id（与 activity 展开共用一套互斥状态） */
  const [openRosterId, setOpenRosterId] = useState<string | null>(null);

  const hasDetail = activity && activity.agents.length > 0;
  const agents = activity?.agents ?? [];
  const failed = agents.filter((a) => a.status === "failed").length;
  const running = agents.some((a) => a.status === "running");
  const head = running ? "运行中" : failed > 0 ? `${failed} 失败` : "全部完成";
  const secs = activity ? agentDurationSecs(activity) : 0;

  const visibleRoster = sortRoster(roster);

  return (
    <div className={styles.tabContent}>
      {visibleRoster.length > 0 ? (
        <ul className={styles.roleList}>
          {visibleRoster.map((r) => {
            const st = runStatus[r.id] ?? "idle";
            const open = openRosterId === r.id;
            const toolList =
              r.tools === "inherit" || r.tools === undefined ? null : r.tools;
            return (
              <li key={r.id}>
                <button
                  type="button"
                  className={styles.roleItem}
                  onClick={() => setOpenRosterId(open ? null : r.id)}
                  aria-expanded={open}
                >
                  <span
                    className={`${styles.roleDot} ${roleDotClass(st)}`}
                    title={roleStatusText(st)}
                    aria-label={roleStatusText(st)}
                  />
                  <span className={styles.roleAvatar}>{r.emoji ?? "◎"}</span>
                  <div className={styles.roleBody}>
                    <span className={styles.rolePet}>{r.name}</span>
                    <span className={styles.roleName}>{r.role}</span>
                  </div>
                  <span className={styles.roleStatusText}>
                    {roleStatusText(st)}
                  </span>
                  <span className={styles.roleCaret}>{open ? "▴" : "▾"}</span>
                </button>
                {open ? (
                  <div className={styles.roleDetail}>
                    {r.description ? (
                      <div className={styles.roleDesc}>{r.description}</div>
                    ) : null}
                    <div className={styles.roleConfig}>
                      <span className={styles.roleCfg}>
                        模型 {r.model ?? "inherit"}
                      </span>
                      <span className={styles.roleCfg}>
                        步数 {r.maxSteps ?? "—"}
                      </span>
                      <span className={styles.roleCfg}>
                        {r.childPolicy === "read_write" ? "可写" : "只读"}
                      </span>
                      {r.canSpawn ? (
                        <span className={styles.roleCfg}>可派生</span>
                      ) : null}
                    </div>
                    {toolList ? (
                      <div className={styles.roleTools}>
                        {toolList.map((t) => (
                          <span key={t} className={styles.roleToolChip}>
                            {shortToolName(t)}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <div className={styles.roleToolsMuted}>继承全部工具</div>
                    )}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <EmptyState icon="◎" label="加载 Agent 列表…" />
      )}
      {!hasDetail ? (
        roster.length > 0 ? (
          <div className={styles.agentHead}>本次尚无子 Agent 运行</div>
        ) : null
      ) : (
        <div className={styles.agentHead}>
          本次子 Agent · {agents.length} · {head}
          {secs > 0 ? ` · ${secs} 秒` : ""}
        </div>
      )}
      {hasDetail ? (
        <>
          <ul className={styles.agentList}>
            {agents.map((a) => {
              const open = openId === a.id;
              return (
                <li key={a.id} className={styles.agentItem}>
                  <button
                    type="button"
                    className={styles.agentRowBtn}
                    onClick={() => setOpenId(open ? null : a.id)}
                  >
                    <span
                      className={`${styles.agentDot} ${AGENT_DOT[a.status]}`}
                    />
                    <span className={styles.agentLabel} title={a.label}>
                      {a.label}
                    </span>
                    <span className={styles.agentCount}>
                      {a.toolCount} 次操作
                    </span>
                    {a.tools?.some(
                      (t) => t.tool === "file_lock" && t.ok === false,
                    ) ? (
                      <span className={styles.agentLockChip}>锁冲突</span>
                    ) : null}
                    <span className={styles.agentStatus}>
                      {AGENT_STATUS_TEXT[a.status]}
                    </span>
                    <span className={styles.agentCaret}>
                      {open ? "收起" : "展开"}
                    </span>
                  </button>
                  {open ? (
                    <div className={styles.agentExpand}>
                      <div className={styles.agentField}>
                        <div className={styles.agentFieldLabel}>任务目标</div>
                        <div className={styles.agentFieldBody}>{a.label}</div>
                      </div>
                      <AgentToolStream agent={a} />
                      {a.summary ? (
                        <div className={styles.agentField}>
                          <div className={styles.agentFieldLabel}>
                            结构化摘要
                          </div>
                          <div className={styles.agentFieldBody}>
                            {a.summary}
                          </div>
                        </div>
                      ) : null}
                      {a.error ? (
                        <div className={styles.agentField}>
                          <div className={styles.agentFieldLabel}>错误</div>
                          <div className={styles.agentFieldBody}>{a.error}</div>
                        </div>
                      ) : null}
                      {a.files.length > 0 ? (
                        <div className={styles.agentField}>
                          <div className={styles.agentFieldLabel}>
                            关键文件 · {a.files.length}
                          </div>
                          <ul className={styles.agentFiles}>
                            {a.files.map((f) => (
                              <li
                                key={f}
                                className={styles.agentFile}
                                title={f}
                              >
                                {f}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
    </div>
  );
}

function ContextTab({ context }: { context: ContextSnapshot | null }) {
  if (!context) {
    return <EmptyState icon="◇" label="等待上下文数据" />;
  }

  const { turn, maxSteps, estimatedTokens, budget, cost, recentFiles } =
    context;
  const hasBody =
    turn !== undefined ||
    estimatedTokens !== undefined ||
    budget ||
    cost ||
    (recentFiles && recentFiles.length > 0);

  if (!hasBody) {
    return <EmptyState icon="◇" label="等待上下文数据" />;
  }

  return (
    <div className={styles.tabContent}>
      {recentFiles && recentFiles.length > 0 && (
        <div className={styles.statGroup}>
          <div className={styles.statLabel}>相关文件（本 run）</div>
          <ul className={styles.fileList}>
            {recentFiles.map((p) => (
              <li key={p} className={styles.fileItem} title={p}>
                {p}
              </li>
            ))}
          </ul>
        </div>
      )}

      {(turn !== undefined || maxSteps !== undefined) && (
        <div className={styles.statGroup}>
          <div className={styles.statLabel}>循环</div>
          <div className={styles.statRow}>
            {turn !== undefined && (
              <span className={styles.stat}>
                Turn {turn}
                {maxSteps !== undefined ? ` / ${maxSteps}` : ""}
              </span>
            )}
          </div>
        </div>
      )}

      {estimatedTokens !== undefined && (
        <div className={styles.statGroup}>
          <div className={styles.statLabel}>估算 Token</div>
          <div className={styles.statRow}>
            <span className={styles.stat}>
              {estimatedTokens.toLocaleString()}
            </span>
          </div>
        </div>
      )}

      {budget && (
        <div className={styles.statGroup}>
          <div className={styles.statLabel}>上下文预算</div>
          <div className={styles.budgetGrid}>
            <BudgetBar
              label="System"
              used={budget.systemUsed}
              budget={budget.systemBudget}
            />
            <BudgetBar
              label="Tools"
              used={budget.toolsUsed}
              budget={budget.toolsBudget}
            />
            <BudgetBar
              label="History"
              used={budget.historyUsed}
              budget={budget.historyBudget}
            />
          </div>
        </div>
      )}

      {cost && (
        <div className={styles.statGroup}>
          <div className={styles.statLabel}>Token 用量</div>
          <div className={styles.statRow}>
            <span className={styles.stat}>
              输入 {cost.promptTokens.toLocaleString()}
            </span>
            <span className={styles.stat}>
              输出 {cost.completionTokens.toLocaleString()}
            </span>
          </div>
          <div className={styles.statRow}>
            <span className={styles.statMuted}>
              累计 {cost.totalTokens.toLocaleString()} token
              {" · "}${cost.estimatedCostUsd.toFixed(4)}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function BudgetBar({
  label,
  used,
  budget: max,
}: {
  label: string;
  used: number;
  budget: number;
}) {
  const pct = max > 0 ? Math.min(100, Math.round((used / max) * 100)) : 0;
  return (
    <div className={styles.budgetBar}>
      <div className={styles.budgetBarLabel}>
        <span>{label}</span>
        <span>
          {used.toLocaleString()} / {max.toLocaleString()}
        </span>
      </div>
      <div className={styles.budgetTrack}>
        <div className={styles.budgetFill} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function MemoryTab({
  memory,
  onRefreshLibrary,
}: {
  memory: MemorySnapshot | null;
  onRefreshLibrary?: () => void;
}) {
  if (!memory) {
    return <EmptyState icon="◈" label="等待记忆检索" />;
  }

  const hits = memory.sessionHits ?? [];
  const library = memory.library ?? [];

  return (
    <div className={styles.tabContent}>
      <div className={styles.statGroup}>
        <div className={styles.statLabel}>本次会话命中</div>
        <div className={styles.statRow}>
          <span className={styles.stat}>{memory.selectedCount} 条</span>
          {memory.totalCandidates > 0 && (
            <span className={styles.statMuted}>
              / {memory.totalCandidates} 候选
            </span>
          )}
        </div>
        {memory.query ? (
          <div className={styles.memoryQuery} title={memory.query}>
            q: {memory.query}
          </div>
        ) : null}
        {hits.length === 0 ? (
          <div className={styles.statMuted}>尚无注入记忆（或尚未检索）</div>
        ) : (
          <ul className={styles.memoryList}>
            {hits.map((h) => (
              <li key={h.id} className={styles.memoryItem}>
                <div className={styles.memoryItemTitle}>
                  {h.type ? (
                    <span className={styles.memoryType}>{h.type}</span>
                  ) : null}
                  <span>{h.title}</span>
                  {typeof h.score === "number" ? (
                    <span className={styles.statMuted}>
                      {h.score.toFixed(2)}
                    </span>
                  ) : null}
                </div>
                {h.summary && h.summary !== h.title ? (
                  <div className={styles.memoryItemSummary}>{h.summary}</div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className={styles.statGroup}>
        <div className={styles.memoryLibraryHeader}>
          <div className={styles.statLabel}>总库（本工作区）</div>
          {onRefreshLibrary ? (
            <button
              type="button"
              className={styles.refreshBtn}
              onClick={onRefreshLibrary}
              disabled={memory.libraryLoading}
            >
              {memory.libraryLoading ? "加载中…" : "刷新"}
            </button>
          ) : null}
        </div>
        {memory.libraryOk === false ? (
          <div className={styles.statMuted}>
            {memory.libraryError ||
              "记忆库不可用（检查 Postgres / DATABASE_URL）"}
          </div>
        ) : null}
        {memory.libraryOk !== false && library.length === 0 ? (
          <div className={styles.statMuted}>
            {memory.libraryLoading ? "加载中…" : "暂无长期记忆条目"}
          </div>
        ) : null}
        {library.length > 0 ? (
          <ul className={styles.memoryList}>
            {library.map((it) => (
              <li key={it.id} className={styles.memoryItem}>
                <div className={styles.memoryItemTitle}>
                  <span className={styles.memoryType}>{it.type}</span>
                  <span>{it.title}</span>
                </div>
                {it.summary ? (
                  <div className={styles.memoryItemSummary}>
                    {it.summary.length > 160
                      ? `${it.summary.slice(0, 160)}…`
                      : it.summary}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

// ponytail: memo — App 每个 model.chunk 都重渲染，但面板数据（plan/changes/
// context/memory 均为 useState 值，回调为 useCallback）多数 chunk 不变，浅比较跳过。
export const RightPanel = memo(function RightPanel({
  plan,
  changes,
  context,
  memory,
  activities,
  selectedActivityId,
  agentRoster = [],
  agentRunStatus = {},
  tab,
  onTabChange,
  onRefreshMemoryLibrary,
}: RightPanelProps) {
  const selectedActivity =
    activities.find((a) => a.id === selectedActivityId) ?? activities.at(-1);
  const rosterVisible = sortRoster(agentRoster);
  // 角标 = 活跃数（运行中的花名册 + 运行中的子 Agent），无活跃不显示
  const activeCount =
    rosterVisible.filter((r) => agentRunStatus[r.id] === "running").length +
    (selectedActivity?.agents.filter((a) => a.status === "running").length ??
      0);

  return (
    <aside className={styles.right}>
      <div className={styles.dragPad} aria-hidden />
      <GlassPanel className={styles.panel} variant="default" padding="none">
        <div className={styles.tabs} role="tablist" aria-label="右侧面板">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={tab === t.id ? styles.tabActive : styles.tab}
              onClick={() => onTabChange(t.id)}
            >
              {t.label}
              {t.id === "agents" && activeCount > 0 ? (
                <span className={styles.tabCount}>{activeCount}</span>
              ) : null}
            </button>
          ))}
        </div>
        <div className={`${styles.body} selectable`} role="tabpanel">
          {tab === "plan" && <PlanTab plan={plan} />}
          {tab === "changes" && <ChangesTab changes={changes} />}
          {tab === "context" && <ContextTab context={context} />}
          {tab === "agents" && (
            <AgentsTab
              activities={activities}
              selectedActivityId={selectedActivityId}
              roster={agentRoster}
              runStatus={agentRunStatus}
            />
          )}
          {tab === "memory" && (
            <MemoryTab
              memory={memory}
              onRefreshLibrary={onRefreshMemoryLibrary}
            />
          )}
        </div>
      </GlassPanel>
    </aside>
  );
});
