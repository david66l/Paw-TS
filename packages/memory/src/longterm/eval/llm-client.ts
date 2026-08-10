/**
 * 最小 OpenAI 兼容 chat client（memory redteam 评测 harness 用）
 *
 * 配置解析优先级：CLI 显式 --provider > .paw/settings.local.json
 * （models.<name> + 顶层 provider/defaultProvider 字段）> 环境变量
 * （OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL）。
 * settings 文件从 cwd 向上最多找 4 层（CLI 运行目录可能是 packages/memory）。
 *
 * 安全纪律：apiKey 只用于请求头，绝不进入日志/错误信息/报告。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface ResolvedLlm {
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** 配置来源（诊断用，不含密钥） */
  source: string;
  providerName?: string;
}

export interface LlmStats {
  calls: number;
  retries: number;
  failures: number;
  totalMs: number;
  /** chars/4 粗估（prompt + 响应） */
  estimatedTokens: number;
}

/** 从 startDir 向上最多 maxUp 层找 .paw/settings.local.json */
export function findSettingsFile(startDir: string, maxUp = 4): string | null {
  let dir = startDir;
  for (let i = 0; i <= maxUp; i++) {
    const candidate = join(dir, ".paw", "settings.local.json");
    try {
      readFileSync(candidate);
      return candidate;
    } catch { /* 继续上溯 */ }
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

interface SettingsShape {
  provider?: string;
  defaultProvider?: string;
  models?: Record<string, { baseUrl?: string; base_url?: string; model?: string; apiKey?: string }>;
}

export function resolveLlmConfig(opts: {
  provider?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** 测试注入；默认读文件系统 */
  loadSettings?: (path: string) => SettingsShape;
}): ResolvedLlm | { error: string } {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const loadSettings = opts.loadSettings ?? ((p: string) => JSON.parse(readFileSync(p, "utf-8")) as SettingsShape);

  const settingsPath = findSettingsFile(cwd);
  let settings: SettingsShape | null = null;
  if (settingsPath) {
    try {
      settings = loadSettings(settingsPath);
    } catch {
      return { error: `settings 文件解析失败: ${settingsPath}` };
    }
  }

  // 1. CLI 显式 provider
  if (opts.provider) {
    const m = settings?.models?.[opts.provider];
    if (!m?.baseUrl || !m.model) {
      return { error: `provider "${opts.provider}" 在 settings 中不存在或缺 baseUrl/model` };
    }
    return { baseUrl: m.baseUrl, model: m.model, apiKey: m.apiKey, source: "cli+settings", providerName: opts.provider };
  }

  // 2. settings 默认 provider
  const defaultName = settings?.provider ?? settings?.defaultProvider;
  if (defaultName) {
    const m = settings?.models?.[defaultName];
    if (m?.baseUrl && m.model) {
      return { baseUrl: m.baseUrl, model: m.model, apiKey: m.apiKey, source: "settings", providerName: defaultName };
    }
  }

  // 3. 环境变量
  if (env.OPENAI_BASE_URL && env.OPENAI_API_KEY) {
    return {
      baseUrl: env.OPENAI_BASE_URL,
      model: env.OPENAI_MODEL ?? "gpt-4o-mini",
      apiKey: env.OPENAI_API_KEY,
      source: "env",
    };
  }

  return { error: "未找到 LLM 配置（--provider / settings.local.json / OPENAI_* 环境变量均不可用）" };
}

/**
 * OpenAI 兼容 chat client。complete(prompt) 形状对齐 DistillerLlm/RerankerLlm/JudgeLlm。
 * 超时默认 60s，失败（网络/5xx/429/超时）重试 1 次。
 */
export class ChatClient {
  readonly stats: LlmStats;

  constructor(
    private readonly config: ResolvedLlm,
    private readonly timeoutMs = 60_000,
    /** 可注入共享统计对象（backbone/judge 双 client 合并统计） */
    sharedStats?: LlmStats,
  ) {
    this.stats = sharedStats ?? { calls: 0, retries: 0, failures: 0, totalMs: 0, estimatedTokens: 0 };
  }

  async complete(prompt: string): Promise<string> {
    const t0 = Date.now();
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) this.stats.retries += 1;
      try {
        const text = await this.callOnce(prompt);
        this.stats.calls += 1;
        this.stats.totalMs += Date.now() - t0;
        this.stats.estimatedTokens += Math.ceil((prompt.length + text.length) / 4);
        return text;
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
      }
    }
    this.stats.failures += 1;
    this.stats.totalMs += Date.now() - t0;
    throw lastError ?? new Error("llm call failed");
  }

  private async callOnce(prompt: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        // 错误信息只带状态码，不带响应体（防密钥/内部信息外泄）
        throw new Error(`llm http ${res.status}`);
      }
      const data = await res.json() as { choices?: { message?: { content?: string } }[] };
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== "string" || content.length === 0) {
        throw new Error("llm empty content");
      }
      return content;
    } finally {
      clearTimeout(timer);
    }
  }
}
