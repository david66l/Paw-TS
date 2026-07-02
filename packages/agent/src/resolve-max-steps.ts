/**
 * 解析有效的 model↔tool 轮次上限。
 * ===============================
 *
 * 优先级：显式传入 > settings 文件 > 默认值（32）。
 *
 * 硬性上限（HARD_CAP = 256）：防止单个 Run 无限循环。
 *
 * @param workspaceRoot 工作区根目录（用于读取 .paw/settings.local.json）
 * @param override 调用方显式指定的 maxSteps（可选）
 * @returns 有效的 maxSteps 值（1 ~ HARD_CAP）
 */

import { readSetting } from "./settings.js";

/** 默认最大轮数 */
const DEFAULT_MAX_STEPS = 32;
/** 硬性上限：任何情况下不允许超过此值 */
const HARD_CAP = 256;

/** 验证并规范化 maxSteps 值 */
function parseMaxSteps(value: unknown): number | undefined {
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 1
  ) {
    return Math.min(Math.floor(value), HARD_CAP);
  }
  return undefined;
}

/**
 * 获取有效的 model↔tool 轮次上限。
 *
 * 优先级：
 * 1. override 参数显式传入
 * 2. settings.local.json 中的 max_steps
 * 3. DEFAULT_MAX_STEPS（32）
 */
export function resolveMaxSteps(
  workspaceRoot: string,
  override?: number,
): number {
  if (override !== undefined) {
    if (!Number.isFinite(override) || override < 1) {
      return DEFAULT_MAX_STEPS;
    }
    return Math.min(Math.floor(override), HARD_CAP);
  }
  return readSetting(
    workspaceRoot,
    (s) => s.max_steps,
    DEFAULT_MAX_STEPS,
    parseMaxSteps,
  );
}
