import fs from "node:fs";
import path from "node:path";
import {
  type StubRunOptions,
  type StubRunSession,
  formatDoctorOutput,
  formatFsListOutput,
  formatFsReadOutput,
  runStubRun,
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
import type { PersistentSession } from "./run-session-controller.js";

export interface SlashContext {
  readonly cwd: string;
  readonly pushText: (message: string) => void;
  readonly onRunEvent: (envelope: RunEventEnvelope) => void;
  readonly exit: () => void;
  readonly clear: () => void;
  readonly runSession?: StubRunSession;
  /** Current runId for checkpoint/session commands. */
  readonly currentRunId?: string;
  /** Optional orchestrator hooks (ask-user bridge, tool approval). */
  readonly orchestratorHooks?: Pick<
    StubRunOptions,
    "resolveAskUser" | "resolveToolApproval" | "approvalPolicy"
  >;
  /** Skill registry for /skill-name user invocations. */
  readonly skillRegistry?: SkillRegistry;
  /** Directory to load skills from (passed to orchestrator for model-facing run_skill). */
  readonly skillsDir?: string;
  /** Persistent orchestrator session. When set, input is injected into the
   *  existing conversation instead of starting a fresh run. */
  readonly session?: PersistentSession;
  /** Toggle light/dark theme at runtime. */
  readonly toggleTheme?: () => void;
}

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

function isSlashCommand(text: string, skillRegistry?: SkillRegistry): boolean {
  const head = text.trim().split(/\s+/)[0] ?? "";
  if (KNOWN_COMMANDS.has(head)) return true;
  if (skillRegistry) {
    const skillId = head.startsWith("/") ? head.slice(1) : head;
    return skillRegistry.has(skillId);
  }
  return false;
}

/** Natural language or `/…` — same backend as `paw-ts` (doctor, fs-*, stub-run). */
export async function submitUserLine(
  raw: string,
  ctx: SlashContext,
): Promise<void> {
  const v = raw.trim();
  if (!v) {
    return;
  }
  if (!isSlashCommand(v, ctx.skillRegistry)) {
    // TUI renders the user line and run events; avoid duplicate echo here.
    if (!ctx.onRunEvent) {
      ctx.pushText(`> ${v}`);
    }
    try {
      if (ctx.session) {
        const signal = ctx.runSession?.begin();
        try {
          const result = await ctx.session.submit(v, signal);
          if (
            result.status === "completed" &&
            result.message &&
            !ctx.onRunEvent
          ) {
            ctx.pushText(result.message);
          }
        } finally {
          ctx.runSession?.end();
        }
      } else {
        const r = await runStubRun(v, {
          workspaceRoot: ctx.cwd,
          onEvent: ctx.onRunEvent,
          runSession: ctx.runSession,
          resultTextFormat: "minimal",
          skillsDir: ctx.skillsDir,
          ...ctx.orchestratorHooks,
        });
        if (r.text.trim()) {
          ctx.pushText(r.text);
        }
      }
    } catch (e: unknown) {
      ctx.pushText(e instanceof Error ? e.message : String(e));
    }
    return;
  }
  await runSlashCommand(v, ctx);
}

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
        "/stub [goal…] | /run [goal…] — stub-run (default goal: stub)",
        "/worktree [goal…] — run in a temporary git worktree (isolated)",
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
    pushText(`stub-run: ${goal}`);
    try {
      if (ctx.session) {
        const signal = ctx.runSession?.begin();
        try {
          const result = await ctx.session.submit(goal, signal);
          if (
            result.status === "completed" &&
            result.message &&
            !ctx.onRunEvent
          ) {
            pushText(result.message);
          }
        } finally {
          ctx.runSession?.end();
        }
      } else {
        const r = await runStubRun(goal, {
          workspaceRoot: cwd,
          onEvent: ctx.onRunEvent,
          runSession: ctx.runSession,
          resultTextFormat: "minimal",
          skillsDir: ctx.skillsDir,
          ...ctx.orchestratorHooks,
        });
        if (r.text.trim()) {
          pushText(r.text);
        }
      }
    } catch (e: unknown) {
      pushText(e instanceof Error ? e.message : String(e));
    }
    return;
  }

  if (head === "/worktree") {
    const goal = parts.slice(1).join(" ") || "stub";
    if (ctx.session) {
      pushText("worktree: not supported in persistent session mode");
      return;
    }
    pushText(`worktree-run: ${goal}`);
    try {
      const r = await runStubRun(goal, {
        workspaceRoot: cwd,
        onEvent: ctx.onRunEvent,
        runSession: ctx.runSession,
        resultTextFormat: "minimal",
        useWorktree: true,
        skillsDir: ctx.skillsDir,
        ...ctx.orchestratorHooks,
      });
      if (r.text.trim()) {
        pushText(r.text);
      }
    } catch (e: unknown) {
      pushText(e instanceof Error ? e.message : String(e));
    }
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

    // Parse optional args: --provider, --model, --key, --approval, --max-steps
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

  // Fallback: check skill registry for /skill-name user invocations
  const { skillRegistry } = ctx;
  if (skillRegistry) {
    const skillId = head.startsWith("/") ? head.slice(1) : head;
    if (skillRegistry.has(skillId)) {
      const skill = skillRegistry.get(skillId)!;
      const userArgs = parts.slice(1).join(" ");
      let rendered = renderSkillPrompt(skill, parseSlashSkillArgs(userArgs));
      // If the skill template didn't consume {{args}} (no placeholder), append user input
      if (
        userArgs &&
        !skill.prompt.includes("{{args}}") &&
        !skill.prompt.includes("{{ args }}")
      ) {
        rendered = `${rendered}\n\nUser request: ${userArgs}`;
      }
      pushText(`skill: ${skillId}`);
      try {
        if (ctx.session) {
          const signal = ctx.runSession?.begin();
          try {
            const result = await ctx.session.submit(rendered, signal);
            if (
              result.status === "completed" &&
              result.message &&
              !ctx.onRunEvent
            ) {
              pushText(result.message);
            }
          } finally {
            ctx.runSession?.end();
          }
        } else {
          const r = await runStubRun(rendered, {
            workspaceRoot: cwd,
            onEvent: ctx.onRunEvent,
            runSession: ctx.runSession,
            resultTextFormat: "minimal",
            skillsDir: ctx.skillsDir,
            ...ctx.orchestratorHooks,
          });
          if (r.text.trim()) {
            pushText(r.text);
          }
        }
      } catch (e: unknown) {
        pushText(e instanceof Error ? e.message : String(e));
      }
      return;
    }
  }

  pushText(`Unknown command: ${head} (see /help)`);
}

/** Parse slash-command args into a Record for skill template rendering. */
function parseSlashSkillArgs(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  // Simple: pass as positional default arg. Skills with named params
  // can be extended later with --key=value parsing.
  return { args: raw.trim() };
}
