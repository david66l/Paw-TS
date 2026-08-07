/**
 * P2.7/AC-P2-15 行为闭环：压缩后重复获取检测（SWE-MeM 独有信号）。
 * =================================================================
 *
 * 压缩后继续跑若干步，观测模型是否重复获取"已保留的信息"——
 * 重复 view 同一文件 / 重复跑同一测试命令 = 摘要丢失了引用锚点
 * （模型在摘要里找不到它需要的文件/命令，只能重新获取）。
 *
 * 检出后：标记该次压缩质量为低（事件 + 状态），供回滚决策
 * （回滚用 P4.4 的 compaction commit 快照，本模块只负责检测与标记）。
 */

export interface DuplicateAccess {
  readonly kind: "file" | "command";
  readonly value: string;
}

export interface CompactionQualityResult {
  readonly duplicates: readonly DuplicateAccess[];
  readonly quality: "ok" | "low";
}

/**
 * 检测压缩后的重复获取。
 *
 * @param filesReadAtCompact 压缩发生时已读过的文件（taskState 快照）
 * @param commandsAtCompact  压缩发生时已跑过的命令（taskState 快照）
 * @param newFilesRead       压缩后新读的文件（增量）
 * @param newCommands        压缩后新跑的命令（增量）
 */
export function detectDuplicateAccess(opts: {
  readonly filesReadAtCompact: readonly string[];
  readonly commandsAtCompact: readonly string[];
  readonly newFilesRead: readonly string[];
  readonly newCommands: readonly string[];
}): CompactionQualityResult {
  const duplicates: DuplicateAccess[] = [];
  const files = new Set(opts.filesReadAtCompact);
  const commands = new Set(opts.commandsAtCompact);
  const seen = new Set<string>();
  for (const f of opts.newFilesRead) {
    const key = `file:${f}`;
    if (files.has(f) && !seen.has(key)) {
      seen.add(key);
      duplicates.push({ kind: "file", value: f });
    }
  }
  for (const c of opts.newCommands) {
    const key = `cmd:${c}`;
    if (commands.has(c) && !seen.has(key)) {
      seen.add(key);
      duplicates.push({ kind: "command", value: c });
    }
  }
  return {
    duplicates,
    quality: duplicates.length > 0 ? "low" : "ok",
  };
}
