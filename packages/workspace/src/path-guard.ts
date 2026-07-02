/**
 * 路径安全守卫 — 工作区边界 + 敏感路径拒绝。
 * ============================================
 *
 * 所有文件系统操作在访问磁盘前都必须经过此守卫检查。
 *
 * 三层检查：
 * 1. **工作区越界（escaped）**：路径不能通过 ../ 或符号链接跳出工作区根目录
 * 2. **敏感路径（sensitive）**：拒绝访问 .git/.paw/.env/.ssh/credentials 等敏感目录
 * 3. **无效路径（invalid）**：路径解析失败
 *
 * 符号链接处理：
 * 使用 realpath 解析符号链接的真实路径，防止通过 symlink 绕过工作区限制。
 * nearestExistingPath() 处理不存在的路径（如要创建的新文件）。
 */

import fs from "node:fs";
import path from "node:path";

/** 读/列表操作中阻断的路径段（V2 路径守卫）。 */
export const SENSITIVE_PATH_SEGMENTS = new Set([
  ".git", ".paw", ".env", ".ssh",
  "id_rsa", "id_ed25519", "credentials", "secrets",
  ".aws", ".gcloud", ".netrc", ".npmrc",
  "authorized_keys", "known_hosts",
]);

export type PathRisk = "safe" | "sensitive" | "escaped" | "invalid";

export interface PathDecision {
  readonly allowed: boolean;
  readonly resolvedPath: string;
  readonly risk: PathRisk;
  readonly reason: string;
}

/** 判断 target 是否在 root 内部（含符号链接检查前的逻辑检查）。 */
export function isPathInsideRoot(
  rootResolved: string,
  targetResolved: string,
): boolean {
  const root = path.resolve(rootResolved);
  const target = path.resolve(targetResolved);
  if (root === target) return true;
  const rel = path.relative(root, target);
  return (
    rel !== "" &&
    !rel.startsWith(`..${path.sep}`) &&
    rel !== ".." &&
    !path.isAbsolute(rel)
  );
}

/** 找到路径上最近的存在父目录（用于解析符号链接）。 */
function nearestExistingPath(absPath: string, rootAbs: string): string {
  let current = absPath;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    if (!isPathInsideRoot(rootAbs, parent) && parent !== rootAbs) return parent;
    current = parent;
  }
  return current;
}

function realpathExisting(absPath: string): string {
  return fs.realpathSync.native?.(absPath) ?? fs.realpathSync(absPath);
}

function segments(absPath: string): string[] {
  return absPath.split(path.sep).filter((p) => p.length > 0);
}

/** 检查路径是否包含敏感段（如 .git、.env）。 */
function hasSensitiveSegment(absPath: string): string | undefined {
  const parts = segments(absPath);
  for (const part of parts) {
    if (SENSITIVE_PATH_SEGMENTS.has(part)) return part;
  }
  return undefined;
}

/**
 * 解析 `userPath`（相对或绝对）对 `workspaceRoot`，并强制执行
 * 工作区边界 + 敏感段拒绝列表。
 *
 * 检查流程：
 * 1. 解析工作区根目录的真实路径
 * 2. 解析用户提供的候选路径
 * 3. 检查候选路径是否在工作区内部
 * 4. 通过 realpath 检查符号链接是否绕过工作区
 * 5. 检查敏感路径段
 */
export function checkWorkspacePath(
  workspaceRoot: string,
  userPath: string,
): PathDecision {
  let rootAbs: string;
  let rootReal: string;
  try {
    rootAbs = path.resolve(workspaceRoot);
    rootReal = realpathExisting(rootAbs);
  } catch {
    return { allowed: false, resolvedPath: "", risk: "invalid", reason: "Workspace root could not be resolved" };
  }

  let candidate: string;
  try {
    candidate = path.isAbsolute(userPath)
      ? path.resolve(userPath)
      : path.resolve(rootAbs, userPath);
  } catch {
    return { allowed: false, resolvedPath: "", risk: "invalid", reason: "Path could not be resolved" };
  }

  // 检查：路径不能通过 .. 跳出工作区
  if (!isPathInsideRoot(rootAbs, candidate)) {
    return { allowed: false, resolvedPath: candidate, risk: "escaped", reason: `Path escapes workspace root: ${rootAbs}` };
  }

  // 符号链接检查：防止通过 symlink 绕过工作区
  try {
    const existing = nearestExistingPath(candidate, rootAbs);
    const existingReal = realpathExisting(existing);
    if (!isPathInsideRoot(rootReal, existingReal)) {
      return { allowed: false, resolvedPath: candidate, risk: "escaped", reason: `Path escapes workspace root via symlink: ${rootReal}` };
    }
  } catch {
    return { allowed: false, resolvedPath: candidate, risk: "invalid", reason: "Path could not be checked against real workspace path" };
  }

  // 敏感路径检查
  const bad = hasSensitiveSegment(candidate);
  if (bad) {
    return { allowed: false, resolvedPath: candidate, risk: "sensitive", reason: `Path contains sensitive segment: ${bad}` };
  }

  return { allowed: true, resolvedPath: candidate, risk: "safe", reason: "" };
}
