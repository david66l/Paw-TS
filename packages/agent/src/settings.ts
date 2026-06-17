import {
  defaultSettingsPath,
  loadPawSettingsLocal,
  type PawSettingsLocal,
} from "@paw/settings";

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
