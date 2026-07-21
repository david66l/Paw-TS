/**
 * 桌面 slash 命令 — 复用 harnessClient / packages 逻辑，不重写业务。
 */

import {
  requestCheckpointList,
  requestCheckpointUndo,
  requestDoctor,
  requestHostStatus,
  requestRunLoad,
  requestRunsList,
} from "./harnessClient";

export type SlashResult = {
  /** 写入聊天的系统消息（可多条） */
  readonly messages: readonly string[];
  /** 是否消费了输入（true = 不再当普通 goal 发送） */
  readonly handled: boolean;
  /** 清空当前会话消息（/clear） */
  readonly clearMessages?: boolean;
};

const HELP_TEXT = [
  "Paw 桌面 slash 命令：",
  "/help — 显示本帮助",
  "/clear — 清空当前会话消息",
  "/doctor — 环境体检（workspace / settings / memory）",
  "/status — 模型与 skills 状态",
  "/checkpoints [runId] — 列出检查点（默认最近一次 run）",
  "/undo [runId] — 撤销最近一次文件检查点",
  "/sessions — 磁盘 Run 历史（.paw/sessions）",
  "/replay <runId> — 加载 run 事件摘要",
  "",
  "自然语言仍会交给 Agent。工具默认自动批准。",
].join("\n");

function headAndRest(raw: string): { head: string; rest: string; args: string[] } {
  const trimmed = raw.trim();
  const parts = trimmed.split(/\s+/).filter(Boolean);
  const head = (parts[0] ?? "").toLowerCase();
  const args = parts.slice(1);
  return { head, rest: args.join(" "), args };
}

/**
 * 若输入是 slash 命令则执行并返回结果；否则 handled=false。
 */
export async function tryHandleSlashCommand(
  raw: string,
  ctx: {
    readonly lastRunId: string | null;
    readonly workspaceRoot?: string;
  },
): Promise<SlashResult> {
  const text = raw.trim();
  if (!text.startsWith("/")) {
    return { handled: false, messages: [] };
  }

  const { head, args } = headAndRest(text);

  if (head === "/help" || head === "/?") {
    return { handled: true, messages: [HELP_TEXT] };
  }

  if (head === "/clear") {
    return {
      handled: true,
      messages: ["已清空当前会话消息。"],
      clearMessages: true,
    };
  }

  if (head === "/doctor") {
    try {
      const r = await requestDoctor(ctx.workspaceRoot);
      return {
        handled: true,
        messages: [
          `Doctor ${r.ok ? "✓" : "✗"}\n${r.text}`,
        ],
      };
    } catch (e) {
      return {
        handled: true,
        messages: [`Doctor 失败：${e instanceof Error ? e.message : String(e)}`],
      };
    }
  }

  if (head === "/status") {
    try {
      const r = await requestHostStatus(ctx.workspaceRoot);
      return {
        handled: true,
        messages: [
          [
            "Status",
            `model: ${r.modelLabel}`,
            `skills: ${r.skillsCount}（${r.skillsDir}）`,
            `workspace: ${r.workspaceRoot}`,
            r.error ? `error: ${r.error}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        ],
      };
    } catch (e) {
      return {
        handled: true,
        messages: [`Status 失败：${e instanceof Error ? e.message : String(e)}`],
      };
    }
  }

  if (head === "/checkpoints") {
    const runId = args[0] || ctx.lastRunId;
    if (!runId) {
      return {
        handled: true,
        messages: ["/checkpoints: 没有 runId（先跑一次任务，或 /checkpoints <runId>）"],
      };
    }
    try {
      const r = await requestCheckpointList(runId, ctx.workspaceRoot);
      if (!r.ok) {
        return {
          handled: true,
          messages: [`Checkpoints 失败：${r.error ?? "unknown"}`],
        };
      }
      if (r.items.length === 0) {
        return {
          handled: true,
          messages: [`Checkpoints · ${runId}\n（无检查点）`],
        };
      }
      const lines = r.items.map(
        (c) =>
          `  seq ${c.seq} · ${c.tool} · ${c.targets.join(", ") || "(none)"}`,
      );
      return {
        handled: true,
        messages: [`Checkpoints · ${runId}\n${lines.join("\n")}`],
      };
    } catch (e) {
      return {
        handled: true,
        messages: [
          `Checkpoints 失败：${e instanceof Error ? e.message : String(e)}`,
        ],
      };
    }
  }

  if (head === "/undo") {
    const runId = args[0] || ctx.lastRunId;
    if (!runId) {
      return {
        handled: true,
        messages: ["/undo: 没有 runId（先跑一次任务，或 /undo <runId>）"],
      };
    }
    try {
      const r = await requestCheckpointUndo(runId, ctx.workspaceRoot);
      if (!r.ok || !r.restored) {
        return {
          handled: true,
          messages: [`Undo 失败：${r.error ?? "没有可撤销的检查点"}`],
        };
      }
      const t = r.restored;
      return {
        handled: true,
        messages: [
          `Undo ✓ · run ${runId}\n恢复 seq ${t.seq} · ${t.tool} · ${t.targets.join(", ") || "(none)"}`,
        ],
      };
    } catch (e) {
      return {
        handled: true,
        messages: [`Undo 失败：${e instanceof Error ? e.message : String(e)}`],
      };
    }
  }

  if (head === "/sessions" || head === "/runs") {
    try {
      const r = await requestRunsList(ctx.workspaceRoot);
      if (!r.ok) {
        return {
          handled: true,
          messages: [`Run 历史失败：${r.error ?? "unknown"}`],
        };
      }
      if (r.items.length === 0) {
        return {
          handled: true,
          messages: ["Run 历史：暂无记录（.paw/sessions）"],
        };
      }
      const lines = r.items.slice(0, 20).map((item) => {
        const st =
          item.status === "completed"
            ? "✓"
            : item.status === "failed"
              ? "✗"
              : "○";
        const goal =
          item.goal.length > 48 ? `${item.goal.slice(0, 48)}…` : item.goal;
        const date = new Date(item.startedAt).toLocaleString();
        return `  ${st} ${item.runId} · ${goal} · ${item.toolCallCount} tools · ${date}`;
      });
      return {
        handled: true,
        messages: [
          `Run 历史（${r.items.length}，显示最新 ${Math.min(20, r.items.length)}）\n${lines.join("\n")}`,
        ],
      };
    } catch (e) {
      return {
        handled: true,
        messages: [
          `Run 历史失败：${e instanceof Error ? e.message : String(e)}`,
        ],
      };
    }
  }

  if (head === "/replay") {
    const runId = args[0];
    if (!runId) {
      return {
        handled: true,
        messages: ["/replay: 需要 <runId>（先 /sessions 查看）"],
      };
    }
    try {
      const r = await requestRunLoad(runId, {
        workspaceRoot: ctx.workspaceRoot,
        limit: 80,
      });
      if (!r.ok) {
        return {
          handled: true,
          messages: [`Replay 失败：${r.error ?? "unknown"}`],
        };
      }
      const lines = r.events.map(
        (ev, i) =>
          `  ${ev.seq ?? i + 1}. ${ev.summary}`,
      );
      return {
        handled: true,
        messages: [
          `Replay · ${runId}（${r.events.length}/${r.total} 事件）\n${lines.join("\n") || "（无事件）"}`,
        ],
      };
    } catch (e) {
      return {
        handled: true,
        messages: [
          `Replay 失败：${e instanceof Error ? e.message : String(e)}`,
        ],
      };
    }
  }

  // 未知 slash：提示 help，不送进 agent（避免模型困惑）
  return {
    handled: true,
    messages: [`未知命令 ${head}。输入 /help 查看可用命令。`],
  };
}
