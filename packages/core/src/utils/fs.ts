/**
 * 文件系统工具：原子写入 + 文件锁 + 漂移检测。
 *
 * hermes 对齐：对标 hermes 的 fcntl.flock + os.replace + 漂移检测。
 * Node.js 无原生 fcntl → 使用 lock 文件 + PID 检测实现跨平台文件锁。
 */

import {
  existsSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

// ── 文件锁 ───────────────────────────────────────────────

/**
 * 获取排他文件锁。
 *
 * 创建 .lock 文件，写入当前 PID。如果锁已被持有且未过期，自旋等待。
 * macOS/Linux/Windows 均适用（不依赖 fcntl）。
 *
 * 返回 unlock 函数，调用方应在 finally 中执行。
 */
export function lockFile(filePath: string): () => void {
  const lockPath = filePath + ".lock";
  const pid = String(process.pid);
  const started = Date.now();

  // 确保锁文件目录存在
  const dir = path.dirname(lockPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  while (true) {
    try {
      // wx = 排他创建，文件已存在时抛错
      const fd = openSync(lockPath, "wx");
      writeFileSync(fd, pid);
      closeSync(fd);
      return () => {
        try {
          if (readFileSync(lockPath, "utf-8").trim() === pid) {
            unlinkSync(lockPath);
          }
        } catch {
          // 锁文件已不存在（被清理），忽略
        }
      };
    } catch {
      // 锁已存在 → 检查是否过期
      try {
        const holder = readFileSync(lockPath, "utf-8").trim();
        // 检查持有者进程是否还活着
        if (isPidAlive(Number(holder))) {
          // 锁被活进程持有 → 自旋等待（最多 5s）
          if (Date.now() - started > 5_000) {
            throw new Error(
              `File lock timeout: ${filePath} held by PID ${holder}`,
            );
          }
          // 自旋 10ms
          const start = Date.now();
          while (Date.now() - start < 10) {
            /* spin */
          }
          continue;
        }
        // 持有者进程已死 → 清理过期锁
        try {
          unlinkSync(lockPath);
        } catch {
          // 另一个进程抢先清理了
        }
        continue;
      } catch (e) {
        if (e instanceof Error && e.message.startsWith("File lock timeout"))
          throw e;
        // 读取锁文件失败 → 重试
        continue;
      }
    }
  }
}

/**
 * 读取锁文件的持有 PID（不做等待，只读）。
 */
export function readLockPid(filePath: string): number | null {
  const lockPath = filePath + ".lock";
  try {
    return Number(readFileSync(lockPath, "utf-8").trim());
  } catch {
    return null;
  }
}

/**
 * 检查进程是否存活。
 *
 * 向 PID 发信号 0（不实际发信号，只检查权限）。
 * 跨平台：Unix 用 kill(pid, 0)，Windows 用 process.kill。
 */
function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    // 信号 0 = 不实际发信号，只做权限检查
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ── 原子写入 ─────────────────────────────────────────────

/**
 * 原子写入文件。
 *
 * 对标 hermes 的: write .tmp → fsync → os.replace
 * 步骤：写临时文件 → fsync 保证落盘 → rename 原子替换 → fsync 目录项。
 *
 * 注意：`fsyncSync` 必须是**顶层静态 import**。此前这里写成
 * `require("node:fs")` 并包在空 catch 里：本仓库是 `"type": "module"`，
 * 在 Node ESM 下 `require` 未定义会抛 ReferenceError，被 catch 吞掉后
 * fsync 从不执行 —— 而函数签名与调用方（safeWrite 的「完整写入安全链」）
 * 都假设它执行了。Bun 恰好提供 require，所以这个缺陷只在 Node 上显形。
 */
export function atomicWrite(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tmpPath = filePath + "." + randomUUID() + ".tmp";
  try {
    writeFileSync(tmpPath, content, "utf-8");
    // fsync 强制刷盘，防止断电后半截文件
    const fd = openSync(tmpPath, "r+");
    try {
      fsyncSync(fd);
    } catch {
      // 少数平台/文件系统不支持 fsync；不阻断写入，但不再假装已完成。
    } finally {
      closeSync(fd);
    }
    // rename = 同文件系统内的原子替换
    renameSync(tmpPath, filePath);
    // 目录项也要落盘，否则 rename 本身可能在断电后丢失。
    // Windows 不允许 fsync 目录（openSync 会失败），因此保持 best-effort。
    try {
      const dirFd = openSync(dir, "r");
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } catch {
      // best-effort：平台不支持目录 fsync
    }
  } catch (e) {
    // 清理临时文件
    try {
      unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
    throw e;
  }
}

// ── 漂移检测 ─────────────────────────────────────────────

/**
 * 漂移检测结果。
 */
export interface DriftCheckResult {
  /** 是否发生了漂移（文件被外部修改过） */
  drifted: boolean;
  /** 当前文件内容的 SHA256（用于后续写入时的对比） */
  hash: string;
}

/**
 * 读取文件内容并计算 hash，用于后续漂移检测。
 *
 * 调用方应在读取时保存 hash，写入前用 checkDrift 对比。
 */
export function readWithHash(filePath: string): {
  content: string;
  hash: string;
} | null {
  try {
    const content = readFileSync(filePath, "utf-8");
    return { content, hash: sha256(content) };
  } catch {
    return null;
  }
}

/**
 * 写入前检查漂移：对比之前保存的 hash，不一致则创建 .bak 备份。
 *
 * @returns true = 未漂移，安全写入；false = 已漂移，已创建 .bak 备份
 */
export function checkDrift(filePath: string, expectedHash: string): DriftCheckResult {
  const current = readWithHash(filePath);
  if (!current) {
    // 文件不存在 → 首次写入，无漂移
    return { drifted: false, hash: "" };
  }
  if (current.hash !== expectedHash) {
    // 漂移！备份当前版本
    const bakPath = filePath + `.bak.${Date.now()}`;
    try {
      writeFileSync(bakPath, current.content, "utf-8");
    } catch {
      /* best-effort: 备份失败不阻塞写入 */
    }
    return { drifted: true, hash: current.hash };
  }
  return { drifted: false, hash: current.hash };
}

/**
 * 安全写入：加锁 → 漂移检测 → 原子写入 → 释放锁。
 *
 * 一站式写入，对标 hermes 的完整写入安全链。
 * 如果漂移，返回 false（调用方应重新加载内容后重试）。
 */
export function safeWrite(
  filePath: string,
  content: string,
  expectedHash?: string,
): boolean {
  const unlock = lockFile(filePath);
  try {
    if (expectedHash !== undefined) {
      const drift = checkDrift(filePath, expectedHash);
      if (drift.drifted) return false;
    }
    atomicWrite(filePath, content);
    return true;
  } finally {
    unlock();
  }
}

// ── 工具 ─────────────────────────────────────────────────

function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}
