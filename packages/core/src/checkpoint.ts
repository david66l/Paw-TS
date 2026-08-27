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
import { atomicWrite } from "./utils/fs.js";
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
  /** Post-execution state used by the model-facing compare-and-swap undo. */
  readonly outcome?: CheckpointOutcomeV1;
}

export interface CheckpointTargetStateV1 {
  readonly path: string;
  readonly state: "file" | "missing";
  readonly sha256?: string;
}

export interface CheckpointOutcomeV1 {
  readonly schemaVersion: "paw.checkpoint-outcome.v1";
  readonly toolSucceeded: boolean;
  readonly materiallyChanged: boolean;
  readonly after: readonly CheckpointTargetStateV1[];
}

export type SafeFileMutationCheckpointInspection =
  | { readonly status: "ready"; readonly entry: CheckpointEntry }
  | {
      readonly status: "conflict";
      readonly entry: CheckpointEntry;
      readonly conflictingPaths: readonly string[];
    }
  | { readonly status: "invalid"; readonly reason: string }
  | { readonly status: "none" };

function resolveCheckpointTarget(
  workspaceRoot: string,
  rel: string,
): string | undefined {
  if (!rel || rel === "__shell_cmd__") return undefined;
  const root = path.resolve(workspaceRoot);
  const full = path.resolve(root, rel);
  const relative = path.relative(root, full);
  if (
    relative.length === 0 ||
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  ) {
    return undefined;
  }
  try {
    const rootReal = fs.realpathSync.native?.(root) ?? fs.realpathSync(root);
    let existing = full;
    while (!fs.existsSync(existing)) {
      const parent = path.dirname(existing);
      if (parent === existing) return undefined;
      existing = parent;
    }
    const existingReal =
      fs.realpathSync.native?.(existing) ?? fs.realpathSync(existing);
    const realRelative = path.relative(rootReal, existingReal);
    if (
      path.isAbsolute(realRelative) ||
      realRelative === ".." ||
      realRelative.startsWith(`..${path.sep}`)
    ) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return full;
}

function isReservedCheckpointTarget(
  workspaceRoot: string,
  rel: string,
): boolean {
  const full = resolveCheckpointTarget(workspaceRoot, rel);
  if (!full) return false;
  const relative = path.relative(path.resolve(workspaceRoot), full);
  const [topLevel] = relative.split(path.sep);
  return topLevel?.toLowerCase() === ".paw";
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
    case "workspace.run_shell":
    case "workspace.job_start": {
      // Shell 命令可能修改任意文件，无法预测目标文件。
      // 返回虚拟目标，检查点会存储命令元数据（命令、工作目录、时间戳）供审计/恢复参考。
      return ["__shell_cmd__"];
    }
    default:
      return [];
  }
}

/** One shared predicate for canonical allocation and physical preparation. */
export function requiresToolCheckpointV1(tool: string): boolean {
  return isMutatingTool(tool) && tool !== "workspace.undo_last_edit";
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
  if (!Number.isSafeInteger(seq) || seq <= 0) {
    throw new TypeError("checkpoint sequence must be a positive safe integer");
  }
  const targets = [...new Set(extractCheckpointTargets(tool, args))];
  const fileTargets = targets.filter((target) => target !== "__shell_cmd__");
  const snapshotKeys = fileTargets.map((target) => sanitizeFileName(target));
  if (new Set(snapshotKeys).size !== snapshotKeys.length) {
    throw new Error("checkpoint targets collide after path sanitization");
  }
  for (const target of fileTargets) {
    if (!resolveCheckpointTarget(workspaceRoot, target)) {
      throw new Error(`checkpoint target escapes workspace: ${target}`);
    }
    if (isReservedCheckpointTarget(workspaceRoot, target)) {
      throw new Error(`checkpoint target is reserved Paw state: ${target}`);
    }
  }
  const runCheckpointsDir = checkpointsDir(workspaceRoot, runId);
  ensureCheckpointParentDirectory(workspaceRoot, runCheckpointsDir);
  const checkpointDir = path.join(runCheckpointsDir, String(seq));
  try {
    // The canonical journal allocates sequence numbers. A pre-existing physical
    // target is therefore a conflict, never evidence that the number may be
    // reused. In particular, do not follow a symlink or merge into a partial
    // directory left by a crashed writer.
    fs.mkdirSync(checkpointDir);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "EEXIST"
    ) {
      throw new Error(`checkpoint sequence target already exists: ${seq}`);
    }
    throw error;
  }
  assertSafeCheckpointDirectory(workspaceRoot, checkpointDir);

  const savedTargets: string[] = [];
  for (const rel of targets) {
    if (rel === "__shell_cmd__") {
      // 虚拟目标：保存 shell 命令元数据而非文件快照
      const shellMeta = {
        tool,
        args,
        savedAt: Date.now(),
      };
      atomicWrite(
        path.join(checkpointDir, ".shell-meta.json"),
        JSON.stringify(shellMeta, null, 2),
      );
      savedTargets.push(rel);
      continue;
    }

    const full = resolveCheckpointTarget(workspaceRoot, rel);
    if (!full) throw new Error(`unsafe checkpoint target: ${rel}`);

    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      const content = fs.readFileSync(full);
      const hash = hashBytes(content);
      // 快照文件命名：<hash>-<sanitized_filename>
      // hash 前缀天然去重 —— 内容相同的文件共享快照
      const snapshotFile = path.join(
        checkpointDir,
        `${hash}-${sanitizeFileName(rel)}`,
      );
      atomicWrite(snapshotFile, content.toString());
      savedTargets.push(rel);
    } else {
      // 文件尚不存在 —— 记录为"将被创建"，撤销时需要删除它
      const marker = path.join(
        checkpointDir,
        `.create-${sanitizeFileName(rel)}`,
      );
      atomicWrite(marker, "");
      savedTargets.push(rel);
    }
  }

  const meta: CheckpointEntry = {
    seq,
    tool,
    targets: savedTargets,
    savedAt: Date.now(),
  };
  atomicWrite(
    path.join(checkpointDir, "_meta.json"),
    JSON.stringify(meta, null, 2),
  );
  return meta;
}

function ensureCheckpointParentDirectory(
  workspaceRoot: string,
  directory: string,
): void {
  const root = path.resolve(workspaceRoot);
  const relative = path.relative(root, path.resolve(directory));
  if (
    !relative ||
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  ) {
    throw new Error("checkpoint storage escapes workspace");
  }

  const rootReal = fs.realpathSync(root);
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      fs.mkdirSync(current);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        (error as NodeJS.ErrnoException).code !== "EEXIST"
      ) {
        throw error;
      }
    }
    assertSafeCheckpointDirectory(rootReal, current);
  }
}

function assertSafeCheckpointDirectory(
  workspaceRoot: string,
  directory: string,
): void {
  const stats = fs.lstatSync(directory);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(
      `checkpoint storage path is not a safe directory: ${directory}`,
    );
  }
  const rootReal = fs.realpathSync(workspaceRoot);
  const directoryReal = fs.realpathSync(directory);
  const relative = path.relative(rootReal, directoryReal);
  if (
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  ) {
    throw new Error("checkpoint storage escapes workspace");
  }
}

function resolveExistingCheckpointDirectory(
  workspaceRoot: string,
  runId: string,
  seq?: number,
): string | undefined {
  const runDir = checkpointsDir(workspaceRoot, runId);
  if (!assertExistingCheckpointDirectory(workspaceRoot, runDir)) {
    return undefined;
  }
  if (seq === undefined) return runDir;
  const checkpointDir = path.join(runDir, String(seq));
  return assertExistingCheckpointDirectory(workspaceRoot, checkpointDir)
    ? checkpointDir
    : undefined;
}

function assertExistingCheckpointDirectory(
  workspaceRoot: string,
  directory: string,
): boolean {
  const root = path.resolve(workspaceRoot);
  const relative = path.relative(root, path.resolve(directory));
  if (
    !relative ||
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  ) {
    throw new Error("checkpoint storage escapes workspace");
  }
  const rootReal = fs.realpathSync(root);
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(current);
    } catch (error) {
      if (isMissingPathError(error)) return false;
      throw error;
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(
        `checkpoint storage path is not a safe directory: ${current}`,
      );
    }
    const currentReal = fs.realpathSync(current);
    const currentRelative = path.relative(rootReal, currentReal);
    if (
      path.isAbsolute(currentRelative) ||
      currentRelative === ".." ||
      currentRelative.startsWith(`..${path.sep}`)
    ) {
      throw new Error("checkpoint storage escapes workspace");
    }
  }
  return true;
}

function checkpointFileExists(
  workspaceRoot: string,
  filePath: string,
): boolean {
  if (
    !assertExistingCheckpointDirectory(workspaceRoot, path.dirname(filePath))
  ) {
    return false;
  }
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(filePath);
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(
      `checkpoint storage file is not a safe regular file: ${filePath}`,
    );
  }
  return true;
}

function readCheckpointDirectoryNames(
  workspaceRoot: string,
  directory: string,
): string[] {
  if (!assertExistingCheckpointDirectory(workspaceRoot, directory)) {
    throw new Error(`checkpoint storage directory is missing: ${directory}`);
  }
  return fs.readdirSync(directory);
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
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
  if (!assertExistingCheckpointDirectory(workspaceRoot, checkpointDir)) {
    return null;
  }
  const metaPath = path.join(checkpointDir, "_meta.json");
  if (!checkpointFileExists(workspaceRoot, metaPath)) return null;

  const meta: CheckpointEntry = JSON.parse(
    fs.readFileSync(metaPath, "utf8"),
  ) as CheckpointEntry;

  const resolvedTargets = new Map<string, string>();
  const snapshotKeys = new Set<string>();
  for (const rel of meta.targets) {
    if (rel === "__shell_cmd__") continue;
    const full = resolveCheckpointTarget(workspaceRoot, rel);
    // Validate every target before restoring any of them. A corrupt mixed
    // checkpoint must never partially restore its first valid path.
    const snapshotKey = sanitizeFileName(rel);
    if (!full || snapshotKeys.has(snapshotKey)) return null;
    snapshotKeys.add(snapshotKey);
    resolvedTargets.set(rel, full);
  }

  for (const rel of meta.targets) {
    if (rel === "__shell_cmd__") continue; // 虚拟目标 —— 不执行文件操作

    const full = resolvedTargets.get(rel);
    if (!full) return null;

    const createMarker = path.join(
      checkpointDir,
      `.create-${sanitizeFileName(rel)}`,
    );
    if (checkpointFileExists(workspaceRoot, createMarker)) {
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
    const snapshotFiles = readCheckpointDirectoryNames(
      workspaceRoot,
      checkpointDir,
    ).filter((n) => n.endsWith(`-${prefix}`));
    const firstSnapshot = snapshotFiles[0];
    if (firstSnapshot) {
      const snapshotFile = path.join(checkpointDir, firstSnapshot);
      if (!checkpointFileExists(workspaceRoot, snapshotFile)) return null;
      fs.copyFileSync(snapshotFile, full);
    }
  }

  return meta;
}

function checkpointTargetState(
  workspaceRoot: string,
  rel: string,
): CheckpointTargetStateV1 | undefined {
  const full = resolveCheckpointTarget(workspaceRoot, rel);
  if (!full) return undefined;
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
    return { path: rel, state: "missing" };
  }
  return {
    path: rel,
    state: "file",
    sha256: createHash("sha256").update(fs.readFileSync(full)).digest("hex"),
  };
}

function checkpointBeforeState(
  workspaceRoot: string,
  checkpointDir: string,
  rel: string,
): CheckpointTargetStateV1 | undefined {
  const sanitized = sanitizeFileName(rel);
  if (
    checkpointFileExists(
      workspaceRoot,
      path.join(checkpointDir, `.create-${sanitized}`),
    )
  ) {
    return { path: rel, state: "missing" };
  }
  const snapshot = readCheckpointDirectoryNames(
    workspaceRoot,
    checkpointDir,
  ).find((name) => name.endsWith(`-${sanitized}`));
  if (!snapshot) return undefined;
  const snapshotPath = path.join(checkpointDir, snapshot);
  if (!checkpointFileExists(workspaceRoot, snapshotPath)) return undefined;
  return {
    path: rel,
    state: "file",
    sha256: createHash("sha256")
      .update(fs.readFileSync(snapshotPath))
      .digest("hex"),
  };
}

function targetStatesEqual(
  left: CheckpointTargetStateV1,
  right: CheckpointTargetStateV1,
): boolean {
  return (
    left.path === right.path &&
    left.state === right.state &&
    (left.state === "missing" || left.sha256 === right.sha256)
  );
}

/**
 * Seal a pre-execution checkpoint with the actual post-tool file state.
 * This turns later model-initiated undo into compare-and-swap: Paw will only
 * restore when the workspace still equals the state produced by that tool.
 */
export function finalizeCheckpoint(
  workspaceRoot: string,
  runId: string,
  seq: number,
  options: { readonly toolSucceeded?: boolean } = {},
): CheckpointEntry | null {
  const checkpointDir = resolveExistingCheckpointDirectory(
    workspaceRoot,
    runId,
    seq,
  );
  if (!checkpointDir) return null;
  const metaPath = path.join(checkpointDir, "_meta.json");
  if (!checkpointFileExists(workspaceRoot, metaPath)) return null;
  const entry = JSON.parse(
    fs.readFileSync(metaPath, "utf8"),
  ) as CheckpointEntry;
  const fileTargets = entry.targets.filter(
    (target) => target !== "__shell_cmd__",
  );
  const snapshotKeys = fileTargets.map((target) => sanitizeFileName(target));
  if (new Set(snapshotKeys).size !== snapshotKeys.length) {
    throw new Error("checkpoint targets collide after path sanitization");
  }
  const after = fileTargets.map((target) => {
    const state = checkpointTargetState(workspaceRoot, target);
    if (!state) throw new Error(`unsafe checkpoint target: ${target}`);
    return state;
  });
  const materiallyChanged = fileTargets.some((target, index) => {
    const before = checkpointBeforeState(workspaceRoot, checkpointDir, target);
    const afterState = after[index];
    if (!afterState) throw new Error(`missing checkpoint state: ${target}`);
    return !before || !targetStatesEqual(before, afterState);
  });
  const finalized: CheckpointEntry = {
    ...entry,
    outcome: {
      schemaVersion: "paw.checkpoint-outcome.v1",
      toolSucceeded: options.toolSucceeded ?? true,
      materiallyChanged,
      after,
    },
  };
  if (!checkpointFileExists(workspaceRoot, metaPath)) {
    throw new Error("checkpoint metadata disappeared before finalization");
  }
  atomicWrite(metaPath, JSON.stringify(finalized, null, 2));
  return finalized;
}

const SAFE_FILE_MUTATION_TOOLS = new Set([
  "workspace.write_file",
  "workspace.edit_file",
  "workspace.apply_patch",
  "workspace.notebook_edit",
]);

function parseSafeCheckpointEntry(
  value: unknown,
  expectedSeq: number,
):
  | { readonly status: "ok"; readonly entry: CheckpointEntry }
  | { readonly status: "invalid"; readonly reason: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      status: "invalid",
      reason: `checkpoint ${expectedSeq} metadata is not an object`,
    };
  }
  const entry = value as Record<string, unknown>;
  if (
    entry.seq !== expectedSeq ||
    typeof entry.tool !== "string" ||
    entry.tool.length === 0 ||
    !Array.isArray(entry.targets) ||
    !entry.targets.every((target) => typeof target === "string") ||
    typeof entry.savedAt !== "number" ||
    !Number.isFinite(entry.savedAt)
  ) {
    return {
      status: "invalid",
      reason: `checkpoint ${expectedSeq} metadata is malformed`,
    };
  }
  return { status: "ok", entry: value as CheckpointEntry };
}

function validateSafeCheckpointOutcome(
  entry: CheckpointEntry,
): string | undefined {
  const outcome = entry.outcome;
  if (!outcome || outcome.schemaVersion !== "paw.checkpoint-outcome.v1") {
    return "missing finalized outcome";
  }
  if (
    typeof outcome.toolSucceeded !== "boolean" ||
    typeof outcome.materiallyChanged !== "boolean" ||
    !Array.isArray(outcome.after)
  ) {
    return "malformed finalized outcome";
  }
  const fileTargets = entry.targets.filter(
    (target) => target !== "__shell_cmd__",
  );
  const snapshotKeys = fileTargets.map((target) => sanitizeFileName(target));
  if (
    fileTargets.length === 0 ||
    new Set(snapshotKeys).size !== snapshotKeys.length ||
    outcome.after.length !== fileTargets.length ||
    outcome.after.some((state, index) => {
      if (
        !state ||
        typeof state !== "object" ||
        state.path !== fileTargets[index]
      ) {
        return true;
      }
      if (state.state === "missing") return state.sha256 !== undefined;
      return (
        state.state !== "file" || !/^[0-9a-f]{64}$/.test(state.sha256 ?? "")
      );
    })
  ) {
    return "finalized outcome does not match checkpoint targets";
  }
  return undefined;
}

/** Inspect the latest actual file mutation without modifying the workspace. */
export function inspectLastSafeFileMutationCheckpoint(
  workspaceRoot: string,
  runId: string,
): SafeFileMutationCheckpointInspection {
  const runDir = resolveExistingCheckpointDirectory(workspaceRoot, runId);
  if (!runDir) return { status: "none" };
  const dirs = readCheckpointDirectoryNames(workspaceRoot, runDir)
    .filter((name) => /^\d+$/.test(name))
    .map((name) => ({ name, seq: Number.parseInt(name, 10) }))
    .sort((left, right) => right.seq - left.seq);
  let entry: CheckpointEntry | undefined;
  for (const dir of dirs) {
    const checkpointDir = resolveExistingCheckpointDirectory(
      workspaceRoot,
      runId,
      dir.seq,
    );
    if (!checkpointDir) {
      return {
        status: "invalid",
        reason: `checkpoint ${dir.seq} directory is missing`,
      };
    }
    const metaPath = path.join(checkpointDir, "_meta.json");
    if (!checkpointFileExists(workspaceRoot, metaPath)) {
      return {
        status: "invalid",
        reason: `checkpoint ${dir.seq} metadata is missing`,
      };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    } catch {
      return {
        status: "invalid",
        reason: `checkpoint ${dir.seq} metadata is not valid JSON`,
      };
    }
    const parsed = parseSafeCheckpointEntry(raw, dir.seq);
    if (parsed.status === "invalid") return parsed;
    if (!SAFE_FILE_MUTATION_TOOLS.has(parsed.entry.tool)) continue;
    if (!parsed.entry.outcome) continue;
    const outcomeError = validateSafeCheckpointOutcome(parsed.entry);
    if (outcomeError) {
      return {
        status: "invalid",
        reason: `checkpoint ${dir.seq}: ${outcomeError}`,
      };
    }
    if (!parsed.entry.outcome.materiallyChanged) continue;
    if (!parsed.entry.outcome.toolSucceeded) continue;
    entry = parsed.entry;
    break;
  }
  if (!entry?.outcome) return { status: "none" };
  for (const target of entry.targets) {
    if (target === "__shell_cmd__") continue;
    if (!resolveCheckpointTarget(workspaceRoot, target)) {
      return {
        status: "invalid",
        reason: `unsafe checkpoint target: ${target}`,
      };
    }
  }
  const conflicts = entry.outcome.after
    .filter((expected) => {
      const current = checkpointTargetState(workspaceRoot, expected.path);
      return !current || !targetStatesEqual(expected, current);
    })
    .map((state) => state.path);
  return conflicts.length > 0
    ? { status: "conflict", entry, conflictingPaths: conflicts }
    : { status: "ready", entry };
}

/**
 * Restore only the latest finalized Agent file mutation. Arbitrary revisions
 * and paths are deliberately unsupported, and intervening external writes
 * fail closed instead of being overwritten.
 */
export function undoLastSafeFileMutationCheckpoint(
  workspaceRoot: string,
  runId: string,
): SafeFileMutationCheckpointInspection {
  const inspected = inspectLastSafeFileMutationCheckpoint(workspaceRoot, runId);
  if (inspected.status !== "ready") return inspected;
  const checkpointDir = resolveExistingCheckpointDirectory(
    workspaceRoot,
    runId,
    inspected.entry.seq,
  );
  if (!checkpointDir) {
    return {
      status: "invalid",
      reason: `checkpoint ${inspected.entry.seq} directory is missing`,
    };
  }
  const actions: Array<{
    readonly path: string;
    readonly full: string;
    readonly expected: CheckpointTargetStateV1;
    readonly restore: Buffer | null;
    readonly rollback: Buffer | null;
  }> = [];
  try {
    for (const rel of inspected.entry.targets) {
      if (rel === "__shell_cmd__") continue;
      const full = resolveCheckpointTarget(workspaceRoot, rel);
      if (!full) {
        return {
          status: "invalid",
          reason: `unsafe checkpoint target: ${rel}`,
        };
      }
      const expected = inspected.entry.outcome?.after.find(
        (state) => state.path === rel,
      );
      const current = checkpointTargetState(workspaceRoot, rel);
      if (!expected || !current || !targetStatesEqual(expected, current)) {
        return {
          status: "conflict",
          entry: inspected.entry,
          conflictingPaths: [rel],
        };
      }
      const rollback =
        fs.existsSync(full) && fs.statSync(full).isFile()
          ? fs.readFileSync(full)
          : null;
      const createMarker = path.join(
        checkpointDir,
        `.create-${sanitizeFileName(rel)}`,
      );
      const suffix = `-${sanitizeFileName(rel)}`;
      const snapshots = readCheckpointDirectoryNames(
        workspaceRoot,
        checkpointDir,
      ).filter((name) => name.endsWith(suffix));
      const hasCreateMarker = checkpointFileExists(workspaceRoot, createMarker);
      if (Number(hasCreateMarker) + snapshots.length !== 1) {
        return {
          status: "invalid",
          reason: `checkpoint ${inspected.entry.seq} must have exactly one marker or snapshot for ${rel}`,
        };
      }
      let restore: Buffer | null = null;
      if (!hasCreateMarker) {
        const snapshotName = snapshots[0];
        if (!snapshotName) {
          return {
            status: "invalid",
            reason: `checkpoint ${inspected.entry.seq} is missing a snapshot for ${rel}`,
          };
        }
        const snapshotPath = path.join(checkpointDir, snapshotName);
        if (!checkpointFileExists(workspaceRoot, snapshotPath)) {
          return {
            status: "invalid",
            reason: `checkpoint ${inspected.entry.seq} snapshot is not a safe file for ${rel}`,
          };
        }
        restore = fs.readFileSync(snapshotPath);
        const encodedHash = snapshotName.slice(0, -suffix.length);
        if (encodedHash !== hashBytes(restore)) {
          return {
            status: "invalid",
            reason: `checkpoint ${inspected.entry.seq} snapshot hash mismatch for ${rel}`,
          };
        }
      }
      actions.push({ path: rel, full, expected, restore, rollback });
    }
  } catch (error) {
    return {
      status: "invalid",
      reason: `checkpoint ${inspected.entry.seq} cannot be prepared: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const applied: typeof actions = [];
  const rollbackApplied = (): boolean => {
    let restored = true;
    for (const action of applied.reverse()) {
      try {
        if (action.rollback === null) fs.rmSync(action.full, { force: true });
        else fs.writeFileSync(action.full, action.rollback);
      } catch {
        restored = false;
      }
    }
    return restored;
  };
  try {
    // Compare each target immediately before its own restore. This keeps a
    // later target from being overwritten when it changes while an earlier
    // member of the same multi-file checkpoint is being restored.
    for (const action of actions) {
      const current = checkpointTargetState(workspaceRoot, action.path);
      if (!current || !targetStatesEqual(action.expected, current)) {
        if (!rollbackApplied()) {
          return {
            status: "invalid",
            reason: `checkpoint ${inspected.entry.seq} conflict rollback failed`,
          };
        }
        return {
          status: "conflict",
          entry: inspected.entry,
          conflictingPaths: [action.path],
        };
      }
      // Register the rollback before the filesystem call: a write can fail
      // after truncating or partially replacing the target.
      applied.push(action);
      if (action.restore === null) {
        fs.unlinkSync(action.full);
      } else {
        fs.mkdirSync(path.dirname(action.full), { recursive: true });
        fs.writeFileSync(action.full, action.restore);
      }
    }
  } catch (error) {
    // Best-effort transaction rollback: never report a successful safe undo
    // when one of a multi-file checkpoint's restores failed.
    rollbackApplied();
    return {
      status: "invalid",
      reason: `checkpoint ${inspected.entry.seq} restore failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const runCheckpointsDir = resolveExistingCheckpointDirectory(
    workspaceRoot,
    runId,
  );
  if (!runCheckpointsDir) {
    return {
      status: "invalid",
      reason: "checkpoint storage disappeared before cleanup",
    };
  }
  for (const candidate of readCheckpointDirectoryNames(
    workspaceRoot,
    runCheckpointsDir,
  )) {
    if (!/^\d+$/.test(candidate)) continue;
    if (Number.parseInt(candidate, 10) < inspected.entry.seq) continue;
    const candidateDir = resolveExistingCheckpointDirectory(
      workspaceRoot,
      runId,
      Number.parseInt(candidate, 10),
    );
    if (!candidateDir) continue;
    fs.rmSync(candidateDir, {
      recursive: true,
      force: true,
    });
  }
  return { status: "ready", entry: inspected.entry };
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
  const runCheckpointsDir = resolveExistingCheckpointDirectory(
    workspaceRoot,
    runId,
  );
  if (!runCheckpointsDir) return null;

  // 按 seq 降序排列，找到最新的检查点
  const dirs = readCheckpointDirectoryNames(workspaceRoot, runCheckpointsDir)
    .filter((n) => /^\d+$/.test(n))
    .map((n) => ({ name: n, seq: Number.parseInt(n, 10) }))
    .sort((a, b) => b.seq - a.seq);

  for (const d of dirs) {
    const checkpointDir = resolveExistingCheckpointDirectory(
      workspaceRoot,
      runId,
      d.seq,
    );
    if (!checkpointDir) continue;
    const meta = applyCheckpointRestore(checkpointDir, workspaceRoot);
    if (meta) {
      // 恢复成功后删除该检查点目录
      if (!assertExistingCheckpointDirectory(workspaceRoot, checkpointDir)) {
        return null;
      }
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
  const runCheckpointsDir = resolveExistingCheckpointDirectory(
    workspaceRoot,
    runId,
  );
  if (!runCheckpointsDir) return null;

  const targetDir = resolveExistingCheckpointDirectory(
    workspaceRoot,
    runId,
    seq,
  );
  if (!targetDir) return null;

  const meta = applyCheckpointRestore(targetDir, workspaceRoot);
  if (!meta) return null;

  // 删除目标检查点及所有比它更新的检查点
  const dirs = readCheckpointDirectoryNames(workspaceRoot, runCheckpointsDir)
    .filter((n) => /^\d+$/.test(n))
    .map((n) => Number.parseInt(n, 10))
    .filter((n) => n >= seq);

  if (opts?.backup) {
    // 最佳尽力备份：将待删除的检查点复制到 .backup 目录
    const backupRoot = path.join(runCheckpointsDir, ".backup");
    ensureCheckpointParentDirectory(workspaceRoot, backupRoot);
    const backupDir = path.join(backupRoot, String(Date.now()));
    fs.mkdirSync(backupDir);
    assertSafeCheckpointDirectory(workspaceRoot, backupDir);
    for (const s of dirs) {
      const src = resolveExistingCheckpointDirectory(workspaceRoot, runId, s);
      if (!src) continue;
      const dst = path.join(backupDir, String(s));
      try {
        fs.cpSync(src, dst, { recursive: true });
      } catch {
        // 备份失败不影响主流程
      }
    }
  }

  for (const s of dirs) {
    const dir = resolveExistingCheckpointDirectory(workspaceRoot, runId, s);
    if (!dir) continue;
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
  const runCheckpointsDir = resolveExistingCheckpointDirectory(
    workspaceRoot,
    runId,
  );
  if (!runCheckpointsDir) return [];

  const out: CheckpointEntry[] = [];
  for (const name of readCheckpointDirectoryNames(
    workspaceRoot,
    runCheckpointsDir,
  )) {
    if (!/^\d+$/.test(name)) continue;
    const checkpointDir = resolveExistingCheckpointDirectory(
      workspaceRoot,
      runId,
      Number.parseInt(name, 10),
    );
    if (!checkpointDir) continue;
    const metaPath = path.join(checkpointDir, "_meta.json");
    if (!checkpointFileExists(workspaceRoot, metaPath)) continue;
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
    tool === "workspace.undo_last_edit" ||
    tool === "workspace.run_shell" ||
    tool === "workspace.job_start"
  );
}
