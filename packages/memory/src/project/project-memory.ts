/**
 * 项目记忆模块 — 加载项目级别的规则、约定和偏好配置。
 *
 * ## 模块定位
 *
 * 每个项目可以定义自己的规则文件，描述项目特定的编码规范、架构约定、工具偏好等。
 * 这些内容会在每次会话启动时注入到系统提示词中，确保 AI 的行为与项目预期一致。
 * 本模块是项目上下文注入机制的入口。
 *
 * ## 架构设计
 *
 * - **Committed（共享）**: `.paw/CLAUDE.md` — 纳入版本控制的共享规则，
 *   团队成员共同维护，所有人拉取后生效
 * - **Local（本地）**: `.paw/CLAUDE.local.md` — 不纳入版本控制的本地规则，
 *   通常已加入 `.gitignore`，用于个人偏好覆盖和本地敏感配置
 * - **加载策略**: 两个文件独立加载，互不影响。都为空时返回 `{ committed: null, local: null }`
 * - **错误处理**: 文件读取失败时静默返回 null，不中断会话启动流程
 *
 * ## 关键设计决策
 *
 * 1. **双文件分离**: 共享规则和本地规则分开，支持团队协作和个人定制共存，
 *    避免强制性的统一规则与个人工作流偏好冲突
 * 2. **Markdown 格式**: 与 Claude 的提示词格式一致，可以包含任意 Markdown 内容
 *    （规则列表、代码示例、结构化指令等）
 * 3. **惰性加载**: 每次需要时重新读取文件，确保规则变更实时生效，
 *    无需重启或清理缓存
 * 4. **静默失败**: 文件不存在或读取异常时不抛错，因为项目记忆是辅助性的，
 *    不应阻塞会话启动
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * 项目记忆数据结构。
 *
 * 包含两个独立的规则文件内容：共享规则（committed）和本地规则（local）。
 * 任一文件不存在时对应字段为 null。
 */
export interface ProjectMemory {
  /** `.paw/CLAUDE.md` 的内容（纳入版本控制，团队共享） */
  readonly committed: string | null;
  /** `.paw/CLAUDE.local.md` 的内容（不纳入版本控制，本地个人配置） */
  readonly local: string | null;
}

/**
 * 从工作区根目录加载项目记忆文件。
 *
 * 并行加载 `.paw/CLAUDE.md` 和 `.paw/CLAUDE.local.md`，读取失败时对应字段为 null。
 * 这是项目记忆的唯一入口函数，上层调用者不需要关心文件路径和读取细节。
 *
 * @param workspaceRoot - 工作区根目录的绝对路径
 * @returns 包含共享规则和本地规则内容的 ProjectMemory 对象
 */
export function loadProjectMemory(workspaceRoot: string): ProjectMemory {
  const committedPath = path.join(workspaceRoot, ".paw", "CLAUDE.md");
  const localPath = path.join(workspaceRoot, ".paw", "CLAUDE.local.md");

  return {
    committed: readIfExists(committedPath),
    local: readIfExists(localPath),
  };
}

/**
 * 安全读取文件内容的辅助函数。
 *
 * 文件不存在或读取异常时返回 null，不抛异常。
 * 这是有意为之的设计选择：项目记忆是增强性的，不应因文件问题阻断会话。
 *
 * @param filePath - 文件绝对路径
 * @returns 文件内容字符串，或 null（文件不存在/读取失败）
 */
function readIfExists(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  try {
    return readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}
