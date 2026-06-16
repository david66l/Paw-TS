#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import { createCliRenderer, type KeyEvent } from "@opentui/core";
import { writeSolidToScrollback } from "@opentui/solid";
import { findPawRoot } from "@paw/cli-core";
import {
  defaultSettingsPath,
  hasApiKey,
  loadPawSettingsLocal,
  resolveBaseUrl,
  resolveModel,
} from "@paw/settings";
import { SkillRegistry, loadSkillsFromDirectory } from "@paw/core";
import { PawFooter } from "./PawFooter.js";
import { fallbackTheme, resolveTheme } from "./theme.js";
import { submitUserLine } from "./commands.js";
import { createPersistentSession, createRunSessionController } from "./run-session-controller.js";
import { approvalPolicyWhenStrict } from "./approval-policy.js";
import { tuiStrictToolApprovalFromEnv } from "./env.js";

/** Walk up from cwd to find the nearest .paw/ with settings or skills. */
function resolvePawRootForDisplay(cwd: string): string {
  let dir = path.resolve(cwd);
  for (let i = 0; i < 64; i++) {
    const pawDir = path.join(dir, ".paw");
    if (
      fs.existsSync(path.join(pawDir, "settings.local.json")) ||
      fs.existsSync(path.join(pawDir, "skills"))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return findPawRoot(cwd) ?? cwd;
}

function resolveModelLabel(): string {
  try {
    const pawRoot = resolvePawRootForDisplay(process.cwd());
    const p = defaultSettingsPath(pawRoot);
    const s = loadPawSettingsLocal(p);
    const provider = s.provider?.trim().toLowerCase();
    const model = s.model?.trim();
    if (provider === "anthropic" || hasApiKey(s, "anthropic")) {
      return `anthropic:${model || "claude-3-5-sonnet"}`;
    }
    if (provider === "openai" || hasApiKey(s, "openai")) {
      const base = resolveBaseUrl(s, "openai");
      const modelName = model || "gpt-4o-mini";
      if (base?.includes("deepseek")) {
        return `deepseek:${modelName}`;
      }
      return `openai:${modelName}`;
    }
    if (provider === "qwen" || hasApiKey(s, "qwen")) {
      const base = resolveBaseUrl(s, "qwen");
      const modelName = resolveModel(s, "qwen", "qwen-plus");
      if (base && !base.includes("dashscope")) {
        return `qwen3:${modelName}`;
      }
      return `qwen:${modelName}`;
    }
    if (provider === "deepseek" || hasApiKey(s, "deepseek")) {
      return `deepseek:${model || "deepseek-chat"}`;
    }
    // Backward compatibility: OpenAI key pointing at DeepSeek base URL.
    const openaiBaseUrl = resolveBaseUrl(s, "openai");
    if (openaiBaseUrl?.includes("deepseek")) {
      return `deepseek:${model || "deepseek-chat"}`;
    }
    if (provider === "ollama") {
      const ollamaModel =
        (s.ollama_model as string | undefined)?.trim() || model || "llama3";
      const host = s.ollama_host?.trim() || "http://localhost:11434";
      return `ollama:${ollamaModel} @ ${host}`;
    }
    return "fake (no API keys configured)";
  } catch {
    return "fake (settings not found)";
  }
}

async function main() {
  const renderer = await createCliRenderer({
    screenMode: "split-footer",
    footerHeight: 7,
    externalOutputMode: "capture-stdout",
    clearOnShutdown: true,
    targetFps: 30,
    maxFps: 60,
    exitOnCtrlC: false,
    useMouse: false,
    autoFocus: true,
  });

  // Resolve theme from terminal palette
  const theme = await resolveTheme(renderer).catch(() => fallbackTheme);
  renderer.setBackgroundColor(theme.background);

  // Show model info in welcome message
  const modelLabel = resolveModelLabel();

  writeSolidToScrollback(renderer, () => (
    <text fg={theme.brand}> Welcome to Paw (TS harness)</text>
  ));
  writeSolidToScrollback(renderer, () => (
    <text fg={theme.muted}>
      Model: {modelLabel} | Type your goal and press Enter. Use /help for
      commands.
    </text>
  ));
  renderer.requestRender();

  // Wait for scrollback to settle before attaching footer
  await renderer.idle().catch(() => {});

  // ── Session setup ──
  const workspaceRoot = resolvePawRootForDisplay(process.cwd());
  const skillsDir = path.join(workspaceRoot, ".paw", "skills");
  const skillRegistry = new SkillRegistry();
  for (const skill of loadSkillsFromDirectory(skillsDir)) {
    skillRegistry.register(skill);
  }

  const sessionCtrl = createRunSessionController();
  let currentRunId = "";

  // Approval / ask resolvers (captured by reference)
  let resolveApproval: ((approved: boolean) => void) | null = null;
  let resolveAsk: ((answer: string) => void) | null = null;

  const persistentSession = createPersistentSession({
    workspaceRoot,
    skillsDir,
    resolveAskUser: async ({ question }) => {
      return new Promise<string>((resolve) => {
        resolveAsk = resolve;
        footer.present({ type: "ask", question });
      });
    },
    resolveToolApproval: async ({ tool }) => {
      return new Promise<boolean>((resolve) => {
        resolveApproval = resolve;
        footer.present({ type: "approval", tool, selectedIndex: 0 });
      });
    },
    approvalPolicy: approvalPolicyWhenStrict(tuiStrictToolApprovalFromEnv()),
    onEvent: (envelope) => {
      const ev = envelope.event;
      if (ev.type === "run.started") {
        currentRunId = envelope.runId;
      }
      footer.handleRunEvent(envelope);
    },
  });

  const footer = new PawFooter(renderer, {
    theme,
    contextWindow: 128_000,
    onSubmit: (text) => {
      if (!sessionCtrl.tryBeginSubmission()) {
        footer.appendPlain("Waiting for previous run to finish.", theme.warning);
        return;
      }
      footer.patch({ inputBusy: true });
      footer.appendPlain(`› ${text}`, theme.userText);

      handleRun(text);
    },
    onInterrupt: () => {
      if (sessionCtrl.abortIfRunning()) {
        footer.appendPlain("Run aborted.", theme.warning);
        sessionCtrl.endSubmission();
        footer.patch({ inputBusy: false, streaming: false, phase: "idle" });
        return true;
      }
      return false;
    },
    onApprovalReply: (approved) => {
      if (!resolveApproval) return;
      const r = resolveApproval;
      resolveApproval = null;
      r(approved);
      footer.present({ type: "prompt" });
    },
    onAskReply: (answer) => {
      if (!resolveAsk) return;
      const r = resolveAsk;
      resolveAsk = null;
      r(answer);
      footer.present({ type: "prompt" });
    },
    onExit: () => {
      persistentSession.dispose();
      footer.close();
      renderer.destroy();
    },
  });

  async function handleRun(text: string) {
    try {
      await submitUserLine(text, {
        cwd: process.cwd(),
        pushText: (msg: string) => {
          footer.appendMarkdown(msg, theme.assistantText);
        },
        onRunEvent: (envelope) => {
          footer.handleRunEvent(envelope);
        },
        exit: () => {
          persistentSession.dispose();
          footer.close();
          renderer.destroy();
        },
        clear: () => {
          footer.markCleared();
        },
        toggleTheme: () => {
          footer.setTheme(theme);
        },
        runSession: sessionCtrl.runSession,
        currentRunId,
        skillRegistry,
        skillsDir,
        session: persistentSession,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      footer.appendPlain(msg, theme.error);
    } finally {
      footer.patch({ inputBusy: false });
      sessionCtrl.endSubmission();
    }
  }

  // SIGINT handling
  const sigint = () => {
    if (renderer.isDestroyed) {
      process.exit(0);
    }
    footer.handleKeyDown({ name: "c", ctrl: true } as KeyEvent);
  };
  process.on("SIGINT", sigint);

  // Wait until footer closes (user exits)
  await footer.idle().catch(() => {});

  process.off("SIGINT", sigint);
}

await main();
