/**
 * 集中式工作空间路径助手。
 * Centralized workspace path helpers.
 *
 * ============================================================================
 * 模块职责 (Module Purpose)
 * ============================================================================
 * 本模块是所有 `.paw` 磁盘布局决策的"单一事实来源"（Single Source of Truth）。
 *
 * 为什么需要这个模块？
 * 系统中有多个子系统需要在磁盘上创建和管理目录：自动记忆（auto-memory）、
 * 会话记忆（session-memory）、检查点（checkpoints）、会话（sessions）、
 * 工具结果（tool-results）等。如果没有统一的路径管理，各子系统会各自为政地
 * 拼接路径，导致：
 *   - 路径不一致（如有人用 `.paw/memory`，有人用 `.paw/memories`）
 *   - 路径修改需要在多处同步
 *   - 安全漏洞（如路径遍历）的风险增加
 *
 * 磁盘布局总览：
 *   ~/.paw/projects/{project_hash}/memory          — 长期记忆
 *   ~/.paw/projects/{project_hash}/session-memory   — 会话记忆
 *   {workspace}/.paw/sessions/                      — 会话记录
 *   {workspace}/.paw/sessions/{runId}/tool-results/ — 工具结果持久化
 *   {workspace}/.paw/checkpoints/{runId}/           — 检查点
 *
 * 设计决策：
 * - **项目散列**：使用 SHA256 散列 workspace 路径的前 16 位十六进制字符
 *   作为项目标识，避免路径中直接出现特殊字符或过长的目录名。
 * - **用户目录 vs 项目目录**：长期记忆存储在用户目录（~/.paw），因为它们是
 *   跨会话持久的；会话相关的数据存储在项目目录（.paw），因为它们与具体
 *   工作空间绑定。
 * - **安全函数**：sanitizeRunId 和 sanitizeFileName 确保用户提供的标识符
 *   不会导致路径遍历或文件系统错误。
 *
 * 架构定位：基础设施层（Infrastructure），被所有需要磁盘 IO 的模块依赖。
 * ============================================================================
 */

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

/**
 * 计算工作空间路径的 SHA256 散列值（取前 16 位十六进制字符）。
 * 用于生成稳定的短标识符，避免在目录名中使用原始路径。
 *
 * @param workspaceRoot - 工作空间根目录的绝对路径
 * @returns 16 位十六进制散列字符串
 */
export function projectHash(workspaceRoot: string): string {
  return createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 16);
}

/**
 * Paw 项目数据的根目录：`~/.paw/projects`
 * 存储所有项目的跨会话持久数据（如长期记忆）。
 */
export function pawProjectsDir(): string {
  return path.join(homedir(), ".paw", "projects");
}

/**
 * 指定项目的根数据目录：`~/.paw/projects/{projectHash}`
 */
export function projectBaseDir(workspaceRoot: string): string {
  return path.join(pawProjectsDir(), projectHash(workspaceRoot));
}

/**
 * 项目长期记忆目录：`~/.paw/projects/{projectHash}/memory`
 * 存储跨会话保留的参考记忆（reference memories）。
 */
export function memoryDir(workspaceRoot: string): string {
  return path.join(projectBaseDir(workspaceRoot), "memory");
}

/**
 * 项目会话记忆目录：`~/.paw/projects/{projectHash}/session-memory`
 * 存储当前会话的临时记忆。
 */
export function sessionMemoryDir(workspaceRoot: string): string {
  return path.join(projectBaseDir(workspaceRoot), "session-memory");
}

/**
 * 检查点目录：`{workspace}/.paw/checkpoints/{sanitizedRunId}`
 * 存储 agent 运行过程中的状态快照。
 */
export function checkpointsDir(workspaceRoot: string, runId: string): string {
  return path.join(workspaceRoot, ".paw", "checkpoints", sanitizeRunId(runId));
}

/**
 * 会话记录目录：`{workspace}/.paw/sessions`
 * 存储每次 agent 运行的会话记录。
 */
export function sessionsDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".paw", "sessions");
}

/**
 * 工具结果持久化目录：`{workspace}/.paw/sessions/{sanitizedRunId}/tool-results`
 * 存储因过大或上下文驱逐而持久化到磁盘的工具输出结果。
 */
export function toolResultsDir(workspaceRoot: string, runId: string): string {
  return path.join(
    sessionsDir(workspaceRoot),
    sanitizeRunId(runId),
    "tool-results",
  );
}

/**
 * 将 run ID 清理为安全的文件/目录名。
 * 替换所有非字母、数字、点号、下划线、连字符的字符为下划线。
 *
 * 防止路径遍历攻击和文件系统兼容性问题。
 *
 * Make a run id safe to use as a file/directory name.
 */
export function sanitizeRunId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/**
 * 将路径分隔符替换为下划线，使相对路径可作为扁平文件名使用。
 *
 * 例如：`src/utils/helpers.ts` → `src_utils_helpers.ts`
 *
 * Replace path separators so a relative path can be used as a flat filename.
 */
export function sanitizeFileName(rel: string): string {
  return rel.replace(/[/\\]/g, "_");
}
