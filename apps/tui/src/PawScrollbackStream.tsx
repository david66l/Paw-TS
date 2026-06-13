/**
 * PawScrollbackStream — rich scrollback rendering via createScrollbackWriter.
 *
 * Replaces the old imperative TextRenderable approach with SolidJS-driven
 * scrollback entries so we get colors, markdown inline styles, and consistent
 * layout through OpenTUI’s scrollback pipeline.
 */

import { writeSolidToScrollback } from "@opentui/solid";
import {
  type CliRenderer,
  type ColorInput,
  createTextAttributes,
} from "@opentui/core";
import type { RunEventEnvelope } from "@paw/core";
import { markdownToSegmentBlock } from "./markdown-parse.js";
import { formatEventForScrollback } from "./footer-state.js";
import { stripAssistantTextForScrollback } from "./scrollback-text.js";
import type { PawTheme } from "./theme.js";

export interface StreamCommit {
  readonly text?: string;
  readonly fg?: ColorInput;
  readonly markdown?: boolean;
}

export class PawScrollbackStream {
  private lastStreamingText = "";
  private rendered = false;

  constructor(
    private renderer: CliRenderer,
    private resolveTheme: () => PawTheme,
  ) {}

  append(commit: StreamCommit): void {
    if (commit.markdown && commit.text) {
      this.appendMarkdown(commit.text, commit.fg);
    } else if (commit.text) {
      this.appendPlain(commit.text, commit.fg);
    }
  }

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

  markCleared(): void {
    this.rendered = false;
    this.lastStreamingText = "";
    this.appendPlain("── scrollback cleared ──", this.resolveTheme().muted);
  }

  destroy(): void {
    // scrollback is immutable; nothing to clean up per-entry
  }

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
