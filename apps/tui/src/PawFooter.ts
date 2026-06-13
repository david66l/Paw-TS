/**
 * PawFooter — centralized state + scrollback + footer-height orchestration.
 *
 * Mirrors OpenCode’s RunFooter architecture:
 *   - Immutable scrollback via PawScrollbackStream (createScrollbackWriter)
 *   - Reactive footer via SolidJS signals driving PawFooterView
 *   - Dynamic footerHeight based on view + content rows
 */

import {
  type CliRenderer,
  type TextareaRenderable,
  type KeyEvent,
  CliRenderEvents,
} from "@opentui/core";
import { render } from "@opentui/solid";
import { createComponent, createSignal, type Accessor, type Setter } from "solid-js";

import type { PawTheme } from "./theme.js";
import { PawScrollbackStream, type StreamCommit } from "./PawScrollbackStream.js";
import { PawFooterView } from "./PawFooterView.js";
import { resolveApprovalKey } from "./footer-state.js";
import type { RunEventEnvelope } from "@paw/core";

export interface FooterState {
  readonly modelLabel: string | null;
  readonly turn: number | null;
  readonly maxSteps: number | null;
  readonly phase: string | null;
  readonly tokens: number | null;
  readonly contextBudget: {
    readonly historyUsed: number;
    readonly historyBudget: number;
    readonly systemUsed: number;
    readonly systemBudget: number;
    readonly historyOverBudget: boolean;
    readonly systemOverBudget: boolean;
  } | null;
  readonly costDetail: {
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
    readonly estimatedCostUsd: number;
    readonly costCurrency?: "CNY" | "USD";
    readonly cachedPromptTokens?: number;
    readonly turnPromptTokens?: number;
    readonly turnCompletionTokens?: number;
  } | null;
  readonly elapsedMs: number | null;
  readonly spinnerChar: string;
  readonly streaming: boolean;
  readonly inputBusy: boolean;
  readonly liveThinking: string;
  readonly liveAssistant: string;
}

export type FooterView =
  | { type: "prompt" }
  | { type: "approval"; tool: string; selectedIndex: number }
  | { type: "ask"; question: string };

export type FooterPatch = Partial<FooterState> & {
  readonly approvalTool?: string;
  readonly askQuestion?: string;
  readonly approvalSelectedIndex?: number;
};

export interface PawFooterOptions {
  readonly theme: PawTheme;
  readonly contextWindow: number;
  readonly onSubmit: (text: string) => void;
  readonly onInterrupt: () => boolean;
  readonly onApprovalReply: (approved: boolean) => void;
  readonly onAskReply: (answer: string) => void;
  readonly onExit: () => void;
}

const TEXTAREA_MIN_ROWS = 1;
const TEXTAREA_MAX_ROWS = 6;
const STREAM_PREVIEW_ROWS = 4;
const APPROVAL_ROWS = 5;
const ASK_ROWS = 3;
const BOTTOM_BAR_ROWS = 2;
const HUD_ROWS = 1;
const CONTEXT_BAR_ROWS = 1;

export class PawFooter {
  private renderer: CliRenderer;
  private options: PawFooterOptions;
  private closed = false;
  private destroyed = false;

  // ── SolidJS signals ──
  private state: Accessor<FooterState>;
  private setState: Setter<FooterState>;
  private view: Accessor<FooterView>;
  private setView: Setter<FooterView>;
  private _theme: Accessor<PawTheme>;
  private _setTheme: Setter<PawTheme>;

  // ── Scrollback ──
  private scrollback: PawScrollbackStream;

  // ── History ──
  private history: string[] = [];
  private historyIndex = -1;
  private readonly MAX_HISTORY = 1000;

  // ── Textarea ref ──
  private textareaRef: TextareaRenderable | undefined;

  // ── Timer state ──
  private elapsedTimer: ReturnType<typeof setInterval> | null = null;
  private spinnerTimer: ReturnType<typeof setInterval> | null = null;
  private spinnerFrame = 0;
  private startTime = 0;
  private THINKING_FRAMES = ["◌", "◉", "◎", "●", "◎", "◉"];

  // ── Queued scrollback commits ──
  private queue: StreamCommit[] = [];
  private pending = false;
  private flushing: Promise<void> = Promise.resolve();

  // ── Rows ──
  private rows = TEXTAREA_MIN_ROWS;

  constructor(renderer: CliRenderer, options: PawFooterOptions) {
    this.renderer = renderer;
    this.options = options;

    const [state, setState] = createSignal<FooterState>({
      modelLabel: null,
      turn: null,
      maxSteps: null,
      phase: null,
      tokens: null,
      contextBudget: null,
      costDetail: null,
      elapsedMs: null,
      spinnerChar: "",
      streaming: false,
      inputBusy: false,
      liveThinking: "",
      liveAssistant: "",
    });
    this.state = state;
    this.setState = setState;

    const [view, setView] = createSignal<FooterView>({ type: "prompt" });
    this.view = view;
    this.setView = setView;

    const [theme, setTheme] = createSignal<PawTheme>(options.theme);
    this._theme = theme;
    this._setTheme = setTheme;

    this.scrollback = new PawScrollbackStream(renderer, theme);

    this.renderer.on(CliRenderEvents.DESTROY, this.handleDestroy);

    void render(
      () =>
        createComponent(PawFooterView, {
          theme,
          state,
          view,
          onSubmit: this.handleSubmit,
          onKeyDown: this.handleKeyDown,
          onTextareaRef: (ref) => {
            this.textareaRef = ref;
          },
          onRows: this.syncRows,
        }),
      this.renderer,
    )
      .then(() => {
        if (!this.isGone) this.refocusTextarea();
      })
      .catch(() => {
        if (!this.isGone) this.close();
      });
  }

  // ── Public API ──

  get isClosed(): boolean {
    return this.closed || this.isGone;
  }

  get theme(): PawTheme {
    return this._theme();
  }

  setTheme(next: PawTheme): void {
    this._setTheme(() => next);
    this.renderer.setBackgroundColor(next.background);
  }

  /** Patch footer state (incremental update). */
  patch(next: FooterPatch): void {
    if (this.isGone) return;
    const prev = this.state();
    const merged: FooterState = {
      modelLabel: next.modelLabel !== undefined ? next.modelLabel : prev.modelLabel,
      turn: next.turn !== undefined ? next.turn : prev.turn,
      maxSteps: next.maxSteps !== undefined ? next.maxSteps : prev.maxSteps,
      phase: next.phase !== undefined ? next.phase : prev.phase,
      tokens: next.tokens !== undefined ? next.tokens : prev.tokens,
      contextBudget: next.contextBudget !== undefined ? next.contextBudget : prev.contextBudget,
      costDetail: next.costDetail !== undefined ? next.costDetail : prev.costDetail,
      elapsedMs: next.elapsedMs !== undefined ? next.elapsedMs : prev.elapsedMs,
      spinnerChar: next.spinnerChar !== undefined ? next.spinnerChar : prev.spinnerChar,
      streaming: next.streaming !== undefined ? next.streaming : prev.streaming,
      inputBusy: next.inputBusy !== undefined ? next.inputBusy : prev.inputBusy,
      liveThinking: next.liveThinking !== undefined ? next.liveThinking : prev.liveThinking,
      liveAssistant: next.liveAssistant !== undefined ? next.liveAssistant : prev.liveAssistant,
    };
    this.setState(merged);
    this.applyHeight();
  }

  /** Switch footer view (prompt / approval / ask). */
  present(view: FooterView): void {
    if (this.isGone) return;
    this.setView(view);
    this.applyHeight();
    this.refocusTextarea();
  }

  /** Append a scrollback commit (batched). */
  append(commit: StreamCommit): void {
    if (this.isGone) return;
    this.queue.push(commit);
    if (this.pending) return;
    this.pending = true;
    queueMicrotask(() => {
      this.pending = false;
      this.flush();
    });
  }

  /** Flush scrollback + wait for renderer idle. */
  async idle(): Promise<void> {
    this.flush();
    await this.flushing;
    if (this.queue.length > 0) return this.idle();
    await this.renderer.idle().catch(() => {});
  }

  close(): void {
    if (this.closed) return;
    this.flush();
    this.closed = true;
  }

  destroy(): void {
    this.handleDestroy();
  }

  // ── Internal ──

  private get isGone(): boolean {
    return this.destroyed || this.renderer.isDestroyed;
  }

  private handleDestroy = (): void => {
    if (this.destroyed) return;
    this.destroyed = true;
    this.flush();
    if (this.elapsedTimer) clearInterval(this.elapsedTimer);
    if (this.spinnerTimer) clearInterval(this.spinnerTimer);
    this.renderer.off(CliRenderEvents.DESTROY, this.handleDestroy);
    this.scrollback.destroy();
  };

  // ── Height management ──

  private syncRows = (value: number): void => {
    const rows = Math.max(TEXTAREA_MIN_ROWS, Math.min(TEXTAREA_MAX_ROWS, value));
    if (rows === this.rows) return;
    this.rows = rows;
    this.applyHeight();
  };

  private applyHeight(): void {
    const v = this.view();
    const s = this.state();

    let height = HUD_ROWS;
    if ((s.tokens ?? 0) > 0) height += CONTEXT_BAR_ROWS;
    if (s.streaming) height += STREAM_PREVIEW_ROWS;

    if (v.type === "approval") {
      height += APPROVAL_ROWS + BOTTOM_BAR_ROWS;
    } else if (v.type === "ask") {
      height += ASK_ROWS + Math.max(TEXTAREA_MIN_ROWS, this.rows) + BOTTOM_BAR_ROWS;
    } else {
      height += Math.max(TEXTAREA_MIN_ROWS, this.rows) + BOTTOM_BAR_ROWS;
    }

    if (height !== this.renderer.footerHeight) {
      this.renderer.footerHeight = height;
    }
  }

  // ── Scrollback flush ──

  private flush(): void {
    if (this.isGone || this.queue.length === 0) {
      this.queue.length = 0;
      return;
    }
    const batch = this.queue.splice(0);
    this.flushing = this.flushing
      .then(async () => {
        for (const item of batch) {
          await this.scrollback.append(item);
        }
      })
      .catch(() => {});
  }

  // ── Keyboard & input ──

  handleKeyDown = (e: KeyEvent): void => {
    const v = this.view();

    // Ctrl+C
    if (e.name === "c" && e.ctrl) {
      e.preventDefault();
      if (v.type === "approval") {
        this.options.onApprovalReply(false);
        this.present({ type: "prompt" });
        return;
      }
      if (v.type === "ask") {
        this.options.onAskReply("");
        this.present({ type: "prompt" });
        return;
      }
      if (this.options.onInterrupt()) {
        this.patch({ streaming: false, inputBusy: false, phase: "idle" });
        this.refocusTextarea();
      } else {
        this.options.onExit();
      }
      return;
    }

    // Approval dialog keys
    if (v.type === "approval") {
      const action = resolveApprovalKey(e);
      if (action) {
        e.preventDefault();
        const current = v.selectedIndex;
        if (action === "select-allow") {
          this.present({ type: "approval", tool: v.tool, selectedIndex: 0 });
        } else if (action === "select-deny") {
          this.present({ type: "approval", tool: v.tool, selectedIndex: 1 });
        } else if (action === "approve") {
          this.options.onApprovalReply(true);
          this.present({ type: "prompt" });
        } else if (action === "confirm") {
          this.options.onApprovalReply(current === 0);
          this.present({ type: "prompt" });
        } else if (action === "deny") {
          this.options.onApprovalReply(false);
          this.present({ type: "prompt" });
        }
      }
      return;
    }

    // Ask dialog — only Escape to cancel
    if (v.type === "ask") {
      if (e.name === "escape") {
        e.preventDefault();
        this.options.onAskReply("");
        this.present({ type: "prompt" });
      }
      return;
    }

    // History navigation (only when cursor at edges)
    if (e.name === "up" && !e.ctrl && !e.shift) {
      if (this.textareaRef && this.textareaRef.cursorOffset === 0) {
        this.navHistory(-1);
        e.preventDefault();
      }
      return;
    }
    if (e.name === "down" && !e.ctrl && !e.shift) {
      if (this.textareaRef && this.textareaRef.cursorOffset === this.textareaRef.plainText.length) {
        this.navHistory(1);
        e.preventDefault();
      }
      return;
    }
  };

  private navHistory(dir: -1 | 1): void {
    if (!this.textareaRef || this.textareaRef.isDestroyed) return;
    const hist = this.history;
    if (hist.length === 0) return;

    if (dir === -1) {
      const idx = this.historyIndex;
      const newIdx = idx < 0 ? hist.length - 1 : Math.max(0, idx - 1);
      this.historyIndex = newIdx;
      this.textareaRef.editBuffer.setText(hist[newIdx] ?? "");
    } else {
      const idx = this.historyIndex;
      if (idx < 0) return;
      const newIdx = idx + 1;
      if (newIdx >= hist.length) {
        this.historyIndex = -1;
        this.textareaRef.editBuffer.setText("");
      } else {
        this.historyIndex = newIdx;
        this.textareaRef.editBuffer.setText(hist[newIdx] ?? "");
      }
    }
  }

  private handleSubmit = (): void => {
    if (!this.textareaRef || this.textareaRef.isDestroyed) return;
    const v = this.view();
    if (v.type === "approval") return;

    const text = this.textareaRef.editBuffer.getText().trim();
    if (!text) return;

    // In ask mode, submit as answer
    if (v.type === "ask") {
      this.textareaRef.editBuffer.setText("");
      this.options.onAskReply(text);
      this.present({ type: "prompt" });
      return;
    }

    // Normal submit
    this.textareaRef.editBuffer.setText("");
    this.historyIndex = -1;
    this.history.push(text);
    if (this.history.length > this.MAX_HISTORY) {
      this.history = this.history.slice(-this.MAX_HISTORY);
    }
    this.options.onSubmit(text);
  };

  private refocusTextarea(): void {
    queueMicrotask(() => {
      if (this.textareaRef && !this.textareaRef.isDestroyed && this.view().type === "prompt") {
        this.textareaRef.focus();
      }
    });
  }

  // ── Run-event helpers (called by main.tsx) ──

  handleRunEvent(envelope: RunEventEnvelope): void {
    const ev = envelope.event;

    if (ev.type === "run.started") {
      this.startTime = Date.now();
      if (this.elapsedTimer) clearInterval(this.elapsedTimer);
      if (this.spinnerTimer) clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
      this.elapsedTimer = setInterval(() => {
        this.patch({ elapsedMs: Date.now() - this.startTime });
      }, 1000);
    }

    if (ev.type === "model.request") {
      this.patch({ modelLabel: ev.label, liveThinking: "", liveAssistant: "", streaming: true });
    }

    if (ev.type === "model.thinking") {
      this.patch({ liveThinking: ev.text });
    }

    if (ev.type === "model.chunk") {
      this.patch({ liveAssistant: ev.text });
    }

    if (ev.type === "model.done") {
      this.patch({ streaming: false, liveThinking: "", liveAssistant: "" });
    }

    if (ev.type === "loop.tick") {
      this.patch({
        turn: ev.turn,
        maxSteps: ev.maxSteps,
        tokens: ev.estimatedTokens,
      });
    }

    if (ev.type === "context.budget") {
      this.patch({
        contextBudget: {
          historyUsed: ev.historyUsed,
          historyBudget: ev.historyBudget,
          systemUsed: ev.systemUsed,
          systemBudget: ev.systemBudget,
          historyOverBudget: ev.historyOverBudget,
          systemOverBudget: ev.systemOverBudget,
        },
      });
    }

    if (ev.type === "phase") {
      this.patch({ phase: ev.name });
      if (ev.name === "model") {
        if (!this.spinnerTimer) {
          this.spinnerTimer = setInterval(() => {
            this.spinnerFrame = (this.spinnerFrame + 1) % this.THINKING_FRAMES.length;
            this.patch({ spinnerChar: this.THINKING_FRAMES[this.spinnerFrame]! });
          }, 420);
        }
      } else {
        if (this.spinnerTimer) {
          clearInterval(this.spinnerTimer);
          this.spinnerTimer = null;
        }
        this.patch({ spinnerChar: "" });
      }
    }

    if (ev.type === "cost.update") {
      this.patch({
        costDetail: {
          promptTokens: ev.promptTokens,
          completionTokens: ev.completionTokens,
          totalTokens: ev.totalTokens,
          estimatedCostUsd: ev.estimatedCostUsd,
          costCurrency: ev.costCurrency ?? "USD",
          ...(ev.cachedPromptTokens !== undefined ? { cachedPromptTokens: ev.cachedPromptTokens } : {}),
          ...(ev.turnPromptTokens !== undefined ? { turnPromptTokens: ev.turnPromptTokens } : {}),
          ...(ev.turnCompletionTokens !== undefined ? { turnCompletionTokens: ev.turnCompletionTokens } : {}),
        },
      });
    }

    if (ev.type === "run.completed" || ev.type === "run.failed") {
      if (this.elapsedTimer) {
        clearInterval(this.elapsedTimer);
        this.elapsedTimer = null;
      }
      if (this.spinnerTimer) {
        clearInterval(this.spinnerTimer);
        this.spinnerTimer = null;
      }
      this.patch({ spinnerChar: "", streaming: false, liveThinking: "", liveAssistant: "", phase: "idle" });
    }

    // Forward to scrollback as a commit
    this.scrollback.appendEvent(envelope);
  }

  markCleared(): void {
    this.scrollback.markCleared();
  }

  appendMarkdown(text: string, defaultFg?: import("@opentui/core").ColorInput): void {
    this.scrollback.appendMarkdown(text, defaultFg);
  }

  appendPlain(text: string, fg?: import("@opentui/core").ColorInput): void {
    this.scrollback.appendPlain(text, fg);
  }
}
