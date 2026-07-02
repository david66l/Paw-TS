/**
 * paw-md.ts — paw.md 项目指令文件加载器
 *
 * 【是什么】
 * 从工作区根目录加载 paw.md（或 .paw/paw.md）文件。
 * 该文件包含项目专属的指令和上下文信息，供 AI Agent 在进入项目时读取。
 *
 * 【为什么需要】
 * 类似于 CLAUDE.md / AGENTS.md / Cursor Rules，paw.md 是 Paw 生态中
 * 项目级别的 Agent 指令文件。开发者可以在其中定义项目约定、代码风格、
 * 常用命令、架构说明等内容。Agent 启动时加载此文件，即可获得项目上下文，
 * 无需每个会话都手动提供背景信息。
 *
 * 【关键设计决策】
 * 1. 两个候选路径：优先查找工作区根目录的 paw.md，其次查找 .paw/paw.md。
 *    这样支持两种组织方式——简单项目放在根目录，复杂项目放在 .paw 子目录。
 * 2. 静默失败：文件不存在时不报错，返回空对象。因为 paw.md 不是必需的。
 * 3. 简单实现：不需要复杂的 glob 或递归查找，只检查两个固定路径。
 * 4. 返回相对路径：path 字段是相对于工作区根目录的路径，便于 Agent 引用。
 */

import fs from "node:fs";
import path from "node:path";

/** paw.md 加载结果 */
export interface PawMdResult {
  /** 文件内容（如果找到） */
  readonly content?: string;
  /** 文件相对于工作区的路径（如果找到） */
  readonly path?: string;
}

/**
 * 在工作区根目录或 .paw/ 子目录中搜索 paw.md。
 * 返回文件内容和相对路径（如果找到），否则返回空对象。
 *
 * @param workspaceRoot 工作区根目录的绝对路径
 * @returns 包含 content 和 path 的结果，或空对象（未找到时）
 */
export function loadPawMd(workspaceRoot: string): PawMdResult {
  // 两个候选路径，按优先级排列
  const candidates = [
    path.join(workspaceRoot, "paw.md"),
    path.join(workspaceRoot, ".paw", "paw.md"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p) && fs.statSync(p).isFile()) {
      try {
        const content = fs.readFileSync(p, "utf8");
        return { content, path: path.relative(workspaceRoot, p) };
      } catch {
        // 读取错误时静默忽略，尝试下一个候选
      }
    }
  }
  return {};
}
