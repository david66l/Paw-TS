/**
 * 凭证解析与脱敏模块 —— 统一管理多 AI 提供商的鉴权凭据。
 *
 * ## 为什么需要这个模块
 * Paw 支持 Anthropic、OpenAI、Qwen、DeepSeek 等多个 AI 提供商，
 * 每个提供商都有独立的 API Key、Base URL 和 Model 配置。
 * 这些配置可能来自三个层次：nested models 字段、旧版扁平字段、环境变量。
 * 本模块提供统一的"优先级解析链"和安全的"密钥脱敏"工具。
 *
 * ## 核心设计决策
 * 1. **三级优先级解析**：models.<provider>.xxx → 旧版扁平字段 → 环境变量。
 *    新代码优先使用 models 嵌套结构，同时保持向后兼容。
 * 2. **密钥脱敏**：`redactSecrets()` 递归处理 nested 和 flat 两种密钥字段，
 *    确保日志/调试输出不会泄露敏感的 API 密钥。
 * 3. **CredentialProvider 联合类型**：只维护一份 provider 列表，
 *    通过 Record 映射自动派生字段名和环境变量名，避免硬编码散落各处。
 */

import type { PawSettingsLocal } from "./schema.js";

/** 需要 API Key + 可选 Base URL 的 AI 提供商类型。 */
export type CredentialProvider = "anthropic" | "openai" | "qwen" | "deepseek";

/** API Key 的扁平字段名映射：provider → settings 字段 key。 */
const API_KEY_FIELDS: Record<CredentialProvider, keyof PawSettingsLocal> = {
  anthropic: "anthropic_api_key",
  openai: "openai_api_key",
  qwen: "qwen_api_key",
  deepseek: "deepseek_api_key",
};

/** Base URL 的扁平字段名映射：provider → settings 字段 key。 */
const BASE_URL_FIELDS: Record<CredentialProvider, keyof PawSettingsLocal> = {
  anthropic: "anthropic_base_url",
  openai: "openai_base_url",
  qwen: "qwen_base_url",
  deepseek: "deepseek_base_url",
};

/** API Key 的环境变量名映射：provider → 环境变量名。 */
const API_KEY_ENVS: Record<CredentialProvider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  qwen: "QWEN_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
};

/** Base URL 的环境变量名映射：provider → 环境变量名。 */
const BASE_URL_ENVS: Record<CredentialProvider, string> = {
  anthropic: "ANTHROPIC_BASE_URL",
  openai: "OPENAI_BASE_URL",
  qwen: "QWEN_BASE_URL",
  deepseek: "DEEPSEEK_BASE_URL",
};

/**
 * 解析指定 provider 的模型名称。
 *
 * 优先级：models.<provider>.model → 顶层 model 字段 → fallback 默认值。
 *
 * @param settings - 本地设置对象
 * @param provider - AI 提供商标识
 * @param fallback - 所有配置均未设置时的兜底模型名
 * @returns 最终使用的模型名称
 */
export function resolveModel(
  settings: PawSettingsLocal,
  provider: CredentialProvider,
  fallback: string,
): string {
  // 优先从 nested models 配置中读取
  const fromModels = settings.models?.[provider]?.model;
  if (typeof fromModels === "string" && fromModels.trim()) {
    return fromModels.trim();
  }
  // 退回到顶层 model 字段（旧版风格）
  const topLevel = settings.model;
  if (typeof topLevel === "string" && topLevel.trim()) {
    return topLevel.trim();
  }
  // 以上均未配置则使用兜底值
  return fallback;
}

/**
 * 解析指定 provider 的 API 密钥。
 *
 * 优先级：
 *   1. `models.<provider>.apiKey`  —— 新的结构化配置
 *   2. 旧版扁平字段 `<provider>_api_key`
 *   3. 环境变量（如 `ANTHROPIC_API_KEY`）
 *
 * @param settings - 本地设置对象
 * @param provider - AI 提供商标识
 * @returns 解析到的密钥字符串，未配置则返回 undefined
 */
export function resolveApiKey(
  settings: PawSettingsLocal,
  provider: CredentialProvider,
): string | undefined {
  // 优先级 1：nested models 中的 apiKey
  const fromModels = settings.models?.[provider]?.apiKey;
  if (typeof fromModels === "string" && fromModels.trim()) {
    return fromModels.trim();
  }
  // 优先级 2：旧版扁平字段
  const legacy = settings[API_KEY_FIELDS[provider]];
  if (typeof legacy === "string" && legacy.trim()) {
    return legacy.trim();
  }
  // 优先级 3：环境变量
  return process.env[API_KEY_ENVS[provider]]?.trim() || undefined;
}

/**
 * 解析指定 provider 的基础 URL。
 *
 * 优先级：
 *   1. `models.<provider>.baseUrl`  —— 新的结构化配置
 *   2. 旧版扁平字段 `<provider>_base_url`
 *   3. 环境变量（如 `ANTHROPIC_BASE_URL`）
 *
 * @param settings - 本地设置对象
 * @param provider - AI 提供商标识
 * @returns 解析到的 URL 字符串，未配置则返回 undefined
 */
export function resolveBaseUrl(
  settings: PawSettingsLocal,
  provider: CredentialProvider,
): string | undefined {
  const fromModels = settings.models?.[provider]?.baseUrl;
  if (typeof fromModels === "string" && fromModels.trim()) {
    return fromModels.trim();
  }
  const legacy = settings[BASE_URL_FIELDS[provider]];
  if (typeof legacy === "string" && legacy.trim()) {
    return legacy.trim();
  }
  return process.env[BASE_URL_ENVS[provider]]?.trim() || undefined;
}

/**
 * 判断指定 provider 是否有可用的 API 密钥（settings 或环境变量）。
 *
 * @param settings - 本地设置对象
 * @param provider - AI 提供商标识
 * @returns 密钥可用返回 true，否则返回 false
 */
export function hasApiKey(
  settings: PawSettingsLocal,
  provider: CredentialProvider,
): boolean {
  return resolveApiKey(settings, provider) !== undefined;
}

/**
 * 返回 settings 的脱敏副本，将所有已知 API 密钥替换为掩码。
 *
 * 同时处理 nested models 中的 apiKey 和旧版扁平字段。
 * 用于日志输出或调试打印，防止敏感信息泄露。
 *
 * @param settings - 原始本地设置对象
 * @returns 密钥被掩码替换后的浅拷贝对象
 */
export function redactSecrets(settings: PawSettingsLocal): PawSettingsLocal {
  const copy: Record<string, unknown> = { ...settings };

  // 脱敏 nested models 中的 apiKey
  if (copy.models && typeof copy.models === "object") {
    const modelsCopy: Record<string, unknown> = {};
    for (const [name, config] of Object.entries(copy.models)) {
      if (config && typeof config === "object") {
        const cfgCopy: Record<string, unknown> = { ...config };
        if (typeof cfgCopy.apiKey === "string") {
          cfgCopy.apiKey = maskKey(cfgCopy.apiKey);
        }
        modelsCopy[name] = cfgCopy;
      } else {
        modelsCopy[name] = config;
      }
    }
    copy.models = modelsCopy;
  }

  // 脱敏旧版扁平字段中的密钥
  for (const provider of Object.keys(API_KEY_FIELDS) as CredentialProvider[]) {
    const field = API_KEY_FIELDS[provider];
    const value = copy[field];
    if (typeof value === "string") {
      copy[field] = maskKey(value);
    }
  }

  return copy as PawSettingsLocal;
}

/**
 * 对密钥字符串进行掩码处理。
 * - 短密钥（< 8 字符）：显示 "(set, hidden)" 或 "(not set)"
 * - 正常密钥：显示 "(set, …后4位)"
 *
 * @param v - 原始密钥字符串
 * @returns 脱敏后的显示字符串
 */
function maskKey(v: string): string {
  if (!v || v.length < 8) {
    return v ? "(set, hidden)" : "(not set)";
  }
  return `(set, …${v.slice(-4)})`;
}
