/**
 * Structured rows for Kimi-style log rendering (RFC §25.4 display layer).
 */

/** Rows emitted from run-event mapping (no id until inserted into log). */
export type RunRowTemplate =
  | {
      readonly variant: "text";
      readonly text: string;
    }
  | {
      readonly variant: "muted";
      readonly text: string;
    }
  | {
      readonly variant: "headline";
      readonly text: string;
    }
  | {
      readonly variant: "tool_panel";
      readonly seq: number;
      readonly tool: string;
      readonly ok: boolean;
      readonly summary: string;
      readonly detail?: string;
    }
  | {
      readonly variant: "plan_card";
      readonly seq: number;
      readonly revision: number;
      readonly itemCount: number;
      readonly reason: string;
    }
  | {
      readonly variant: "error_line";
      readonly seq: number;
      readonly text: string;
    }
  | {
      readonly variant: "tool_stream";
      readonly tool: string;
      readonly chunk: string;
      readonly isStderr: boolean;
    };

export type DisplayRow =
  | { readonly id: number; readonly variant: "welcome" }
  | ({ readonly id: number } & RunRowTemplate);

export function splitLinesToTextRows(
  id: () => number,
  text: string,
  muted = false,
): DisplayRow[] {
  return text
    .split("\n")
    .map((line) =>
      muted
        ? { id: id(), variant: "muted", text: line }
        : { id: id(), variant: "text", text: line },
    );
}
