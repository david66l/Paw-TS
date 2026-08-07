/**
 * P4.4 压缩版本化（ChronoMem 第一步）。
 * =======================================
 *
 * 每次 L2 压缩 = 一次 commit：压缩前消息快照 + 元数据落盘，
 * 恢复 = 取回快照（HEAD 作用域：回滚后上下文回到压缩前状态）。
 *
 * 范围声明：只管上下文/记忆状态，不管已落盘文件副作用（回滚不撤销文件写入）。
 * 语义回滚（BM25+dense+RRF+rerank）二期，UI 保留显式版本选择。
 *
 * 存储布局：
 *   {workspace}/.paw/sessions/{runId}/compaction-commits/{n}.json
 */

import fs from "node:fs";
import path from "node:path";
import type { ChatMessage } from "./manager.js";
import { atomicWrite } from "../utils/fs.js";
import { sanitizeRunId } from "../workspace-paths.js";

export interface CompactionCommit {
  /** 提交序号（1-based，单调递增） */
  readonly n: number;
  /** 创建时间戳 */
  readonly ts: number;
  /** 触发原因（auto_compact / resume / manual） */
  readonly reason: string;
  /** 压缩前的完整历史（system 外） */
  readonly beforeMessages: readonly ChatMessage[];
  /** 压缩后的完整历史（system 外） */
  readonly afterMessages: readonly ChatMessage[];
  /** 摘要文本（若产生） */
  readonly summary?: string;
  /** 压缩前 token 数 */
  readonly beforeTokens: number;
  /** 压缩后 token 数 */
  readonly afterTokens: number;
}

export function compactionCommitsDir(
  workspaceRoot: string,
  runId: string,
): string {
  return path.join(
    workspaceRoot,
    ".paw",
    "sessions",
    sanitizeRunId(runId),
    "compaction-commits",
  );
}

/** 保存一次压缩 commit；返回快照文件路径 */
export function saveCompactionCommit(opts: {
  readonly workspaceRoot: string;
  readonly runId: string;
  readonly commit: CompactionCommit;
}): string {
  const dir = compactionCommitsDir(opts.workspaceRoot, opts.runId);
  fs.mkdirSync(dir, { recursive: true });
  const filepath = path.join(dir, `${opts.commit.n}.json`);
  atomicWrite(
    filepath,
    JSON.stringify(opts.commit, null, 2),
  );
  return filepath;
}

/** 列出全部压缩 commit（按序号升序） */
export function listCompactionCommits(
  workspaceRoot: string,
  runId: string,
): readonly CompactionCommit[] {
  const dir = compactionCommitsDir(workspaceRoot, runId);
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const commits = files
    .filter((f) => /^\d+\.json$/.test(f))
    .map((f) => {
      try {
        const raw = fs.readFileSync(path.join(dir, f), "utf8");
        return JSON.parse(raw) as CompactionCommit;
      } catch {
        return null;
      }
    })
    .filter((c): c is CompactionCommit => c !== null)
    .sort((a, b) => a.n - b.n);
  return commits;
}

/** 取回第 n 次压缩的压缩前快照（回滚点）；不存在返回 null */
export function loadCompactionSnapshot(
  workspaceRoot: string,
  runId: string,
  n: number,
): CompactionCommit | null {
  const commit = listCompactionCommits(workspaceRoot, runId).find(
    (c) => c.n === n,
  );
  return commit ?? null;
}

/** 取回最近一次压缩的压缩前快照（默认回滚点）；无 commit 返回 null */
export function loadLatestCompactionSnapshot(
  workspaceRoot: string,
  runId: string,
): CompactionCommit | null {
  const commits = listCompactionCommits(workspaceRoot, runId);
  if (commits.length === 0) return null;
  return commits[commits.length - 1]!;
}
