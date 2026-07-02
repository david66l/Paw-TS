/**
 * find-root — 项目根目录发现模块
 *
 * 【模块职责】
 * 从任意子目录向上遍历，找到包含 `.paw/` 配置目录的最近父目录，即 paw-ts
 * 项目的根目录。
 *
 * 【为什么需要这个模块】
 * paw-ts 是一个 CLI 工具，用户可以在项目树的任意深度执行命令。所有模块需要
 * 一个统一的方式定位项目根目录（.paw/ 所在位置），以便正确读写配置文件、
 * memory 目录、skills 目录等。
 *
 * 【设计决策】
 * - 使用 `.paw/` 目录作为根标记（类似 .git/ 之于 Git）：简单、稳定、无歧义
 * - 硬上限 64 层遍历：防止在异常文件系统结构下无限循环（如循环符号链接）
 * - 返回 null 而非抛异常：调用方自行决定"找不到根"是错误还是合法状态
 * - 同步 fs API：初始化阶段使用，不需要异步——简化调用方代码
 * - 跨平台兼容：使用 path.resolve/dirname 而非字符串拼接，正确处理 Windows 路径
 */

import fs from "node:fs";
import path from "node:path";

/**
 * 从 startDir 向上遍历目录树，查找包含 .paw/ 的最近祖先目录
 *
 * @param startDir - 起始搜索目录（可以是相对路径）
 * @returns 包含 .paw/ 的目录路径，若未找到则返回 null
 *
 * Walk up from `startDir` to find the nearest directory containing `.paw/`.
 */
export function findPawRoot(startDir: string): string | null {
  // 将起始路径解析为绝对路径，确保后续 dirname 遍历可靠
  let dir = path.resolve(startDir);

  // 最多向上遍历 64 层，防止循环符号链接等异常情况导致无限循环
  for (let i = 0; i < 64; i++) {
    // 检查当前目录是否包含 .paw/ 标记
    if (fs.existsSync(path.join(dir, ".paw"))) {
      return dir;
    }

    // 向上一级
    const parent = path.dirname(dir);

    // 到达文件系统根目录（parent === dir 说明已到 / 或盘符根）
    if (parent === dir) break;

    dir = parent;
  }

  // 遍历 64 层仍未找到或已到根目录，返回 null 表示"不在 paw 项目中"
  return null;
}
