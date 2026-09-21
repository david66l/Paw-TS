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

/** 欢迎横幅能展示的 provider。 */
const LABEL_PROVIDERS = [
  "anthropic",
  "openai",
  "qwen",
  "deepseek",
  "glm",
  "ollama",
] as const;
type LabelProvider = (typeof LABEL_PROVIDERS)[number];

function isLabelProvider(value: string): value is LabelProvider {
  return (LABEL_PROVIDERS as readonly string[]).includes(value);
}

/** 为已确定的 provider 生成横幅标签。 */
function providerLabel(
  provider: LabelProvider,
  s: ReturnType<typeof loadPawSettingsLocal>,
  model: string | undefined,
): string {
  switch (provider) {
    case "anthropic":
      return `anthropic:${model || "claude-3-5-sonnet"}`;
    case "openai": {
      const base = resolveBaseUrl(s, "openai");
      const name = model || "gpt-4o-mini";
      return base?.includes("deepseek") ? `deepseek:${name}` : `openai:${name}`;
    }
    case "qwen": {
      const name = resolveModel(s, "qwen", "qwen-plus");
      const base = resolveBaseUrl(s, "qwen");
      return base && !base.includes("dashscope") ? `qwen3:${name}` : `qwen:${name}`;
    }
    case "deepseek":
      return `deepseek:${resolveModel(s, "deepseek", "deepseek-chat")}`;
    case "glm":
      return `glm:${resolveModel(s, "glm", "glm-5.3-flash")}`;
    case "ollama": {
      const name =
        (s.ollama_model as string | undefined)?.trim() || model || "llama3";
      const host = s.ollama_host?.trim() || "http://localhost:11434";
      return `ollama:${name} @ ${host}`;
    }
  }
}

/**
 * 根据当前工作区设置解析模型标签，用于欢迎消息展示。
 *
 * 显式配置的 `provider` **优先且具有权威性**；只有在未配置（或配置了未知值）
 * 时才退回按凭据存在性嗅探。
 *
 * 之前的实现把两者放在同一条 `||` 链上并且按固定顺序检查，导致任何
 * 「配置里存在但并未启用」的 provider 条目会劫持标签 —— 例如
 * `.paw/settings.local.json` 里 provider 明明是 "glm"，但只要 qwen 条目留着
 * 占位 apiKey（"not-needed" 也算非空），横幅就会显示 qwen。同时旧实现完全没有
 * glm 分支，尽管 @paw/models 的 PROVIDERS 与 @paw/settings 的
 * CredentialProvider 都把 glm 当作一等 provider。
 */
function resolveModelLabel(): string {
  try {
    const pawRoot = findPawRoot(process.cwd()) ?? process.cwd();
    const p = defaultSettingsPath(pawRoot);
    const s = loadPawSettingsLocal(p);
    const model = s.model?.trim();

    const configured = s.provider?.trim().toLowerCase();
    if (configured && isLabelProvider(configured)) {
      return providerLabel(configured, s, model);
    }

    // 未显式配置 provider：按凭据存在性嗅探。
    for (const candidate of LABEL_PROVIDERS) {
      if (candidate === "ollama") continue;
      if (hasApiKey(s, candidate)) return providerLabel(candidate, s, model);
    }
    // 兼容：OpenAI key 指向 DeepSeek base URL
    const openaiBaseUrl = resolveBaseUrl(s, "openai");
    if (openaiBaseUrl?.includes("deepseek")) {
      return `deepseek:${model || "deepseek-chat"}`;
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
