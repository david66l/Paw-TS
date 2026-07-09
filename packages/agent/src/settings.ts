/**
 * Agent 层级的 settings 读取工具。
 *
 * 从 `.paw/settings.local.json` 中安全读取配置。
 * 读取失败时回退默认值，不抛异常。
 */

import {
  defaultSettingsPath,
  loadPawSettingsLocal,
  type PawSettingsLocal,
} from "@paw/settings";

/**
 * 安全读取单个设置字段。
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

/** 加载完整 settings 对象，失败返回 undefined */
export function readPawSettingsLocal(
  workspaceRoot: string,
): PawSettingsLocal | undefined {
  try {
    return loadPawSettingsLocal(defaultSettingsPath(workspaceRoot));
  } catch {
    return undefined;
  }
}
