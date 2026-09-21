import {
  FolderOpen,
  MessageSquare,
  NotebookText,
  Settings2,
  SquarePen,
} from "lucide-react";
import { memo, useEffect, useState } from "react";
import type { ChatSession } from "../agent/sessionTypes";
import { PawMark } from "./PawMark";
import styles from "./Sidebar.module.css";

export type SidebarProps = {
  readonly statusText: string;
  readonly repoRoot: string;
  readonly hostReady: boolean;
  readonly isRunning: boolean;
  readonly sessions: readonly ChatSession[];
  readonly activeSessionId: string;
  readonly onNewConversation: () => void;
  readonly onSelectSession: (id: string) => void;
  readonly onDeleteSession: (id: string) => void;
  readonly onOpenMemory: () => void;
  readonly onOpenSettings: () => void;
};

/** 工作区目录名（路径最后一段），用作 profile 卡副标题。 */
function workspaceLabel(full: string): string {
  if (!full) return "工作区";
  const parts = full.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || "工作区";
}

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  try {
    return new Date(ts).toLocaleDateString(undefined, {
      month: "numeric",
      day: "numeric",
    });
  } catch {
    return "";
  }
}

// ponytail: memo — 流式期间 #1 已让 sessions 引用稳定，回调均 useCallback，
// App 每 chunk 重渲染时浅比较跳过整棵侧栏。
export const Sidebar = memo(function Sidebar({
  statusText,
  repoRoot,
  hostReady,
  isRunning,
  sessions,
  activeSessionId,
  onNewConversation,
  onSelectSession,
  onDeleteSession,
  onOpenSettings,
  onOpenMemory,
}: SidebarProps) {
  // 保持 state 数组顺序：切换不重排；新建会话已 unshift 到顶部
  const list = sessions;

  const workspaceName = workspaceLabel(repoRoot);

  // 右键菜单：{会话 id, 光标坐标}。任意点击 / Esc / 滚动 / 失焦即关。
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(
    null,
  );
  // 删除二次确认：进入菜单后先点「删除对话」再确认
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  return (
    <aside className={styles.sidebar}>
      <div className={styles.dragRegion} aria-hidden />

      <div className={styles.brandRow}>
        <PawMark size={42} />
        <div className={styles.brandText}>
          <span className={styles.brand}>Paw</span>
          <small className={styles.tagline}>A LITTLE FORWARD.</small>
        </div>
      </div>

      <button
        type="button"
        className={styles.newBtn}
        onClick={onNewConversation}
        disabled={isRunning}
      >
        <SquarePen size={17} />
        <span>新任务</span>
      </button>

      <div className={styles.workspace} title={repoRoot}>
        <FolderOpen size={16} />
        <span>{workspaceName}</span>
      </div>
      <div className={styles.section}>
        <div className={styles.sectionHead}>
          <span className={styles.sectionLabel}>最近对话</span>
          <span className={styles.sectionCount}>{list.length}</span>
        </div>
        <div className={styles.sessionList} role="list">
          {list.map((s) => {
            const active = s.id === activeSessionId;
            return (
              <div
                key={s.id}
                role="listitem"
                className={
                  active ? styles.sessionItemActive : styles.sessionItem
                }
                onContextMenu={(e) => {
                  e.preventDefault();
                  setConfirmingDelete(false);
                  setMenu({ id: s.id, x: e.clientX, y: e.clientY });
                }}
              >
                <button
                  type="button"
                  className={styles.sessionMain}
                  disabled={isRunning && !active}
                  onClick={() => onSelectSession(s.id)}
                  title={s.title}
                >
                  <MessageSquare size={15} />
                  <span className={styles.sessionTitle}>{s.title}</span>
                  <span className={styles.sessionTime}>
                    {active && isRunning
                      ? statusText
                      : formatRelativeTime(s.updatedAt)}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      </div>

      <div className={styles.footerCards}>
        <button
          type="button"
          className={styles.settingsRow}
          title="记忆"
          onClick={onOpenMemory}
        >
          <NotebookText size={17} />
          <span>记忆</span>
        </button>
        <button
          type="button"
          className={styles.settingsRow}
          title="设置"
          onClick={onOpenSettings}
        >
          <Settings2 size={17} />
          <span>设置</span>
        </button>
        <div className={styles.connection}>
          <i data-ready={hostReady} />
          <span>{hostReady ? "本地工作区已连接" : "正在连接工作区…"}</span>
        </div>
      </div>

      {menu ? (
        // ponytail: fixed 定位在光标处；侧栏在左侧、菜单窄，不做右溢出翻转。
        // onClick 阻止冒泡：否则 window 的 close 监听会先关掉菜单，确认 UI 出不来
        <div
          className={styles.contextMenu}
          style={{ top: menu.y, left: menu.x }}
          role="menu"
          onClick={(e) => e.stopPropagation()}
        >
          {confirmingDelete ? (
            <>
              <div className={styles.contextConfirmText}>确认删除该会话？</div>
              <button
                type="button"
                role="menuitem"
                className={styles.contextItemDanger}
                onClick={() => {
                  onDeleteSession(menu.id);
                  setConfirmingDelete(false);
                  setMenu(null);
                }}
              >
                确认删除
              </button>
              <button
                type="button"
                role="menuitem"
                className={styles.contextItem}
                onClick={() => setConfirmingDelete(false)}
              >
                取消
              </button>
            </>
          ) : (
            <button
              type="button"
              role="menuitem"
              className={styles.contextItemDanger}
              disabled={isRunning}
              onClick={() => setConfirmingDelete(true)}
            >
              删除对话
            </button>
          )}
        </div>
      ) : null}
    </aside>
  );
});
