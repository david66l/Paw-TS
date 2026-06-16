/**
 * PawFooter —— 底部状态栏、滚动日志与 footer 高度协调中心。
 *
 * 架构参考 OpenCode 的 RunFooter：
 *   - 不可变滚动日志：通过 PawScrollbackStream（createScrollbackWriter）管理
 *   - 响应式 footer：SolidJS signal 驱动 PawFooterView 重新渲染
 *   - 动态高度：根据当前视图与内容行数调整 footerHeight
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

/** Footer 完整状态。 */
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

/** Footer 当前视图类型。 */
export type FooterView =
  | { type: "prompt" }
  | { type: "approval"; tool: string; selectedIndex: number }
  | { type: "ask"; question: string };

/** 增量更新 Footer 状态的补丁。 */
export type FooterPatch = Partial<FooterState> & {
  readonly approvalTool?: string;
  readonly askQuestion?: string;
  readonly approvalSelectedIndex?: number;
};

/** PawFooter 构造选项。 */
export interface PawFooterOptions {
  readonly theme: PawTheme;
  readonly contextWindow: number;
  readonly onSubmit: (text: string) => void;
  readonly onInterrupt: () => boolean;
  readonly onApprovalReply: (approved: boolean) => void;
  readonly onAskReply: (answer: string) => void;
  readonly onExit: () => void;
}

// Footer 各区域占用的行数常量
const TEXTAREA_MIN_ROWS = 1;
const TEXTAREA_MAX_ROWS = 6;
const STREAM_PREVIEW_ROWS = 4;
const APPROVAL_ROWS = 5;
const ASK_ROWS = 3;
const BOTTOM_BAR_ROWS = 2;
const HUD_ROWS = 1;
const CONTEXT_BAR_ROWS = 1;

/**
 * PawFooter 主类。
 *
 * 负责：
 * - 维护 footer 状态与视图（prompt / approval / ask）
 * - 管理滚动日志写入
 * - 处理键盘输入、历史记录、计时器与转圈圈动画
 * - 根据内容动态调整 footer 高度
 */
export class PawFooter {
  private renderer: CliRenderer;
  private options: PawFooterOptions;
  private closed = false;
  private destroyed = false;

  // ── SolidJS 信号 ──
  private state: Accessor<FooterState>;
  private setState: Setter<FooterState>;
  private view: Accessor<FooterView>;
  private setView: Setter<FooterView>;
  private _theme: Accessor<PawTheme>;
  private _setTheme: Setter<PawTheme>;

  // ── 滚动日志 ──
  private scrollback: PawScrollbackStream;

  // ── 输入历史 ──
  private history: string[] = [];
  private historyIndex = -1;
  private readonly MAX_HISTORY = 1000;

  // ── 文本框引用 ──
  private textareaRef: TextareaRenderable | undefined;

  // ── 计时器状态 ──
  private elapsedTimer: ReturnType<typeof setInterval> | null = null;
  private spinnerTimer: ReturnType<typeof setInterval> | null = null;
  private spinnerFrame = 0;
  private startTime = 0;
  private THINKING_FRAMES = ["◌", "◉", "◎", "●", "◎", "◉"];

  // ── 滚动日志提交队列 ──
  private queue: StreamCommit[] = [];
  private pending = false;
  private flushing: Promise<void> = Promise.resolve();

  // ── 文本框行数 ──
  private rows = TEXTAREA_MIN_ROWS;

  constructor(renderer: CliRenderer, options: PawFooterOptions) {
    this.renderer = renderer;
    this.options = options;

    // 初始化 SolidJS 状态信号
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

    // 渲染器销毁时同步清理 footer
    this.renderer.on(CliRenderEvents.DESTROY, this.handleDestroy);

    // 渲染 SolidJS footer 视图
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

  // ── 公共 API ──

  /** footer 是否已关闭或销毁。 */
  get isClosed(): boolean {
    return this.closed || this.isGone;
  }

  /** 获取当前主题。 */
  get theme(): PawTheme {
    return this._theme();
  }

  /** 设置新主题并同步更新渲染器背景色。 */
  setTheme(next: PawTheme): void {
    this._setTheme(() => next);
    this.renderer.setBackgroundColor(next.background);
  }

  /** 增量更新 footer 状态。 */
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

  /** 切换 footer 视图（prompt / approval / ask）。 */
  present(view: FooterView): void {
    if (this.isGone) return;
    this.setView(view);
    this.applyHeight();
    this.refocusTextarea();
  }

  /** 追加滚动日志提交项（批量处理）。 */
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

  /** 刷新滚动日志并等待渲染器空闲。 */
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

  // ── 内部方法 ──

  private get isGone(): boolean {
    return this.destroyed || this.renderer.isDestroyed;
  }

  private handleDestroy = (): void => {
    if (this.destroyed) return;
    this.destroyed = true;
    this.flush();
    this.clearTimers();
    this.renderer.off(CliRenderEvents.DESTROY, this.handleDestroy);
    this.scrollback.destroy();
  };

  private clearTimers(): void {
    if (this.elapsedTimer) {
      clearInterval(this.elapsedTimer);
      this.elapsedTimer = null;
    }
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }
  }

  // ── 高度管理 ──

  /** 根据文本框实际行数同步 rows，并触发高度重算。 */
  private syncRows = (value: number): void => {
    const rows = Math.max(TEXTAREA_MIN_ROWS, Math.min(TEXTAREA_MAX_ROWS, value));
    if (rows === this.rows) return;
    this.rows = rows;
    this.applyHeight();
  };

  /** 根据当前视图与状态计算 footer 应有的高度。 */
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

  // ── 滚动日志刷新 ──

  /** 将队列中的提交项顺序写入滚动日志。 */
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

  // ── 键盘与输入 ──

  handleKeyDown = (e: KeyEvent): void => {
    const v = this.view();

    // Ctrl+C：取消/中断/退出
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
        this.clearTimers();
        this.patch({ streaming: false, inputBusy: false, phase: "idle" });
        this.refocusTextarea();
      } else {
        this.options.onExit();
      }
      return;
    }

    // 审批对话框按键
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

    // 提问对话框：仅 Escape 可取消
    if (v.type === "ask") {
      if (e.name === "escape") {
        e.preventDefault();
        this.options.onAskReply("");
        this.present({ type: "prompt" });
      }
      return;
    }

    // 历史记录导航（仅在光标位于文本框两端时触发）
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

  /** 在历史记录中上下移动。 */
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

  /** 提交当前输入框内容。 */
  private handleSubmit = (): void => {
    if (!this.textareaRef || this.textareaRef.isDestroyed) return;
    const v = this.view();
    if (v.type === "approval") return;

    const text = this.textareaRef.editBuffer.getText().trim();
    if (!text) return;

    // 提问模式下直接作为答案提交
    if (v.type === "ask") {
      this.textareaRef.editBuffer.setText("");
      this.options.onAskReply(text);
      this.present({ type: "prompt" });
      return;
    }

    // 正常提交：清空输入、记录历史、回调上层
    this.textareaRef.editBuffer.setText("");
    this.historyIndex = -1;
    this.history.push(text);
    if (this.history.length > this.MAX_HISTORY) {
      this.history = this.history.slice(-this.MAX_HISTORY);
    }
    this.options.onSubmit(text);
  };

  /** 重新聚焦输入框（prompt 视图下）。 */
  private refocusTextarea(): void {
    queueMicrotask(() => {
      if (this.textareaRef && !this.textareaRef.isDestroyed && this.view().type === "prompt") {
        this.textareaRef.focus();
      }
    });
  }

  // ── 运行事件处理（由 main.tsx 调用）──

  /**
   * 处理 orchestrator 运行事件，更新 footer 状态并将部分事件写入滚动日志。
   *
   * @param envelope 运行事件信封
   */
  handleRunEvent(envelope: RunEventEnvelope): void {
    const ev = envelope.event;

    if (ev.type === "run.started") {
      this.startTime = Date.now();
      if (this.elapsedTimer) clearInterval(this.elapsedTimer);
      if (this.spinnerTimer) clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
      // 每秒更新已运行时长
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
      // 模型阶段启动转圈动画
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
      this.clearTimers();
      this.patch({ spinnerChar: "", streaming: false, liveThinking: "", liveAssistant: "", phase: "idle" });
    }

    // 将事件转发给滚动日志
    this.scrollback.appendEvent(envelope);
  }

  /** 标记滚动日志已清空。 */
  markCleared(): void {
    this.scrollback.markCleared();
  }

  /** 追加 Markdown 文本到滚动日志。 */
  appendMarkdown(text: string, defaultFg?: import("@opentui/core").ColorInput): void {
    this.scrollback.appendMarkdown(text, defaultFg);
  }

  /** 追加纯文本到滚动日志。 */
  appendPlain(text: string, fg?: import("@opentui/core").ColorInput): void {
    this.scrollback.appendPlain(text, fg);
  }
}
