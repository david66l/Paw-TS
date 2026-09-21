/**
 * PawScrollbackStream —— 富文本滚动日志渲染。
 *
 * 通过 OpenTUI 的 createScrollbackWriter 将 SolidJS 元素写入滚动日志，
 * 替代旧的命令式 TextRenderable 方案，从而支持颜色、Markdown 行内样式
 * 以及统一的布局。
 */

import { writeSolidToScrollback } from "@opentui/solid";
import {
  type CliRenderer,
  type ColorInput,
  createTextAttributes,
} from "@opentui/core";
import type { RunEventEnvelope } from "@paw/core";
import { markdownToSegmentBlock } from "./markdown-parse.js";
import { formatEventForScrollback } from "./scrollback-format.js";
import { stripAssistantTextForScrollback } from "./scrollback-text.js";
import type { PawTheme } from "./theme.js";

/** 滚动日志提交项：纯文本或 Markdown。 */
export interface StreamCommit {
  readonly text?: string;
  readonly fg?: ColorInput;
  readonly markdown?: boolean;
}

/**
 * 滚动日志流。
 *
 * 负责将运行事件、纯文本、Markdown 渲染到 TUI 的滚动日志区域。
 */
export class PawScrollbackStream {
  private lastStreamingText = "";
  private rendered = false;

  constructor(
    private renderer: CliRenderer,
    private resolveTheme: () => PawTheme,
  ) {}

  /**
   * 追加一个通用提交项。
   *
   * @param commit 提交项
   */
  append(commit: StreamCommit): void {
    if (commit.markdown && commit.text) {
      this.appendMarkdown(commit.text, commit.fg);
    } else if (commit.text) {
      this.appendPlain(commit.text, commit.fg);
    }
  }

  /**
   * 追加纯文本到滚动日志。
   *
   * @param text 文本内容
   * @param fg 前景色，默认使用主题文本色
   */
  appendPlain(text: string, fg?: ColorInput): void {
    if (!text.trim()) return;
    this.writeSpacerIfNeeded();
    writeSolidToScrollback(this.renderer, () => (
      <text width="100%" wrapMode="word" fg={fg ?? this.resolveTheme().text}>
        {text}
      </text>
    ));
    this.renderer.requestRender();
    this.rendered = true;
  }

  /**
   * 追加 Markdown 文本到滚动日志。
   *
   * 会将 Markdown 解析为带颜色/样式的片段后逐行渲染。
   *
   * @param text Markdown 文本
   * @param defaultFg 默认文本颜色
   */
  appendMarkdown(text: string, defaultFg?: ColorInput): void {
    if (!text.trim()) return;
    const theme = this.resolveTheme();
    const blocks = markdownToSegmentBlock(text, {
      defaultFg: defaultFg ?? theme.text,
      mutedFg: theme.muted,
      brandFg: theme.brand,
      codeFg: theme.info,
    });

    for (const line of blocks) {
      this.writeSpacerIfNeeded();
      // 单行单一段落且无加粗/斜体时直接渲染为 text，减少嵌套
      if (line.length === 1 && !line[0]!.bold && !line[0]!.italic) {
        writeSolidToScrollback(this.renderer, () => (
          <text width="100%" wrapMode="word" fg={line[0]!.fg}>
            {line[0]!.text}
          </text>
        ));
      } else {
        writeSolidToScrollback(this.renderer, () => {
          const elements: import("@opentui/solid").JSX.Element[] = [];
          for (const segment of line) {
            elements.push(
              <text
                wrapMode="none"
                fg={segment.fg}
                attributes={createTextAttributes({
                  bold: segment.bold,
                  italic: segment.italic,
                })}
              >
                {segment.text}
              </text>,
            );
          }
          return (
            <box width="100%" flexDirection="row" flexWrap="wrap">
              {elements}
            </box>
          );
        });
      }
      this.rendered = true;
    }
    if (blocks.length > 0) {
      this.renderer.requestRender();
    }
  }

  /**
   * 将运行事件转换为滚动日志条目。
   *
   * 部分高频事件（loop.tick / cost.update 等）被静默忽略，避免刷屏。
   *
   * @param envelope 运行事件信封
   */
  appendEvent(envelope: RunEventEnvelope): void {
    const theme = this.resolveTheme();
    const ev = envelope.event;
    let fg: ColorInput | undefined;

    switch (ev.type) {
      case "run.started":
        this.lastStreamingText = "";
        return;
      case "model.request":
        this.lastStreamingText = "";
        return;
      case "model.chunk":
        // 累积流式文本，等 model.done 时统一渲染
        this.lastStreamingText = ev.text;
        return;
      case "model.thinking":
        return;
      case "loop.tick":
      case "context.budget":
      case "cost.update":
        return;
      case "model.done": {
        const raw = (ev.text || this.lastStreamingText).trim();
        this.lastStreamingText = "";
        const text = stripAssistantTextForScrollback(raw);
        if (text) {
          this.appendMarkdown(text, theme.assistantText);
        }
        return;
      }
      case "tool.call":
        fg = theme.toolText;
        break;
      case "tool.result":
        fg = ev.ok ? theme.success : theme.error;
        break;
      case "tool.result.chunk": {
        // 压缩工具输出中的连续空行
        const chunk = ev.chunk.replace(/\n{3,}/g, "\n\n").replace(/\n+$/g, "");
        if (!chunk) return;
        this.appendPlain(chunk, ev.isStderr ? theme.error : theme.muted);
        return;
      }
      case "tool.approval.pending":
        fg = theme.warning;
        break;
      case "tool.approval.resolved":
        fg = ev.approved ? theme.success : theme.warning;
        break;
      case "run.completed":
        fg = theme.success;
        break;
      case "run.failed":
        fg = theme.error;
        break;
      case "user.reply.required":
        fg = theme.highlight;
        break;
      default:
        fg = undefined;
    }

    const text = formatEventForScrollback(envelope);
    if (text) {
      this.appendPlain(text, fg);
    }
  }

  /** 标记滚动日志已清空，并重置内部流式文本状态。 */
  markCleared(): void {
    this.rendered = false;
    this.lastStreamingText = "";
    this.appendPlain("── scrollback cleared ──", this.resolveTheme().muted);
  }

  /** 销毁滚动日志流。滚动日志本身不可变，无需逐条清理。 */
  destroy(): void {
    // 滚动日志不可变，无需逐条清理
  }

  /** 在已有内容后插入空行分隔，避免段落粘连。 */
  private writeSpacerIfNeeded(): void {
    if (this.rendered) {
      writeSolidToScrollback(this.renderer, () => (
        <text width="100%" wrapMode="none">
          {""}
        </text>
      ));
    }
  }
}
