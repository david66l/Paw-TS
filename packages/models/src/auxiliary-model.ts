/**
 * 辅助模型（Auxiliary Model）工厂
 *
 * ## 是什么
 * 创建 DeepSeek Flash（deepseek-v4-flash）语言模型实例，用于轻量级辅助任务。
 *
 * ## 为什么需要
 * 主对话模型通常贵且慢。对于记忆选择（memory selection）、上下文压缩（compression）、
 * 信息提取（extraction）以及子 Agent 执行等非核心任务，使用一个便宜、快速、长上下文的
 * 辅助模型可以显著降低延迟和成本。
 *
 * ## 关键设计决策
 * 1. **DeepSeek Flash 作为首选**：1M token 上下文窗口 + 384K 最大输出，性价比极高，
 *    特别适合需要处理大量上下文的辅助任务。
 * 2. **凭证降级策略**：优先使用显式配置的 deepseek API key；如果没有，回退到 openai
 *    兼容模式的 DeepSeek 配置——保证在只配了 OpenAI key 且 base URL 指向 DeepSeek
 *    的场景下也能正常工作。
 * 3. **安全失败**：任何异常（文件读取失败、配置缺失等）都返回 `undefined`，调用方自行
 *    决定是否回退到主模型或其他方案。
 */

import {
  defaultSettingsPath,
  hasApiKey,
  loadPawSettingsLocal,
  resolveApiKey,
  resolveBaseUrl,
} from "@paw/settings";

import type { LanguageModel } from "./language-model.js";
import { OpenAICompatibleModel } from "./openai-compatible.js";

/** 辅助模型固定使用 DeepSeek V4 Flash 型号（仅在无命名预设时的兜底型号名） */
const DEEPSEEK_FLASH_MODEL = "deepseek-v4-flash";

/**
 * 从 models 命名预设里挑「flash / 便宜」条目：名字或 model 含 "flash" 即命中。
 * 支撑别名写法（provider 指向 deepseekv4pro，另有 deepseekv4flash 作辅助模型）。
 */
function findFlashModelConfig(
  models: ReturnType<typeof loadPawSettingsLocal>["models"],
) {
  if (!models) return undefined;
  const hit = Object.entries(models).find(
    ([name, cfg]) => /flash/i.test(name) || /flash/i.test(cfg?.model ?? ""),
  );
  return hit?.[1];
}

/**
 * 创建一个便宜的辅助模型，用于记忆选择、压缩、提取和子 Agent 任务。
 *
 * @param workspaceRoot - 工作区根目录路径，用于定位本地配置文件
 * @returns LanguageModel 实例，若配置缺失或加载失败则返回 undefined
 */
export function createDeepSeekFlashModel(
  workspaceRoot: string,
): LanguageModel | undefined {
  try {
    const settings = loadPawSettingsLocal(defaultSettingsPath(workspaceRoot));

    // 1) 命名预设：直接用 flash 别名条目的 key/baseUrl/model（别名写法首选）
    const flash = findFlashModelConfig(settings.models);
    if (flash?.apiKey?.trim() && flash.model?.trim()) {
      return new OpenAICompatibleModel({
        apiKey: flash.apiKey.trim(),
        baseUrl: flash.baseUrl?.trim() || "https://api.deepseek.com",
        model: flash.model.trim(),
        capabilities: { contextWindow: 1_000_000, maxOutputTokens: 384_000 },
        supportsThinkingToggle: true,
        ...(flash.thinkingEnabled !== undefined
          ? { thinkingEnabled: flash.thinkingEnabled }
          : {}),
        ...(flash.reasoningEffort !== undefined
          ? { reasoningEffort: flash.reasoningEffort }
          : {}),
      });
    }

    // 2) 兜底：显式 deepseek 凭证 → openai 兼容凭证 + 固定 flash 型号名
    let apiKey: string | undefined;
    let baseUrl: string | undefined;
    if (hasApiKey(settings, "deepseek")) {
      apiKey = resolveApiKey(settings, "deepseek");
      baseUrl = resolveBaseUrl(settings, "deepseek");
    } else {
      apiKey = resolveApiKey(settings, "openai");
      baseUrl = resolveBaseUrl(settings, "openai");
    }
    // 没有任何可用 API key，无法创建模型
    if (!apiKey) return undefined;

    return new OpenAICompatibleModel({
      apiKey,
      baseUrl: baseUrl || "https://api.deepseek.com",
      model: DEEPSEEK_FLASH_MODEL,
      capabilities: { contextWindow: 1_000_000, maxOutputTokens: 384_000 },
      supportsThinkingToggle: true,
    });
  } catch {
    // 任何异常（文件不存在、JSON 解析失败等）都安全返回 undefined
    return undefined;
  }
}
