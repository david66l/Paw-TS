/**
 * PawFooterView —— footer 区域的纯 SolidJS 渲染组件。
 *
 * 除本地 UI 状态外无其他状态。所有数据通过 props（SolidJS accessor）传入，
 * 使 PawFooter 可以增量 patch 状态而不重建整个组件树。
 */

/** @jsxImportSource @opentui/solid */
import type { KeyEvent, TextareaRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import { Show, createMemo } from "solid-js";
import type { Accessor } from "solid-js";
import type { PawTheme } from "./theme.js";
import type { FooterState, FooterView } from "./PawFooter.js";
import {
  APPROVAL_ROWS,
  ASK_ROWS,
  STREAM_PREVIEW_ROWS,
} from "./footer-types.js";
import {
  type BottomBarChipColor,
  buildBottomBarChips,
  formatContextBar,
  formatHudText,
} from "./footer-chips.js";
import type { ColorInput } from "@opentui/core";

/** PawFooterView 组件 props。 */
interface PawFooterViewProps {
  readonly theme: Accessor<PawTheme>;
  readonly state: Accessor<FooterState>;
  readonly view: Accessor<FooterView>;
  readonly onSubmit: () => void;
  readonly onKeyDown: (e: KeyEvent) => void;
  readonly onTextareaRef: (ref: TextareaRenderable | undefined) => void;
  readonly onRows: (rows: number) => void;
}

export function PawFooterView(props: PawFooterViewProps) {
  const theme = props.theme;
  const state = props.state;
  const view = props.view;

  // 当前视图类型派生 memo
  const isPrompt = createMemo(() => view().type === "prompt");
  const isApproval = createMemo(() => view().type === "approval");
  const isAsk = createMemo(() => view().type === "ask");

  // HUD 与上下文条文本
  const hudText = createMemo(() => formatHudText(state()));
  const contextBarText = createMemo(() =>
    state().tokens != null ? formatContextBar(state().tokens, 128_000) : "",
  );
  const hasContextBar = createMemo(() => (state().tokens ?? 0) > 0);

  // 底部分隔线宽度（占位，保持视觉稳定）
  const footerRuleWidth = createMemo(() => Math.max(24, 100 - 2));

  const busy = createMemo(() => state().inputBusy);
  const askOpen = createMemo(() => view().type === "ask");

  // 注册全局键盘监听
  useKeyboard((e) => props.onKeyDown(e));

  // 根据状态动态调整 placeholder
  const placeholder = createMemo(() => {
    if (busy()) return "Running… (Ctrl+C to abort)";
    if (askOpen()) return "Type your reply...";
    return "Type your goal and press Enter...";
  });

  /**
   * 将 BottomBarChipColor 映射到主题色。
   *
   * @param color 芯片颜色标识
   */
  function chipColor(color: BottomBarChipColor): ColorInput {
    const t = theme();
    switch (color) {
      case "success":
        return t.success;
      case "info":
        return t.info;
      case "warning":
        return t.warning;
      case "error":
        return t.error;
      case "highlight":
        return t.highlight;
      default:
        return t.muted;
    }
  }

  // 底部状态栏芯片列表
  const bottomChips = createMemo(() => {
    const h = state();
    const chips = buildBottomBarChips(
      {
        modelLabel: h.modelLabel,
        turn: h.turn,
        maxSteps: h.maxSteps,
        phase: h.phase,
        tokens: h.tokens,
        contextBudget: h.contextBudget,
        costDetail: h.costDetail,
        elapsedMs: h.elapsedMs,
      },
      128_000,
    );
    return chips;
  });

  return (
    <box
      id="paw-footer-shell"
      width="100%"
      height="100%"
      border={false}
      backgroundColor="transparent"
      flexDirection="column"
      gap={0}
      padding={0}
    >
      {/* HUD 状态栏 */}
      <box id="paw-footer-hud" height={1} width="100%" flexShrink={0}>
        <text fg={theme().muted} wrapMode="none">
          {hudText() + (state().spinnerChar ? ` ${state().spinnerChar}` : "")}
        </text>
      </box>

      {/* 上下文使用量条 */}
      <Show when={hasContextBar()}>
        <box id="paw-footer-ctx" height={1} width="100%" flexShrink={0}>
          <text fg={theme().success} wrapMode="none">
            {contextBarText()}
          </text>
        </box>
      </Show>

      {/* 流式预览区 */}
      <Show when={state().streaming}>
        <box
          id="paw-footer-stream"
          height={STREAM_PREVIEW_ROWS}
          width="100%"
          flexDirection="column"
          flexShrink={0}
          backgroundColor={theme().pane}
        >
          <Show when={state().liveThinking}>
            <text fg={theme().muted} wrapMode="word">
              {"  💭 "}
              {state().liveThinking}
            </text>
          </Show>
          <Show when={state().liveAssistant}>
            <text fg={theme().assistantText} wrapMode="word">
              {"  "}
              {state().liveAssistant}
            </text>
          </Show>
        </box>
      </Show>

      {/* 工具审批选择器 */}
      <Show when={isApproval()}>
        <box
          id="paw-footer-approval"
          height={APPROVAL_ROWS}
          width="100%"
          backgroundColor={theme().pane}
          flexDirection="column"
          flexShrink={0}
        >
          <text fg={theme().warning} wrapMode="none">
            {"  "}Tool approval: {(view() as Extract<FooterView, { type: "approval" }>).tool}
          </text>
          <text
            fg={
              (view() as Extract<FooterView, { type: "approval" }>).selectedIndex === 0
                ? theme().highlight
                : theme().muted
            }
            wrapMode="none"
          >
            {(view() as Extract<FooterView, { type: "approval" }>).selectedIndex === 0
              ? "> "
              : "  "}{" "}
            Allow - run this tool
          </text>
          <text
            fg={
              (view() as Extract<FooterView, { type: "approval" }>).selectedIndex === 1
                ? theme().error
                : theme().muted
            }
            wrapMode="none"
          >
            {(view() as Extract<FooterView, { type: "approval" }>).selectedIndex === 1
              ? "> "
              : "  "}{" "}
            Deny - skip execution
          </text>
          <text fg={theme().muted} wrapMode="none">
            {"  "}y / Enter = Allow · n / Esc = Deny
          </text>
        </box>
      </Show>

      {/* 用户提问提示 */}
      <Show when={isAsk()}>
        <box
          id="paw-footer-ask"
          height={ASK_ROWS}
          width="100%"
          backgroundColor={theme().pane}
          flexDirection="column"
          flexShrink={0}
        >
          <text fg={theme().highlight} wrapMode="word">
            {"  "}Reply needed: {(view() as Extract<FooterView, { type: "ask" }>).question}
          </text>
          <text fg={theme().muted} wrapMode="none">
            {"  "}Type your answer below and press Enter (Esc to skip)
          </text>
        </box>
      </Show>

      {/* 多行文本输入框 */}
      <Show when={isPrompt() || isAsk()}>
        <box
          id="paw-footer-textarea-box"
          width="100%"
          flexGrow={1}
          flexShrink={1}
          backgroundColor={theme().surface}
        >
          <textarea
            ref={(el: TextareaRenderable) => {
              if (!el || el.isDestroyed) return;
              props.onTextareaRef(el);
              el.textColor = theme().text;
              el.focusedTextColor = theme().text;
              el.backgroundColor = theme().surface;
              el.focusedBackgroundColor = theme().surface;
              // 内容变化时通知父组件更新行数
              el.onContentChange = () => {
                props.onRows(el.lineCount);
              };
              // Enter 提交，Shift+Enter 换行
              el.keyBindings = [
                { name: "return", action: "submit" },
                { name: "linefeed", action: "submit" },
                { name: "return", shift: true, action: "newline" },
              ];
              el.onSubmit = () => props.onSubmit();
            }}
            width="100%"
            height="100%"
            placeholder={placeholder()}
            placeholderColor={theme().placeholder}
            textColor={theme().text}
            focusedTextColor={theme().text}
            backgroundColor={theme().surface}
            focusedBackgroundColor={theme().surface}
          />
        </box>
      </Show>

      {/* 底部状态栏 */}
      <Show when={isPrompt() || isApproval()}>
        <box height={1} width="100%" flexShrink={0}>
          <text fg={theme().border} wrapMode="none">
            {"  "}
            {"─".repeat(footerRuleWidth())}
          </text>
        </box>
        <box
          id="paw-footer-status"
          height={1}
          width="100%"
          flexShrink={0}
          backgroundColor={theme().footerBg}
        >
          <box flexDirection="row">
            <text wrapMode="none">{"  "}</text>
            <text wrapMode="none" />
            {(() => {
              const chips = bottomChips();
              const t = theme();
              const elements: import("@opentui/solid").JSX.Element[] = [];
              for (let i = 0; i < chips.length; i++) {
                const c = chips[i]!;
                if (i > 0) {
                  elements.push(
                    <text fg={t.muted} wrapMode="none">
                      {" │ "}
                    </text>,
                  );
                }
                elements.push(
                  <text fg={chipColor(c.color)} wrapMode="none">
                    {c.text}
                  </text>,
                );
              }
              return elements;
            })()}
          </box>
        </box>
      </Show>
    </box>
  );
}
