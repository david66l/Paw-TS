/**
 * 工作区根目录解析与 CLI 参数解析工具。
 *
 * ## 为什么需要这个模块
 * paw-ts CLI 需要一致的"工作区根目录"解析逻辑：
 * - 用户可通过 `--root <dir>` 显式指定
 * - 未指定时默认为当前工作目录（cwd）
 * - 对于 fs 命令等，还需要从子命令后提取位置参数（跳过 flag）
 *
 * ## 核心设计决策
 * 1. **`--root` 优先级**：`--root <dir>` 显式值 > cwd
 * 2. **`tailPositionalArgs`**：从子命令后提取位置参数，
 *    跳过 `--root <value>` 对和所有以 `--` 开头的 flag。
 *    这确保 CLI 命令如 `paw fs read --root /proj --recursive some/file.txt`
 *    能正确提取 `some/file.txt`。
 */

import path from "node:path";

/**
 * 从 argv 中解析工作区根目录。
 *
 * 规则：
 * - 如果 argv 包含 `--root <dir>`，使用该目录
 * - 否则返回 cwd
 *
 * @param cwd - 当前工作目录
 * @param argv - 命令行参数数组
 * @returns 解析后的绝对路径
 */
export function parseRootFromArgv(
  cwd: string,
  argv: readonly string[],
): string {
  const i = argv.indexOf("--root");
  if (i !== -1 && argv[i + 1]) {
    return path.resolve(argv[i + 1] ?? cwd);
  }
  return cwd;
}

/**
 * 提取子命令之后的位置参数。
 *
 * 跳过：
 * - `--root <value>` 对（会被吃掉 value）
 * - 任何以 `--` 开头的 flag（如 `--recursive`）
 *
 * 使用场景：
 * ```
 * paw fs read --root /proj --recursive some/file.txt another.txt
 * // tailPositionalArgs(argv, "read") → ["some/file.txt", "another.txt"]
 * ```
 *
 * @param argv - 命令行参数数组
 * @param subcommand - 目标子命令名（如 "read"、"list"）
 * @returns 位置参数数组
 */
export function tailPositionalArgs(
  argv: readonly string[],
  subcommand: string,
): string[] {
  const i = argv.indexOf(subcommand);
  if (i === -1) {
    return [];
  }
  const rest = argv.slice(i + 1);
  const out: string[] = [];
  for (let j = 0; j < rest.length; j++) {
    const a = rest[j];
    if (!a) {
      continue;
    }
    // 遇到 --root 时跳过其后的值参数
    if (a === "--root") {
      j++;
      continue;
    }
    // 跳过其他 flag 参数
    if (a === "--recursive" || a.startsWith("--")) {
      continue;
    }
    out.push(a);
  }
  return out;
}
