/**
 * 检查点与回滚系统 —— 为工作区文件修改提供撤销能力。
 *
 * ## 模块职责
 *
 * AI Agent 在执行文件修改操作（写入、编辑、打补丁、Notebook 编辑）时，
 * 可能会产生用户不满意的结果。本模块在执行任何可能修改文件的工具调用前
 * 自动保存文件快照，并在用户触发 `/undo` 命令时恢复到上一个检查点。
 *
 * ## 架构设计
 *
 * 检查点存储结构：
 * ```
 * <workspaceRoot>/.paw/checkpoints/<runId>/<seq>/
 *   ├── _meta.json                         # 检查点元数据（工具名称、目标文件、时间戳）
 *   ├── <hash>-<sanitized_filename>        # 文件内容的快照副本（hash 为内容 SHA256 前16位）
 *   └── .create-<sanitized_filename>       # 标记文件：空文件表示该文件在检查点时不存在，
 *                                          #   因此撤销时应删除该文件
 * ```
 *
 * ## 关键设计决策
 *
 * - **基于序列号的线性检查点**：每个检查点有递增的 seq 编号。恢复到某个检查点时，
 *   会删除该检查点及所有比它更新的检查点（因为后续操作基于已撤销的状态，不再有效）。
 * - **内容哈希命名**：快照文件以内容 SHA256 前缀命名，天然去重 —— 如果两个检查点
 *   的快照内容相同，它们共享同一个快照文件。
 * - **shell 命令特殊处理**：`workspace.run_shell` 的目标文件无法预测，使用虚拟目标
 *   `__shell_cmd__` 记录命令元数据用于审计和恢复参考。
 * - **路径安全**：快照前检查目标路径是否在 workspaceRoot 内，防止路径穿越攻击导致
 *   读取或恢复工作区外的文件。
 * - **可选备份**：restoreCheckpoint 支持在删除检查点前先备份到 `.backup/` 目录。
 */

import fs from "node:fs";
import path from "node:path";
import { checkpointsDir, sanitizeFileName } from "./workspace-paths.js";

/** 单个检查点条目：记录一次工具调用的快照信息 */
export interface CheckpointEntry {
  /** 检查点序列号（递增） */
  readonly seq: number;
  /** 触发此检查点的工具名称 */
  readonly tool: string;
  /** 被快照的目标文件路径列表（相对于工作区根目录） */
  readonly targets: readonly string[];
  /** 快照保存时间戳（毫秒） */
  readonly savedAt: number;
}

/** 一次运行的检查点集合（一个 seq 对应一个 CheckpointEntry） */
export interface Checkpoint {
  readonly runId: string;
  readonly seq: number;
  readonly entries: readonly CheckpointEntry[];
  readonly savedAt: number;
}

/**
 * 从工具调用参数中提取目标文件路径。
 *
 * 不同工具的参数结构不同，这里根据工具类型做分别处理：
 * - write_file / edit_file / notebook_edit：直接读取 `path` 字段
 * - apply_patch：从 unified diff 的 `+++ b/filename` 行中解析文件列表
 * - run_shell：无法预测，返回虚拟目标 `__shell_cmd__`
 */
export function extractCheckpointTargets(
  tool: string,
  args: unknown,
): string[] {
  const rec =
    args && typeof args === "object" && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : {};
  switch (tool) {
    case "workspace.write_file":
    case "workspace.edit_file":
    case "workspace.notebook_edit": {
      const p = typeof rec.path === "string" ? rec.path : "";
      return p ? [p] : [];
    }
    case "workspace.apply_patch": {
      const patchText = typeof rec.patch === "string" ? rec.patch : "";
      // 从 unified diff 头部提取文件路径（格式：--- a/xxx, +++ b/xxx）
      const paths: string[] = [];
      for (const line of patchText.split(/\r?\n/)) {
        const m = line.match(/^\+\+\+\s+(?:b\/)?(.*)/);
        if (m?.[1] && m[1] !== "/dev/null") {
          paths.push(m[1]);
        }
      }
      return paths;
    }
    case "workspace.run_shell": {
      // Shell 命令可能修改任意文件，无法预测目标文件。
      // 返回虚拟目标，检查点会存储命令元数据（命令、工作目录、时间戳）供审计/恢复参考。
      return ["__shell_cmd__"];
    }
    default:
      return [];
  }
}

import { createHash } from "node:crypto";

/**
 * 在执行可变文件操作的工具之前保存检查点。
 *
 * ## 快照策略
 * - **已存在的文件**：复制文件内容到快照目录，文件名以内容哈希为前缀
 * - **不存在的文件**：创建 `.create-` 标记文件，撤销时删除目标文件
 * - **虚拟目标**（`__shell_cmd__`）：保存 shell 元数据 JSON 文件
 *
 * ## 安全性
 * - 只快照 workspaceRoot 内的文件，防止路径穿越
 */
export function saveCheckpoint(
  workspaceRoot: string,
  runId: string,
  seq: number,
  tool: string,
  args: unknown,
): CheckpointEntry {
  const targets = extractCheckpointTargets(tool, args);
  const checkpointDir = path.join(
    checkpointsDir(workspaceRoot, runId),
    String(seq),
  );
  fs.mkdirSync(checkpointDir, { recursive: true });

  const savedTargets: string[] = [];
  for (const rel of targets) {
    if (rel === "__shell_cmd__") {
      // 虚拟目标：保存 shell 命令元数据而非文件快照
      const shellMeta = {
        tool,
        args,
        savedAt: Date.now(),
      };
      fs.writeFileSync(
        path.join(checkpointDir, ".shell-meta.json"),
        JSON.stringify(shellMeta, null, 2),
        "utf8",
      );
      savedTargets.push(rel);
      continue;
    }

    const full = path.join(workspaceRoot, rel);
    // 跳过试图逃逸工作区之外的路径
    if (!full.startsWith(path.resolve(workspaceRoot))) continue;

    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      const content = fs.readFileSync(full);
      const hash = hashBytes(content);
      // 快照文件命名：<hash>-<sanitized_filename>
      // hash 前缀天然去重 —— 内容相同的文件共享快照
      const snapshotFile = path.join(
        checkpointDir,
        `${hash}-${sanitizeFileName(rel)}`,
      );
      fs.writeFileSync(snapshotFile, content);
      savedTargets.push(rel);
    } else {
      // 文件尚不存在 —— 记录为"将被创建"，撤销时需要删除它
      const marker = path.join(
        checkpointDir,
        `.create-${sanitizeFileName(rel)}`,
      );
      fs.writeFileSync(marker, "", "utf8");
      savedTargets.push(rel);
    }
  }

  const meta: CheckpointEntry = {
    seq,
    tool,
    targets: savedTargets,
    savedAt: Date.now(),
  };
  fs.writeFileSync(
    path.join(checkpointDir, "_meta.json"),
    JSON.stringify(meta, null, 2),
    "utf8",
  );
  return meta;
}

/**
 * 内部函数：对单个检查点目录执行恢复操作。
 *
 * 恢复逻辑：
 * - 如果存在 `.create-` 标记文件（表示该文件是工具调用创建的），删除目标文件
 * - 如果存在快照文件，将其复制回原始位置
 * - 虚拟目标 `__shell_cmd__` 不执行任何文件操作
 */
function applyCheckpointRestore(
  checkpointDir: string,
  workspaceRoot: string,
): CheckpointEntry | null {
  const metaPath = path.join(checkpointDir, "_meta.json");
  if (!fs.existsSync(metaPath)) return null;

  const meta: CheckpointEntry = JSON.parse(
    fs.readFileSync(metaPath, "utf8"),
  ) as CheckpointEntry;

  for (const rel of meta.targets) {
    if (rel === "__shell_cmd__") continue; // 虚拟目标 —— 不执行文件操作

    const full = path.join(workspaceRoot, rel);
    if (!full.startsWith(path.resolve(workspaceRoot))) continue;

    const createMarker = path.join(
      checkpointDir,
      `.create-${sanitizeFileName(rel)}`,
    );
    if (fs.existsSync(createMarker)) {
      // 文件是由工具调用创建的 → 撤销时删除它
      try {
        fs.unlinkSync(full);
      } catch {
        // 文件可能已被删除，忽略错误
      }
      continue;
    }

    // 查找快照文件：文件名以 sanitized 路径结尾
    const prefix = sanitizeFileName(rel);
    const snapshotFiles = fs
      .readdirSync(checkpointDir)
      .filter((n) => n.endsWith(`-${prefix}`));
    if (snapshotFiles.length > 0) {
      const snapshotFile = path.join(checkpointDir, snapshotFiles[0]!);
      fs.copyFileSync(snapshotFile, full);
    }
  }

  return meta;
}

/**
 * 撤销最近一次工具调用的更改。恢复最近一个检查点并删除该检查点目录。
 *
 * @returns 被恢复的检查点元数据，如果没有检查点可恢复则返回 null
 */
export function undoLastCheckpoint(
  workspaceRoot: string,
  runId: string,
): CheckpointEntry | null {
  const runCheckpointsDir = checkpointsDir(workspaceRoot, runId);
  if (!fs.existsSync(runCheckpointsDir)) return null;

  // 按 seq 降序排列，找到最新的检查点
  const dirs = fs
    .readdirSync(runCheckpointsDir)
    .filter((n) => /^\d+$/.test(n))
    .map((n) => ({ name: n, seq: Number.parseInt(n, 10) }))
    .sort((a, b) => b.seq - a.seq);

  for (const d of dirs) {
    const checkpointDir = path.join(runCheckpointsDir, d.name);
    const meta = applyCheckpointRestore(checkpointDir, workspaceRoot);
    if (meta) {
      // 恢复成功后删除该检查点目录
      fs.rmSync(checkpointDir, { recursive: true, force: true });
      return meta;
    }
  }
  return null;
}

/**
 * 恢复到指定的检查点（按序列号）。
 *
 * ## 行为
 * 1. 恢复目标检查点的文件快照
 * 2. 删除目标检查点及所有序列号 >= 目标 seq 的后续检查点
 *    （因为后续操作基于已撤销的状态，不再有效）
 * 3. 可选地将被删除的检查点备份到 `.backup/<timestamp>/` 目录
 *
 * @param seq - 要恢复到的检查点序列号
 * @param opts.backup - 是否在删除前备份检查点
 */
export function restoreCheckpoint(
  workspaceRoot: string,
  runId: string,
  seq: number,
  opts?: { backup?: boolean },
): CheckpointEntry | null {
  const runCheckpointsDir = checkpointsDir(workspaceRoot, runId);
  if (!fs.existsSync(runCheckpointsDir)) return null;

  const targetDir = path.join(runCheckpointsDir, String(seq));
  if (!fs.existsSync(targetDir)) return null;

  const meta = applyCheckpointRestore(targetDir, workspaceRoot);
  if (!meta) return null;

  // 删除目标检查点及所有比它更新的检查点
  const dirs = fs
    .readdirSync(runCheckpointsDir)
    .filter((n) => /^\d+$/.test(n))
    .map((n) => Number.parseInt(n, 10))
    .filter((n) => n >= seq);

  if (opts?.backup) {
    // 最佳尽力备份：将待删除的检查点复制到 .backup 目录
    const backupDir = path.join(runCheckpointsDir, ".backup", String(Date.now()));
    fs.mkdirSync(backupDir, { recursive: true });
    for (const s of dirs) {
      const src = path.join(runCheckpointsDir, String(s));
      const dst = path.join(backupDir, String(s));
      try {
        fs.cpSync(src, dst, { recursive: true });
      } catch {
        // 备份失败不影响主流程
      }
    }
  }

  for (const s of dirs) {
    const dir = path.join(runCheckpointsDir, String(s));
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // 删除失败不阻塞后续操作
    }
  }

  return meta;
}

/**
 * 列出一次运行的所有检查点，按序列号降序排列（最新的排在最前）。
 */
export function listCheckpoints(
  workspaceRoot: string,
  runId: string,
): CheckpointEntry[] {
  const runCheckpointsDir = checkpointsDir(workspaceRoot, runId);
  if (!fs.existsSync(runCheckpointsDir)) return [];

  const out: CheckpointEntry[] = [];
  for (const name of fs.readdirSync(runCheckpointsDir)) {
    if (!/^\d+$/.test(name)) continue;
    const metaPath = path.join(runCheckpointsDir, name, "_meta.json");
    if (!fs.existsSync(metaPath)) continue;
    try {
      const meta = JSON.parse(
        fs.readFileSync(metaPath, "utf8"),
      ) as CheckpointEntry;
      out.push(meta);
    } catch {
      // 跳过损坏的元数据文件
    }
  }
  return out.sort((a, b) => b.seq - a.seq);
}

/** 计算文件内容的 SHA256 哈希值并取前 16 个十六进制字符作为文件名前缀 */
function hashBytes(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex").slice(0, 16);
}

/**
 * 判断给定的工具名称是否属于可能修改工作区文件的工具。
 * 这些工具在执行前需要保存检查点。
 */
export function isMutatingTool(tool: string): boolean {
  return (
    tool === "workspace.write_file" ||
    tool === "workspace.edit_file" ||
    tool === "workspace.apply_patch" ||
    tool === "workspace.notebook_edit" ||
    tool === "workspace.run_shell"
  );
}
