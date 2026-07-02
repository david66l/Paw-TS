/**
 * 默认语言模型工厂
 *
 * ## 是什么
 * 根据本地配置文件（~/.paw/settings.json）自动检测并创建对应的语言模型实例。
 *
 * ## 为什么需要
 * 用户可能使用不同的 LLM 提供商（Anthropic、OpenAI、DeepSeek、Qwen、Ollama 等），
 * 每种提供商的 API 协议、默认模型、默认 Base URL 都不同。本模块提供统一入口：
 * 用户只需在配置文件中填写 API key，系统自动选择正确的客户端和参数。
 *
 * ## 关键设计决策
 * 1. **PROVIDERS 注册表**：单一真实来源（Single Source of Truth）。新增提供商只需
 *    在此表中添加一行 + 更新配置 schema，不需要修改其他代码。
 * 2. **自动检测（detectProvider）**：当用户没有显式指定 provider 字段时，根据已配置
 *    的 API key 自动推断。兼容历史配置：OpenAI key + DeepSeek base URL → 识别为
 *    deepseek 提供商。
 * 3. **模型能力推断（resolveCapabilities）**：根据模型 ID 的模式匹配，自动填充上下文
 *    窗口和最大输出 token 数，无需用户手动配置。
 * 4. **离线安全**：配置缺失或加载失败时返回 FakeLanguageModel（假模型），确保程序
 *    不会因配置问题崩溃。
 * 5. **Ollama 支持**：本地 Ollama 实例通过 OpenAI 兼容接口访问，host 和 model 均可
 *    配置，默认指向 localhost:11434。
 */

import {
  type CredentialProvider,
  defaultSettingsPath,
  hasApiKey,
  loadPawSettingsLocal,
  resolveApiKey,
  resolveBaseUrl,
  resolveModel,
} from "@paw/settings";

import { AnthropicCompatibleModel } from "./anthropic-compatible.js";
import { FakeLanguageModel } from "./fake-model.js";
import type { LanguageModel, ModelCapabilities } from "./language-model.js";
import { OpenAICompatibleModel } from "./openai-compatible.js";

/**
 * 已知模型的上下文窗口和能力配置表。
 * 按模式匹配优先级排列：更具体的正则放前面，更通用的放后面。
 * 例如 deepseek-v4 必须在 /deepseek/i 之前匹配，避免被通用规则误判。
 */
const KNOWN_CAPABILITIES: Array<{ pattern: RegExp; caps: ModelCapabilities }> =
  [
    // ── Anthropic 系列 ──
    {
      pattern: /claude-3[.-]5-sonnet|claude-sonnet-4/i,
      caps: { contextWindow: 200_000, maxOutputTokens: 8_192 },
    },
    {
      pattern: /claude-3[.-]5-haiku|claude-haiku/i,
      caps: { contextWindow: 200_000, maxOutputTokens: 8_192 },
    },
    {
      pattern: /claude-opus/i,
      caps: { contextWindow: 200_000, maxOutputTokens: 32_768 },
    },
    // 通用 Claude 兜底匹配
    { pattern: /claude/i, caps: { contextWindow: 200_000 } },
    // ── OpenAI 系列 ──
    {
      pattern: /gpt-4o|gpt-4[.]1/i,
      caps: { contextWindow: 128_000, maxOutputTokens: 16_384 },
    },
    {
      pattern: /gpt-4[.-]turbo/i,
      caps: { contextWindow: 128_000, maxOutputTokens: 4_096 },
    },
    {
      // o1/o3/o4 推理模型，输出上限更高
      pattern: /o1|o3|o4/i,
      caps: { contextWindow: 200_000, maxOutputTokens: 100_000 },
    },
    {
      pattern: /gpt-3[.]5/i,
      caps: { contextWindow: 16_385, maxOutputTokens: 4_096 },
    },
    // ── DeepSeek 系列 ──
    // V4 模型：1M 上下文（必须在通用 /deepseek/i 之前匹配）
    {
      pattern: /deepseek-v4|deepseek\/v4/i,
      caps: { contextWindow: 1_000_000, maxOutputTokens: 384_000 },
    },
    // 通用 DeepSeek 兜底
    { pattern: /deepseek/i, caps: { contextWindow: 64_000 } },
    // ── Qwen（通义千问）系列 ──
    {
      pattern: /qwen-max|qwen-turbo|qwen-plus|qwen2\.5/i,
      caps: { contextWindow: 128_000, maxOutputTokens: 8_192 },
    },
    // ── Ollama 常用模型 ──
    {
      pattern: /llama3/i,
      caps: { contextWindow: 128_000, maxOutputTokens: 8_192 },
    },
    {
      pattern: /qwen2\.5/i,
      caps: { contextWindow: 128_000, maxOutputTokens: 8_192 },
    },
    {
      pattern: /deepseek-r1/i,
      caps: { contextWindow: 128_000, maxOutputTokens: 8_192 },
    },
    {
      pattern: /codellama/i,
      caps: { contextWindow: 16_384, maxOutputTokens: 4_096 },
    },
    {
      pattern: /mistral/i,
      caps: { contextWindow: 32_768, maxOutputTokens: 4_096 },
    },
    {
      pattern: /phi[34]/i,
      caps: { contextWindow: 128_000, maxOutputTokens: 4_096 },
    },
  ];

/**
 * 根据模型 ID 字符串，通过正则匹配推断其上下文窗口和最大输出 token 数。
 * 若没有匹配到任何已知模型，返回保守的默认值（32K 上下文）。
 */
function resolveCapabilities(modelId: string): ModelCapabilities {
  for (const { pattern, caps } of KNOWN_CAPABILITIES) {
    if (pattern.test(modelId)) return caps;
  }
  return { contextWindow: 32_768 };
}

/** API 客户端类型：Anthropic 协议或 OpenAI 兼容协议 */
type ClientType = "anthropic" | "openai";

/** 每个提供商的元信息 */
interface ProviderEntry {
  readonly client: ClientType;
  readonly defaultModel: string;
  readonly defaultBaseUrl: string;
}

/**
 * 提供商注册表：API-key-based 提供商的唯一真实来源。
 * 添加新提供商只需更新此表 + schema 定义即可，无需修改其他逻辑代码。
 */
const PROVIDERS: Record<CredentialProvider, ProviderEntry> = {
  anthropic: {
    client: "anthropic",
    defaultModel: "claude-3-5-sonnet-20241022",
    defaultBaseUrl: "https://api.anthropic.com/v1",
  },
  openai: {
    client: "openai",
    defaultModel: "gpt-4o-mini",
    defaultBaseUrl: "https://api.openai.com/v1",
  },
  qwen: {
    client: "openai",
    defaultModel: "qwen-plus",
    defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  },
  deepseek: {
    client: "openai",
    defaultModel: "deepseek-chat",
    defaultBaseUrl: "https://api.deepseek.com",
  },
};

/**
 * 当用户没有设置 `provider` 字段时，根据凭证自动检测提供商。
 *
 * 向后兼容：如果配置了 OpenAI key 但 base URL 指向 DeepSeek，
 * 则识别为 deepseek 提供商（而非 openai）。
 */
function detectProvider(
  settings: ReturnType<typeof loadPawSettingsLocal>,
): CredentialProvider | undefined {
  if (hasApiKey(settings, "anthropic")) return "anthropic";
  if (hasApiKey(settings, "deepseek")) return "deepseek";
  if (hasApiKey(settings, "openai")) {
    const openaiBaseUrl = resolveBaseUrl(settings, "openai");
    // OpenAI key + DeepSeek URL → 按 DeepSeek 处理（兼容历史配置）
    if (openaiBaseUrl?.includes("deepseek")) return "deepseek";
    return "openai";
  }
  if (hasApiKey(settings, "qwen")) return "qwen";
  return undefined;
}

/**
 * 根据本地配置创建默认语言模型实例。
 *
 * 决策流程：
 * 1. 显式 provider → 直接使用对应客户端
 * 2. provider=ollama → 走 Ollama 本地部署逻辑
 * 3. 无 provider → 自动检测（detectProvider）
 * 4. 以上都不满足 → 返回 FakeLanguageModel（离线安全模式）
 *
 * @param workspaceRoot - 工作区根目录，用于定位配置文件
 * @returns LanguageModel 实例（永远不会返回 undefined/抛出异常）
 */
export function createDefaultLanguageModel(
  workspaceRoot: string,
): LanguageModel {
  try {
    const settingsPath = defaultSettingsPath(workspaceRoot);
    const s = loadPawSettingsLocal(settingsPath);

    // 单入口：显式 provider 优先，否则回退到 API key 自动检测
    const provider = s.provider?.trim().toLowerCase();

    // ── Ollama 本地部署分支 ──
    if (provider === "ollama") {
      const ollamaHost = s.ollama_host?.trim();
      const ollamaModel =
        (s.ollama_model as string | undefined)?.trim() || s.model?.trim();
      if (!ollamaModel) {
        console.warn(
          "[paw] provider=ollama but no model configured. Using fake model.",
        );
        return new FakeLanguageModel();
      }
      return new OpenAICompatibleModel({
        apiKey: "ollama", // Ollama 不需要真实 API key，占位即可
        baseUrl: ollamaHost
          ? `${ollamaHost.replace(/\/$/, "")}/v1`
          : "http://localhost:11434/v1",
        model: ollamaModel,
        capabilities: resolveCapabilities(ollamaModel),
      });
    }

    // ── 云服务提供商分支 ──
    const activeProvider =
      (provider as CredentialProvider | undefined) || detectProvider(s);
    if (activeProvider && activeProvider in PROVIDERS) {
      const entry = PROVIDERS[activeProvider];
      const apiKey = resolveApiKey(s, activeProvider) || "";
      const baseUrl = resolveBaseUrl(s, activeProvider) || entry.defaultBaseUrl;
      const model = resolveModel(s, activeProvider, entry.defaultModel);
      if (entry.client === "anthropic") {
        return new AnthropicCompatibleModel({
          apiKey,
          baseUrl,
          model,
          capabilities: resolveCapabilities(model),
        });
      }
      return new OpenAICompatibleModel({
        apiKey,
        baseUrl,
        model,
        capabilities: resolveCapabilities(model),
      });
    }

    // 配置文件已加载但没有配置 API key
    console.warn(
      "[paw] Settings loaded but no API keys found. Using fake model.",
    );
  } catch (e) {
    // 配置文件读取失败（文件不存在、权限问题、JSON 格式错误等）
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[paw] Settings unavailable (${msg}). Using fake model.`);
  }
  // 所有正常路径都失败，返回离线安全的假模型
  return new FakeLanguageModel();
}
