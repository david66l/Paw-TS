/**
 * PawFooterView — pure SolidJS rendering component for the footer region.
 *
 * Stateless except for local UI state (none). All data comes from props
 * (SolidJS accessors) so PawFooter can patch state without re-creating
 * the whole component tree.
 */

/** @jsxImportSource @opentui/solid */
import type { KeyEvent, TextareaRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import { Show, createMemo } from "solid-js";
import type { Accessor } from "solid-js";
import type { PawTheme } from "./theme.js";
import type { FooterState, FooterView } from "./PawFooter.js";
import {
  type BottomBarChipColor,
  buildBottomBarChips,
  formatContextBar,
  formatHudText,
} from "./footer-state.js";
import type { ColorInput } from "@opentui/core";

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

  const isPrompt = createMemo(() => view().type === "prompt");
  const isApproval = createMemo(() => view().type === "approval");
  const isAsk = createMemo(() => view().type === "ask");

  const hudText = createMemo(() => formatHudText(state()));
  const contextBarText = createMemo(() =>
    state().tokens != null ? formatContextBar(state().tokens, 128_000) : "",
  );
  const hasContextBar = createMemo(() => (state().tokens ?? 0) > 0);

  const footerRuleWidth = createMemo(() => Math.max(24, 100 - 2));

  const busy = createMemo(() => state().inputBusy);
  const askOpen = createMemo(() => view().type === "ask");

  useKeyboard((e) => props.onKeyDown(e));

  const placeholder = createMemo(() => {
    if (busy()) return "Running… (Ctrl+C to abort)";
    if (askOpen()) return "Type your reply...";
    return "Type your goal and press Enter...";
  });

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
      {/* HUD bar */}
      <box id="paw-footer-hud" height={1} width="100%" flexShrink={0}>
        <text fg={theme().muted} wrapMode="none">
          {hudText() + (state().spinnerChar ? ` ${state().spinnerChar}` : "")}
        </text>
      </box>

      {/* Context usage bar */}
      <Show when={hasContextBar()}>
        <box id="paw-footer-ctx" height={1} width="100%" flexShrink={0}>
          <text fg={theme().success} wrapMode="none">
            {contextBarText()}
          </text>
        </box>
      </Show>

      {/* Stream preview */}
      <Show when={state().streaming}>
        <box
          id="paw-footer-stream"
          height={4}
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

      {/* Approval picker */}
      <Show when={isApproval()}>
        <box
          id="paw-footer-approval"
          height={5}
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

      {/* Ask prompt */}
      <Show when={isAsk()}>
        <box
          id="paw-footer-ask"
          height={3}
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

      {/* Textarea */}
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
              el.onContentChange = () => {
                props.onRows(el.lineCount);
              };
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

      {/* Bottom status bar */}
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
