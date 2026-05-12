import type { RunEventEnvelope } from "@paw/core";

import type { DisplayRow, RunRowTemplate } from "./display-rows.js";

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

function safeJsonSnippet(args: unknown, max = 160): string | undefined {
  try {
    const s = JSON.stringify(args);
    return truncate(s, max);
  } catch {
    return undefined;
  }
}

/**
 * Orchestrator → structured row templates (RFC §25).
 * Caller assigns monotonic `id` per row.
 */
export function templatesForRunEvent(
  envelope: RunEventEnvelope,
): RunRowTemplate[] {
  const { seq } = envelope;
  const ev = envelope.event;

  switch (ev.type) {
    case "run.started":
      return [{ variant: "headline", text: `Run — ${truncate(ev.goal, 200)}` }];
    case "loop.tick":
    case "phase":
    case "model.request":
    case "model.chunk":
    case "model.done":
      return [];
    case "agent.action": {
      const a = ev.action;
      if (a.type === "tool_call") {
        return [{ variant: "muted", text: `Action · tool_call · ${a.tool}` }];
      }
      if (a.type === "final_answer") {
        return [
          { variant: "headline", text: `Answer · ${truncate(a.summary, 160)}` },
        ];
      }
      if (a.type === "abort") {
        return [
          {
            variant: "error_line",
            seq,
            text: `Abort · ${truncate(a.reason, 160)}`,
          },
        ];
      }
      if (a.type === "ask_user") {
        return [
          { variant: "headline", text: `Ask · ${truncate(a.question, 160)}` },
        ];
      }
      return [
        {
          variant: "muted",
          text: `Action · plan_update · ${truncate(a.reason, 120)}`,
        },
      ];
    }
    case "tool.call": {
      const extra = safeJsonSnippet(ev.args);
      return [
        {
          variant: "muted",
          text: `→ ${ev.tool}${extra ? ` ${extra}` : ""}`,
        },
      ];
    }
    case "tool.result":
      return [
        {
          variant: "tool_panel",
          seq,
          tool: ev.tool,
          ok: ev.ok,
          summary: ev.summary,
          ...(ev.detail !== undefined ? { detail: ev.detail } : {}),
        },
      ];
    case "plan.updated":
      return [
        {
          variant: "plan_card",
          seq,
          revision: ev.revision,
          itemCount: ev.itemCount,
          reason: truncate(ev.reason, 200),
        },
      ];
    case "run.completed": {
      const rows: RunRowTemplate[] = [
        { variant: "headline", text: `Run · ${ev.status}` },
      ];
      const msg = ev.message.trim();
      if (msg) {
        rows.push({ variant: "text", text: msg });
      }
      return rows;
    }
    case "run.failed":
      return [{ variant: "error_line", seq, text: ev.message }];
    case "user.reply.required":
      return [
        {
          variant: "muted",
          text: `Awaiting reply · ${truncate(ev.question, 180)}`,
        },
      ];
    case "tool.approval.pending":
      return [
        {
          variant: "muted",
          text: `Approval · pending · ${ev.tool}`,
        },
      ];
    case "tool.approval.resolved":
      return [
        {
          variant: "muted",
          text: `Approval · ${ev.approved ? "approved" : "denied"} · ${ev.tool}`,
        },
      ];
    case "compression.prune.done":
      return [
        {
          variant: "muted",
          text: `Pruned context · freed ${ev.freedTokens} tokens (${ev.remainingTokens} remaining)`,
        },
      ];
    case "compression.auto_compact.started":
      return [
        {
          variant: "muted",
          text: `Compacting context · ${ev.beforeTokens} tokens`,
        },
      ];
    case "compression.auto_compact.done":
      return [
        {
          variant: "muted",
          text: `Context compacted · ${ev.afterTokens} tokens (summary ${ev.summaryTokens} tokens)`,
        },
      ];
    case "compression.skipped":
      return [
        {
          variant: "muted",
          text: `Compression skipped · ${truncate(ev.reason, 120)}`,
        },
      ];
    case "memory.extracted":
      return [
        {
          variant: "muted",
          text: `Memory updated · ${ev.entries} entr${ev.entries === 1 ? "y" : "ies"}`,
        },
      ];
    case "cost.update":
      return [
        {
          variant: "muted",
          text: `Cost · $${ev.estimatedCostUsd.toFixed(4)} · ${ev.totalTokens} tokens`,
        },
      ];
    default:
      return [];
  }
}

export function appendRunEventRows(
  append: (row: DisplayRow) => void,
  allocateId: () => number,
  envelope: RunEventEnvelope,
): void {
  const ev = envelope.event;
  if (ev.type === "tool.result.chunk") {
    append({
      id: allocateId(),
      variant: "tool_stream",
      tool: ev.tool,
      chunk: ev.chunk,
      isStderr: ev.isStderr,
    });
    return;
  }
  for (const t of templatesForRunEvent(envelope)) {
    const row = { ...t, id: allocateId() } satisfies {
      id: number;
    } & RunRowTemplate;
    append(row);
  }
}
