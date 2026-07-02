/**
 * Agent 层级的 settings 读取工具。
 * ===============================
 *
 * 从 `.paw/settings.local.json` 中安全读取配置。
 * 所有读取函数都带有默认值和异常保护——settings 文件缺失或损坏不会导致崩溃。
 *
 * 导出的函数：
 * - readSetting()：通用的安全读取单个设置字段
 * - readPawSettingsLocal()：读取完整 settings 对象
 * - readEmbeddingConfig()：读取 embedding 模型配置
 * - computeMemoryEmbedding()：计算记忆的向量 embedding
 * - computeQueryEmbedding()：计算查询的向量 embedding
 */

import {
  defaultSettingsPath,
  loadPawSettingsLocal,
  type PawSettingsLocal,
} from "@paw/settings";
import { EmbeddingCache, resolveEmbeddingConfig } from "@paw/core";
import type { EmbeddingConfig } from "@paw/core";

/**
 * 安全读取 `.paw/settings.local.json` 中的单个字段。
 *
 * 读取失败或解析函数返回 `undefined` 时，返回默认值。
 *
 * @param workspaceRoot 工作区根目录
 * @param selector 从 settings 对象中取出目标字段
 * @param defaultValue 默认值
 * @param parse 验证并转换字段值；无效时返回 `undefined`
 */
export function readSetting<T>(
  workspaceRoot: string,
  selector: (settings: PawSettingsLocal) => unknown,
  defaultValue: T,
  parse: (value: unknown) => T | undefined,
): T {
  try {
    const settings = loadPawSettingsLocal(defaultSettingsPath(workspaceRoot));
    const parsed = parse(selector(settings));
    if (parsed !== undefined) {
      return parsed;
    }
  } catch {
    // settings 文件不存在或损坏时使用默认值
  }
  return defaultValue;
}

/** 加载完整的 `.paw/settings.local.json` 对象，失败返回 undefined */
export function readPawSettingsLocal(
  workspaceRoot: string,
): PawSettingsLocal | undefined {
  try {
    return loadPawSettingsLocal(defaultSettingsPath(workspaceRoot));
  } catch {
    return undefined;
  }
}

/** 解析配置的 memory embedding 配置（如果存在） */
export function readEmbeddingConfig(
  workspaceRoot: string,
): EmbeddingConfig | undefined {
  const settings = readPawSettingsLocal(workspaceRoot);
  if (!settings) return undefined;
  return (
    resolveEmbeddingConfig(
      settings as Record<string, unknown> as {
        memory_embedding_model?: string;
        ollama_host?: string;
      },
    ) ?? undefined
  );
}

/**
 * 使用配置的 embedding 模型计算记忆的向量（best-effort）。
 *
 * 用于语义相似度检索：将记忆文本转为向量，存入 AutoMemoryStore，
 * 后续检索时通过余弦相似度匹配最相关的记忆。
 */
export async function computeMemoryEmbedding(
  workspaceRoot: string,
  input: { title: string; summary: string; content: string },
): Promise<number[] | undefined> {
  const embConfig = readEmbeddingConfig(workspaceRoot);
  if (!embConfig) return undefined;
  try {
    const cache = new EmbeddingCache(embConfig);
    return (await cache.computeMemoryEmbedding(input)) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * 使用配置的 embedding 模型计算查询的向量（best-effort）。
 *
 * 在记忆检索时，将用户查询转为向量，与存储的记忆向量做语义匹配。
 */
export async function computeQueryEmbedding(
  workspaceRoot: string,
  query: string,
): Promise<number[] | undefined> {
  const embConfig = readEmbeddingConfig(workspaceRoot);
  if (!embConfig) return undefined;
  try {
    const cache = new EmbeddingCache(embConfig);
    return (await cache.computeEmbedding(query)) ?? undefined;
  } catch {
    return undefined;
  }
}
