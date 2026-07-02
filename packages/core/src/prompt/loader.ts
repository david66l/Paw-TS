/**
 * Prompt 加载器（Prompt Loader）——根据模型提供商解析对应的系统提示词（system prompt）。
 *
 * ## 模块职责（架构定位）
 * 本模块是系统提示词的入口层，负责将模型 ID 映射到最适合该模型家族的提示词文件。
 * 不同的 LLM 模型对提示词的响应方式不同（例如 DeepSeek 对 markdown 格式更敏感，
 * Claude 对 XML 标签结构的遵循度更高），因此需要为不同模型准备独立的提示词副本。
 *
 * ## 核心设计决策
 * 1. **基于文件的提示词管理**：每个模型家族的提示词存储为独立的 .txt 文件，
 *    便于非开发人员直接编辑和版本管理，无需修改任何代码。
 * 2. **基于启发式规则的模型选择**：使用 `selectPromptFile` 函数通过模型 ID 中的
 *    关键字（如 "deepseek"、"claude"）来判断应该加载哪个文件，避免引入重量级
 *    的模型注册表。
 * 3. **优雅降级**：当特定模型的提示词文件缺失时，自动回退到 `default.txt`；
 *    如果默认文件也不存在，返回空字符串由调用方处理，确保系统不会因文件缺失而崩溃。
 * 4. **借鉴 OpenCode 的模式**：这个按模型分文件的组织方式参考了 OpenCode 项目
 *    中 `session/prompt/` 的架构，将每种模型的提示词作为独立单元管理。
 *
 * ## 文件结构
 * ```
 * prompt/
 * ├── loader.ts      ← 本文件（加载逻辑）
 * ├── default.txt    ← 通用默认提示词（Claude / GPT 系列使用）
 * └── deepseek.txt   ← DeepSeek 和 Qwen 系列专用提示词
 * ```
 *
 * Pattern adopted from OpenCode's session/prompt/ system (per-model .txt files).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Prompt 文件存放目录，通过 import.meta.dirname 推导运行时路径 */
const PROMPT_DIR = join(import.meta.dirname ?? join(process.cwd(), "packages/core/src/prompt"));

/**
 * 根据给定的模型 ID 解析对应的系统提示词文本。
 *
 * 工作流程：
 * 1. 调用 `selectPromptFile` 根据模型 ID 选择对应的 .txt 文件名
 * 2. 尝试读取该文件内容
 * 3. 如果文件不存在，回退到 `default.txt`
 * 4. 如果默认文件也不存在，返回空字符串（由调用方处理）
 *
 * @param modelId - 可选参数，如 "deepseek-v3"、"claude-sonnet-4-20250514" 等
 * @returns 完整的系统提示词文本（已去除首尾空白）
 */
export function resolveBasePrompt(modelId?: string): string {
  const file = selectPromptFile(modelId);
  try {
    // 首选：读取模型专属提示词
    return readFileSync(join(PROMPT_DIR, file), "utf-8").trim();
  } catch {
    // 回退：模型专属文件缺失时，尝试加载默认提示词
    if (file !== "default.txt") {
      try {
        return readFileSync(join(PROMPT_DIR, "default.txt"), "utf-8").trim();
      } catch {
        return ""; // 连默认文件都不存在，返回空字符串由调用方处理（caller should handle empty prompt）
      }
    }
    return "";
  }
}

/**
 * 基于模型 ID 的启发式规则，选择对应的提示词文件名。
 *
 * 选择逻辑（按优先级从高到低）：
 * - 包含 "deepseek" → `deepseek.txt`
 * - 包含 "qwen"     → `deepseek.txt`（Qwen 的行为模式与 DeepSeek 相似，共享同一份提示词）
 * - 包含 "claude" 或 "anthropic" → `default.txt`（Claude 系列使用默认提示词）
 * - 包含 "gpt" 或 "openai" → `default.txt`（GPT 系列使用默认提示词）
 * - 其他任何模型 → `default.txt`
 *
 * @param modelId - 模型标识符（可能为 undefined，此时返回默认文件）
 * @returns 对应的 .txt 文件名（不含路径）
 */
function selectPromptFile(modelId?: string): string {
  if (!modelId) return "default.txt";

  const id = modelId.toLowerCase();

  if (id.includes("deepseek")) return "deepseek.txt";
  if (id.includes("qwen")) return "deepseek.txt";    // Qwen 与 DeepSeek 行为相似，共用同一份提示词（Qwen shares DeepSeek's prompt — similar behavior）
  if (id.includes("claude") || id.includes("anthropic")) return "default.txt";
  if (id.includes("gpt") || id.includes("openai")) return "default.txt";

  return "default.txt";
}
