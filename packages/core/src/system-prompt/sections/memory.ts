/**
 * 系统提示词章节：持久记忆（Postgres MemoryRuntime）
 *
 * Cutover 后在线路径只有 Runtime：
 * - 相关记忆由 ContextBuilder 注入（title/summary，非整篇）
 * - 完整记忆由宿主按需检索，写入由治理路径管理
 * - 禁止模型绕过宿主直接维护记忆文件
 */

/**
 * 生成记忆系统章节（短指令，替代旧 file-based auto-memory 长文）
 *
 * @param opts.hasAutoMemory - false 时不生成章节
 * @returns 记忆章节文本，或 null
 */
export function getMemorySection(opts: {
  /** @deprecated 旧 file 路径；Runtime 模式下不展示，仅保留参数兼容 */
  memoryDir?: string;
  hasAutoMemory: boolean;
  /** @deprecated 旧 MEMORY.md 索引注入；Runtime 用 ContextBuilder 段 */
  memoryIndex?: string;
  maxMemoryIndexLines?: number;
}): string | null {
  if (!opts.hasAutoMemory) return null;

  return [
    "# Memory",
    "",
    "Persistent memory is database-backed (MemoryRuntime), not a markdown folder.",
    "",
    "## How it works",
    "- Relevant memories for this task may already appear below under Environment as short summaries (id/title/score).",
    "- Full bodies live in the store; the host retrieves and governs them outside the model tool surface.",
    "",
    "## What to save",
    "- User preferences, durable feedback, project decisions not derivable from code/git.",
    "- External pointers (Linear project, dashboard URL) when they will matter later.",
    "",
    "## What NOT to save",
    "- Code patterns, file trees, git history (re-read the repo).",
    "- Ephemeral task chatter or one-off debug dumps.",
    "",
    "## Rules",
    "- Never write memory with workspace file-editing tools or shell commands into a memory directory.",
    "- Never maintain a MEMORY.md index by hand.",
    "- Memory can be stale: verify paths and symbols with the workspace tools available in this run.",
    "- If the user says to ignore memory, do not cite or apply recalled facts.",
  ].join("\n");
}
