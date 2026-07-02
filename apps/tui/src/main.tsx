#!/usr/bin/env bun
import path from "node:path";
import { type KeyEvent, createCliRenderer } from "@opentui/core";
import { writeSolidToScrollback } from "@opentui/solid";
import {
  createPersistentSession,
  createRunSessionController,
} from "@paw/agent";
import { findPawRoot } from "@paw/core";
import { SkillRegistry, loadSkillsFromDirectory } from "@paw/core";
import {
  defaultSettingsPath,
  hasApiKey,
  loadPawSettingsLocal,
  resolveBaseUrl,
  resolveModel,
} from "@paw/settings";
import { PawFooter } from "./PawFooter.js";
import { submitUserLine } from "./commands.js";
import { fallbackTheme, resolveTheme } from "./theme.js";

import { approvalPolicyWhenStrict } from "./approval-policy.js";
import { tuiStrictToolApprovalFromEnv } from "./env.js";

/**
 * 根据当前工作区设置解析模型标签，用于欢迎消息展示。
 *
 * 支持 anthropic / openai / qwen / deepseek / ollama，并处理一些兼容逻辑。
 *
 * @returns 模型标签字符串
 */
function resolveModelLabel(): string {
  try {
    const pawRoot = findPawRoot(process.cwd()) ?? process.cwd();
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
    // 兼容：OpenAI key 指向 DeepSeek base URL
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
  // 创建 OpenTUI 渲染器：分屏 footer 模式
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

  // 从终端调色板解析主题
  const theme = await resolveTheme(renderer).catch(() => fallbackTheme);
  renderer.setBackgroundColor(theme.background);

  // 在欢迎消息中展示模型信息
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

  // 等待滚动日志稳定后再挂载 footer
  await renderer.idle().catch(() => {});

  // ── 会话初始化 ──
  const workspaceRoot = findPawRoot(process.cwd()) ?? process.cwd();
  const skillsDir = path.join(workspaceRoot, ".paw", "skills");
  const skillRegistry = new SkillRegistry();
  for (const skill of loadSkillsFromDirectory(skillsDir)) {
    skillRegistry.register(skill);
  }

  const sessionCtrl = createRunSessionController();

  // 审批 / 提问的 resolver（通过引用捕获）
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
      footer.handleRunEvent(envelope);
    },
  });

  const footer = new PawFooter(renderer, {
    theme,
    contextWindow: 128_000,
    onSubmit: (text) => {
      if (!sessionCtrl.tryBeginSubmission()) {
        footer.appendPlain(
          "Waiting for previous run to finish.",
          theme.warning,
        );
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

  /**
   * 将用户输入提交给 orchestrator 执行。
   *
   * @param text 用户输入文本
   */
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
        currentRunId: persistentSession.runId,
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

  // SIGINT 处理：先尝试中断当前运行，否则退出
  const sigint = () => {
    if (renderer.isDestroyed) {
      process.exit(0);
    }
    footer.handleKeyDown({ name: "c", ctrl: true } as KeyEvent);
  };
  process.on("SIGINT", sigint);

  // 等待 footer 关闭（用户主动退出）
  await footer.idle().catch(() => {});

  process.off("SIGINT", sigint);
}

await main();
