/**
 * 系统提示词章节：持久记忆（Postgres MemoryRuntime）
 *
 * Cutover 后在线路径只有 Runtime：
 * - 相关记忆由 ContextBuilder 注入（title/summary，非整篇）
 * - 读写用 memory.list / memory.read / memory.save（save 经治理）
 * - 禁止用 workspace.write_file 写 ~/.paw/.../memory 或 MEMORY.md
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
    "- Full bodies live in the store — do **not** expect long memory essays in the system prompt.",
    "- Use tools: `memory.list`, `memory.read`, `memory.save` (save goes through governance).",
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
    "- Never write memory with `workspace.write_file` / shell into a memory directory.",
    "- Never maintain a MEMORY.md index by hand.",
    "- Memory can be stale: verify paths/symbols with list/read/grep before acting on them.",
    "- If the user says to ignore memory, do not cite or apply recalled facts.",
  ].join("\n");
}
