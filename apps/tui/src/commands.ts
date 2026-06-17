import fs from "node:fs";
import path from "node:path";
import {
  type StubRunSession,
  formatDoctorOutput,
  formatFsListOutput,
  formatFsReadOutput,
} from "@paw/cli-core";
import {
  FileSystemSessionStore,
  type SkillRegistry,
  listCheckpoints,
  renderSkillPrompt,
  undoLastCheckpoint,
} from "@paw/core";
import type { RunEventEnvelope } from "@paw/core";
import {
  type PawSettingsLocal,
  defaultSettingsPath,
  savePawSettingsLocal,
} from "@paw/settings";
import type { PersistentSession } from "@paw/cli-core";

/**
 * slash 命令执行上下文。
 *
 * 由 TUI 主入口传入，包含渲染回调、持久会话、运行会话控制等依赖。
 */
export interface SlashContext {
  readonly cwd: string;
  readonly pushText: (message: string) => void;
  readonly onRunEvent: (envelope: RunEventEnvelope) => void;
  readonly exit: () => void;
  readonly clear: () => void;
  /** 运行会话控制器，用于包装单次提交的中止信号。 */
  readonly runSession: StubRunSession;
  /** 当前 runId，用于 checkpoint / session 相关命令。 */
  readonly currentRunId?: string;
  /** Skill 注册表，用于 `/skill-name` 用户调用。 */
  readonly skillRegistry?: SkillRegistry;
  /** skill 加载目录，传给 orchestrator 用于模型侧 run_skill。 */
  readonly skillsDir?: string;
  /**
   * 持久化 orchestrator 会话。
   * TUI 主流程始终提供此会话，所有用户输入最终都通过它提交。
   */
  readonly session: PersistentSession;
  /** 运行时切换浅色/深色主题。 */
  readonly toggleTheme?: () => void;
}

/** 内置 slash 命令集合。 */
const KNOWN_COMMANDS = new Set([
  "/exit",
  "/quit",
  "/help",
  "/clear",
  "/doctor",
  "/fs-list",
  "/fs-read",
  "/stub",
  "/run",
  "/worktree",
  "/undo",
  "/checkpoints",
  "/sessions",
  "/replay",
  "/init",
  "/theme",
]);

/**
 * 判断输入是否为 slash 命令或已注册 skill。
 *
 * @param text 用户输入
 * @param skillRegistry 可选 skill 注册表
 */
function isSlashCommand(text: string, skillRegistry?: SkillRegistry): boolean {
  const head = text.trim().split(/\s+/)[0] ?? "";
  if (KNOWN_COMMANDS.has(head)) return true;
  if (skillRegistry) {
    const skillId = head.startsWith("/") ? head.slice(1) : head;
    return skillRegistry.has(skillId);
  }
  return false;
}

/**
 * 提交用户输入的一行文本。
 *
 * 自然语言或已注册 skill 交给持久会话执行；slash 命令分发到 {@link runSlashCommand}。
 *
 * @param raw 原始输入
 * @param ctx 执行上下文
 */
export async function submitUserLine(
  raw: string,
  ctx: SlashContext,
): Promise<void> {
  const v = raw.trim();
  if (!v) {
    return;
  }
  if (!isSlashCommand(v, ctx.skillRegistry)) {
    await submitToSession(v, ctx);
    return;
  }
  await runSlashCommand(v, ctx);
}

/**
 * 通过持久会话提交输入。
 *
 * @param goal 用户输入或展开后的目标
 * @param ctx 执行上下文
 */
async function submitToSession(goal: string, ctx: SlashContext): Promise<void> {
  const signal = ctx.runSession.begin();
  try {
    const result = await ctx.session.submit(goal, signal);
    if (result.status === "completed" && result.message) {
      ctx.pushText(result.message);
    }
  } catch (e: unknown) {
    ctx.pushText(e instanceof Error ? e.message : String(e));
  } finally {
    ctx.runSession.end();
  }
}

/**
 * 执行 slash 命令。
 *
 * @param raw 原始命令行
 * @param ctx 执行上下文
 */
export async function runSlashCommand(
  raw: string,
  ctx: SlashContext,
): Promise<void> {
  const { cwd, pushText, exit, clear } = ctx;
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  const head = parts[0];
  if (!head) {
    return;
  }

  if (head === "/exit" || head === "/quit") {
    exit();
    return;
  }

  if (head === "/help") {
    pushText(
      [
        "Goals & slash commands use the same TS orchestrator as: paw-ts stub-run --goal …",
        "/help",
        "/exit | /quit",
        "/doctor — workspace + settings (redacted)",
        "/clear",
        "/fs-list [dir] [--recursive]",
        "/fs-read <relative-path>",
        "/stub [goal…] | /run [goal…] — submit to persistent session",
        "/worktree [goal…] — not supported in TUI persistent session",
        "/undo — restore files from the last checkpoint of the current/most recent run",
        "/checkpoints — list checkpoints for the current run",
        "/sessions — list past runs",
        "/replay <runId> — replay a past run into the log",
        "/theme — toggle light/dark theme",
        "Ctrl+C — abort active agent run if any; otherwise exit",
        "Input — Enter to submit; Shift+Enter for newline; ←→ move cursor; ↑↓ recall history.",
        "When the agent asks to run a gated tool, use ↑↓ to choose Allow/Deny, then Enter.",
        "PAW_TUI_STRICT_TOOL_APPROVAL=1 — also prompt for read_file / list_dir (default: only unknown tools).",
      ].join("\n"),
    );
    return;
  }

  if (head === "/clear") {
    clear();
    return;
  }

  if (head === "/theme") {
    if (ctx.toggleTheme) {
      ctx.toggleTheme();
      pushText("Theme toggled.");
    } else {
      pushText("Theme toggle unavailable.");
    }
    return;
  }

  if (head === "/doctor") {
    const r = formatDoctorOutput(cwd);
    pushText(r.text);
    return;
  }

  if (head === "/fs-list") {
    const recursive = parts.includes("--recursive");
    const dirArg = parts.find((p, i) => i > 0 && p !== "--recursive") ?? ".";
    pushText(formatFsListOutput(cwd, dirArg, recursive).text);
    return;
  }

  if (head === "/fs-read") {
    const rel = parts[1];
    if (!rel) {
      pushText("/fs-read: missing <relative-path>");
      return;
    }
    pushText(formatFsReadOutput(cwd, rel).text);
    return;
  }

  if (head === "/stub" || head === "/run") {
    const goal = parts.slice(1).join(" ") || "stub";
    pushText(`submit: ${goal}`);
    await submitToSession(goal, ctx);
    return;
  }

  if (head === "/worktree") {
    pushText("worktree: not supported in TUI persistent session mode");
    return;
  }

  if (head === "/undo") {
    const runId = ctx.currentRunId;
    if (!runId) {
      pushText("/undo: no active run");
      return;
    }
    const restored = undoLastCheckpoint(cwd, runId);
    if (restored) {
      pushText(
        `Undo: restored ${restored.targets.length} file(s) from checkpoint seq ${restored.seq} (${restored.tool})`,
      );
    } else {
      pushText("/undo: no checkpoint found");
    }
    return;
  }

  if (head === "/checkpoints") {
    const runId = ctx.currentRunId;
    if (!runId) {
      pushText("/checkpoints: no active run");
      return;
    }
    const cps = listCheckpoints(cwd, runId);
    if (cps.length === 0) {
      pushText("No checkpoints for this run.");
      return;
    }
    const lines = cps.map(
      (cp) =>
        `  seq ${cp.seq} · ${cp.tool} · ${cp.targets.join(", ") || "(none)"}`,
    );
    pushText([`Checkpoints for ${runId}:`, ...lines].join("\n"));
    return;
  }

  if (head === "/sessions") {
    const store = new FileSystemSessionStore({ workspaceRoot: cwd });
    const runs = store.listRuns();
    if (runs.length === 0) {
      pushText("No past sessions found.");
      return;
    }
    const lines = runs.slice(0, 20).map((r) => {
      const status =
        r.status === "completed" ? "✓" : r.status === "failed" ? "✗" : "○";
      const goal = r.goal.slice(0, 50) + (r.goal.length > 50 ? "…" : "");
      const date = new Date(r.startedAt).toLocaleString();
      return `  ${status} ${r.runId} · ${goal} · ${r.toolCallCount} tools · ${date}`;
    });
    pushText(
      [
        `Past sessions (${runs.length} total, showing newest 20):`,
        ...lines,
      ].join("\n"),
    );
    return;
  }

  if (head === "/replay") {
    const runId = parts[1];
    if (!runId) {
      pushText("/replay: missing <runId>");
      return;
    }
    const store = new FileSystemSessionStore({ workspaceRoot: cwd });
    const events = store.loadRun(runId);
    if (!events || events.length === 0) {
      pushText(`/replay: run ${runId} not found or empty`);
      return;
    }
    pushText(`Replaying ${events.length} events from ${runId}…`);
    for (const envelope of events) {
      ctx.onRunEvent(envelope);
    }
    pushText(`Replay of ${runId} complete.`);
    return;
  }

  if (head === "/init") {
    const settingsPath = defaultSettingsPath(cwd);
    if (fs.existsSync(settingsPath)) {
      pushText(`Settings already exist at ${settingsPath}`);
      pushText("Use /doctor to view. Delete the file first to re-initialize.");
      return;
    }

    // 解析可选参数：--provider, --model, --key, --approval, --max-steps
    const args: Record<string, string> = {};
    for (let i = 1; i < parts.length; i += 2) {
      const key = parts[i];
      const val = parts[i + 1];
      if (key?.startsWith("--") && val) {
        args[key.slice(2)] = val;
      }
    }

    const provider = args.provider || "anthropic";
    const settings: PawSettingsLocal = {
      provider,
      approval: args.approval || "normal",
      max_steps: args["max-steps"]
        ? Number.parseInt(args["max-steps"], 10) || 30
        : 30,
    };
    if (args.key) {
      const keyProviders = ["anthropic", "openai", "qwen", "deepseek"] as const;
      if (keyProviders.includes(provider as (typeof keyProviders)[number])) {
        settings.models = {
          [provider]: {
            model: args.model || "claude-sonnet-4-6",
            apiKey: args.key,
          },
        };
      }
    } else if (args.model) {
      settings.model = args.model;
    }

    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    savePawSettingsLocal(settingsPath, settings);
    pushText(`Created ${settingsPath}`);
    pushText(JSON.stringify(settings, null, 2));
    pushText("Tip: add '.paw/' to .gitignore to avoid committing settings.");
    return;
  }

  // 兜底：检查是否为用户通过 `/skill-name` 调用已注册 skill
  const { skillRegistry } = ctx;
  if (skillRegistry) {
    const skillId = head.startsWith("/") ? head.slice(1) : head;
    if (skillRegistry.has(skillId)) {
      const skill = skillRegistry.get(skillId)!;
      const userArgs = parts.slice(1).join(" ");
      let rendered = renderSkillPrompt(skill, parseSlashSkillArgs(userArgs));
      // 若 skill 模板未消费 {{args}}，则将用户输入追加到末尾
      if (
        userArgs &&
        !skill.prompt.includes("{{args}}") &&
        !skill.prompt.includes("{{ args }}")
      ) {
        rendered = `${rendered}\n\nUser request: ${userArgs}`;
      }
      pushText(`skill: ${skillId}`);
      await submitToSession(rendered, ctx);
      return;
    }
  }

  pushText(`Unknown command: ${head} (see /help)`);
}

/**
 * 将 slash 命令参数解析为 skill 模板可用的 Record。
 *
 * 当前仅作为默认位置参数传递；后续可扩展为 `--key=value` 解析。
 *
 * @param raw 参数原始字符串
 */
function parseSlashSkillArgs(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  return { args: raw.trim() };
}
