import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useState,
} from "react";
import styles from "./App.module.css";
import { useAgentRun } from "./agent/useAgentRun";
import { useRightPanelData } from "./agent/useRightPanelData";
import { ChatStream } from "./components/ChatStream";
import { RightPanel, type RightTabId } from "./components/RightPanel";
import { SettingsModal } from "./components/SettingsModal";
import { Sidebar } from "./components/Sidebar";

/** 中间聊天区最小宽度，拖拽时保证两侧不把它挤没 */
const CHAT_MIN = 360;

function readWidth(key: string, fallback: number): number {
  const v = Number(localStorage.getItem(key));
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export function App() {
  const [colorTheme, setColorTheme] = useState<"calm" | "aurora">("calm");
  const [materialTheme, setMaterialTheme] = useState<"soft" | "lens">("lens");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [rightTab, setRightTab] = useState<RightTabId>("plan");
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    readWidth("paw.width.sidebar", 252),
  );
  const [rightWidth, setRightWidth] = useState(() =>
    readWidth("paw.width.right", 320),
  );
  const agent = useAgentRun();
  const panelData = useRightPanelData();

  useEffect(() => {
    document.documentElement.dataset.colorTheme = colorTheme;
  }, [colorTheme]);

  useEffect(() => {
    document.documentElement.dataset.materialTheme = materialTheme;
  }, [materialTheme]);

  useEffect(() => {
    localStorage.setItem("paw.width.sidebar", String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    localStorage.setItem("paw.width.right", String(rightWidth));
  }, [rightWidth]);

  /** 分隔条拖拽：left=侧栏，right=右栏；动态 clamp 保证 chat ≥ CHAT_MIN */
  const startResize =
    (which: "left" | "right") => (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const startX = e.clientX;
      const startSidebar = sidebarWidth;
      const startRight = rightWidth;
      const onMove = (ev: PointerEvent) => {
        const vw = window.innerWidth;
        if (which === "left") {
          const max = Math.max(200, vw - startRight - CHAT_MIN);
          setSidebarWidth(
            Math.min(max, Math.max(200, startSidebar + (ev.clientX - startX))),
          );
        } else {
          const max = Math.max(240, vw - startSidebar - CHAT_MIN);
          setRightWidth(
            Math.min(max, Math.max(240, startRight - (ev.clientX - startX))),
          );
        }
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        document.body.style.removeProperty("cursor");
        document.body.style.removeProperty("user-select");
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    };

  /** 键盘可达：左右方向键各微调 16px */
  const onResizerKey =
    (which: "left" | "right") => (e: ReactKeyboardEvent<HTMLDivElement>) => {
      const step =
        e.key === "ArrowLeft" ? -16 : e.key === "ArrowRight" ? 16 : 0;
      if (!step) return;
      e.preventDefault();
      const vw = window.innerWidth;
      if (which === "left") {
        const max = Math.max(200, vw - rightWidth - CHAT_MIN);
        setSidebarWidth((w) => Math.min(max, Math.max(200, w + step)));
      } else {
        const max = Math.max(240, vw - sidebarWidth - CHAT_MIN);
        setRightWidth((w) => Math.min(max, Math.max(240, w - step)));
      }
    };

  return (
    <div
      className={styles.app}
      data-color-theme={colorTheme}
      data-material-theme={materialTheme}
      style={
        {
          "--sidebar-width": `${sidebarWidth}px`,
          "--right-panel-width": `${rightWidth}px`,
        } as CSSProperties
      }
    >
      <Sidebar
        statusText={agent.statusText}
        repoRoot={agent.repoRoot}
        hostReady={agent.hostReady}
        isRunning={agent.isRunning}
        sessions={agent.sessions}
        activeSessionId={agent.activeSessionId}
        onNewConversation={agent.newConversation}
        onSelectSession={agent.selectSession}
        onDeleteSession={agent.deleteSession}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <div
        className={styles.resizer}
        role="separator"
        aria-orientation="vertical"
        aria-label="调整侧栏宽度"
        tabIndex={0}
        onPointerDown={startResize("left")}
        onKeyDown={onResizerKey("left")}
      />
      <ChatStream
        messages={agent.messages}
        status={agent.status}
        statusText={agent.statusText}
        isRunning={agent.isRunning}
        error={agent.error}
        hostReady={agent.hostReady}
        modelLabel={agent.modelLabel}
        skillsCount={agent.skillsCount}
        lastRunId={agent.lastRunId}
        activities={agent.activities}
        selectedActivityId={agent.selectedActivityId}
        toolBatches={agent.toolBatches}
        fileChanges={agent.fileChanges}
        onViewDetails={(id) => {
          agent.selectActivity(id);
          setRightTab("agents");
        }}
        onSend={agent.send}
        onAbort={agent.abort}
        onClear={agent.clearCurrentMessages}
        pendingApprovals={agent.pendingApprovals}
        onResolveApproval={agent.resolveApproval}
        pendingAsk={agent.pendingAsk}
        onAnswerAsk={agent.answerAsk}
        failedGoal={agent.failedGoal}
        onRetry={agent.retryFailed}
        onDismissError={agent.dismissError}
        approvalMode={agent.approvalMode}
      />
      <div
        className={styles.resizer}
        role="separator"
        aria-orientation="vertical"
        aria-label="调整右栏宽度"
        tabIndex={0}
        onPointerDown={startResize("right")}
        onKeyDown={onResizerKey("right")}
      />
      <RightPanel
        plan={panelData.plan}
        changes={panelData.changes}
        context={panelData.context}
        memory={panelData.memory}
        activities={agent.activities}
        selectedActivityId={agent.selectedActivityId}
        agentRoster={agent.agentRoster}
        agentRunStatus={agent.agentRunStatus}
        tab={rightTab}
        onTabChange={setRightTab}
        onRefreshMemoryLibrary={panelData.refreshMemoryLibrary}
      />
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        colorTheme={colorTheme}
        onColorThemeChange={setColorTheme}
        materialTheme={materialTheme}
        onMaterialThemeChange={setMaterialTheme}
        modelPresets={agent.modelPresets}
        provider={agent.provider}
        onProviderChange={agent.changeProvider}
        approvalMode={agent.approvalMode}
        onApprovalModeChange={agent.changeApprovalMode}
      />
    </div>
  );
}
