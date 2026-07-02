/**
 * LLM 清单选择器，用于级联记忆检索。
 * ================================
 *
 * 在记忆检索的级联流程中，当关键词匹配返回过多候选时，
 * 用 LLM 从记忆清单（只含标题和摘要，不含完整内容）中挑选最相关的 5 条。
 *
 * 为什么用 LLM 而不是纯关键词？
 * 关键词匹配无法理解语义相关性。比如用户问"优化数据库查询"，
 * 关键词可能匹配不到"添加 Redis 缓存层"这条记忆，但 LLM 能识别其相关性。
 *
 * 为什么只传清单不传完整内容？
 * 清单只是标题+摘要，token 消耗很小（~几百 token），
 * 完整内容可能很大（数千 token），不适合传给 LLM 做选择。
 */

import type { LlmMemorySelectFn } from "@paw/core";
import type { LanguageModel } from "@paw/models";

import { completeAuxiliaryTask } from "./auxiliary-complete.js";

const SELECTOR_SYSTEM =
  "You select project memory entries relevant to a coding task. Respond with JSON only.";

/** 构建 LLM 选择器的用户提示词 */
function buildSelectorUser(input: Parameters<LlmMemorySelectFn>[0]): string {
  const lines = [
    "Pick up to 5 memory IDs most relevant to the user's goal.",
    "",
    `Goal: ${input.query.goal}`,
  ];

  // 最近的错误信息 → 帮助选择相关修复记忆
  if (input.query.errorMessage) {
    lines.push(`Recent error: ${input.query.errorMessage}`);
  }
  // 最近使用的工具 → 帮助选择相关工具记忆
  if (input.query.recentToolNames && input.query.recentToolNames.length > 0) {
    lines.push(`Recent tools: ${input.query.recentToolNames.join(", ")}`);
  }

  lines.push(
    "",
    "Available memories:",
    input.manifest,
    "",
    'Respond with JSON: {"selected_ids":["id1","id2"]}',
  );
  return lines.join("\n");
}

/** 解析 LLM 返回的 JSON，提取 selected_ids 数组 */
function parseSelectedIds(text: string): string[] {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return [];

  try {
    const parsed = JSON.parse(match[0]) as { selected_ids?: unknown };
    if (!Array.isArray(parsed.selected_ids)) return [];
    return parsed.selected_ids.filter(
      (id): id is string => typeof id === "string" && id.length > 0,
    );
  } catch {
    return [];
  }
}

/**
 * 创建一个 LLM 记忆选择函数。
 *
 * 用于记忆检索级联：当关键词匹配返回的候选太多时，
 * 用此函数筛选出最相关的 ≤5 条。
 */
export function createLlmMemorySelectFn(
  model: LanguageModel,
  signal?: AbortSignal,
): LlmMemorySelectFn {
  return async (input) => {
    const text = await completeAuxiliaryTask({
      model,
      system: SELECTOR_SYSTEM,
      user: buildSelectorUser(input),
      signal,
    });
    return parseSelectedIds(text);
  };
}
