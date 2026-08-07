/**
 * 记忆子系统本地配置（spec v2 §9.4，M9）
 *
 * 落点选择：独立小文件 `.paw/memory-config.json`，而非 packages/settings 的
 * settings.local.json schema。理由：settings schema 是 zod 强校验的共享契约
 * （apps/agent 在线路径依赖），为两个 MVP 灰度开关动它有扩散风险；
 * memory CLI 需要脱离 apps 独立可用。`.paw/` 已被 gitignore（本文件不进 git）。
 *
 * 注意（apps 侧接线任务，不在本里程碑）：`memory.enable=false` 的零调用语义
 * 由 orchestrator 在构造管线/检索器前检查——enable=false 时干脆不构造；
 * 本模块只保证 CLI 与管线层面的 honor 逻辑。
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export interface MemoryLocalConfig {
  /** CI/只读场景：写入事件全部丢弃（检索只读正常），§6.7 */
  readonly: boolean;
  /** shadow 灰度：读取管线只记录假设注入包（§11.2，M8） */
  shadow: boolean;
}

export const DEFAULT_MEMORY_CONFIG: MemoryLocalConfig = { readonly: false, shadow: false };

function configPath(root: string): string {
  return join(root, ".paw", "memory-config.json");
}

/** 读取配置；文件不存在/损坏 → 默认配置（零记忆基线不阻塞，场景 H） */
export async function loadMemoryConfig(root: string = process.cwd()): Promise<MemoryLocalConfig> {
  try {
    const raw = JSON.parse(await readFile(configPath(root), "utf-8")) as Record<string, unknown>;
    return {
      readonly: raw.readonly === true,
      shadow: raw.shadow === true,
    };
  } catch {
    return { ...DEFAULT_MEMORY_CONFIG };
  }
}

export async function saveMemoryConfig(
  patch: Partial<MemoryLocalConfig>,
  root: string = process.cwd(),
): Promise<MemoryLocalConfig> {
  const current = await loadMemoryConfig(root);
  const next = { ...current, ...patch };
  await mkdir(join(root, ".paw"), { recursive: true });
  await writeFile(configPath(root), JSON.stringify(next, null, 2) + "\n", "utf-8");
  return next;
}
