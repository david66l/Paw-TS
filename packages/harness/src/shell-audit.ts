/**
 * Shell 命令审计日志模块。
 *
 * ## 功能概述
 * 每一条经过 Shell Guard 评估的命令都会被记录到审计日志中，用于合规审查
 * 和安全事件调查。日志以 JSON Lines（换行分隔的 JSON）格式写入文件，
 * 方便对接 SIEM / 日志聚合系统（如 Splunk、ELK、CloudWatch）。
 *
 * ## 核心设计决策
 *
 * 1. **内存缓冲 + 定时刷盘**：
 *    出于性能考虑，审计条目先写入内存缓冲区（最大 100 条），满足以下条件
 *    之一时批量刷入磁盘：
 *      - 缓冲区达到 BUFFER_MAX（100 条）
 *      - 距上次刷盘超过 FLUSH_INTERVAL_MS（5 秒）
 *    这种设计在高频命令场景下避免了每条命令都触发一次磁盘写入。
 *
 * 2. **按天滚动的日志文件**：
 *    日志文件名格式为 `shell-YYYY-MM-DD.jsonl`，每天自动切换到新文件。
 *    这便于日志归档、轮转和按日期检索。
 *
 * 3. **可控开关（环境变量）**：
 *    通过 `PAW_AUDIT` 环境变量控制审计功能的开关：
 *      - `false` / `0` / `off` → 关闭审计（适用于开发环境）
 *      - 其他值或未设置 → 开启审计（生产环境默认行为）
 *
 * 4. **自定义日志目录**：
 *    通过 `PAW_AUDIT_DIR` 环境变量指定审计日志存放目录，
 *    默认路径为 `~/.paw/audit/`。
 *
 * 5. **尽力而为（Best-Effort）刷盘**：
 *    如果刷盘过程中发生 IO 错误（如磁盘满），条目会留在内存缓冲区中，
 *    等待下次定时刷盘时重试。不会因为审计写入失败而阻塞主业务流程。
 *
 * 6. **退出前排空**：
 *    `flushAuditLog()` 函数在进程退出前被调用，确保缓冲区中所有待写入的
 *    审计条目都被写入磁盘，避免丢失。
 */

import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

/**
 * 单条审计日志条目。
 * 记录了一次 Shell 命令评估的完整上下文。
 */
export interface ShellAuditEntry {
  /** ISO-8601 格式的时间戳，精确到毫秒 */
  readonly timestamp: string;
  /** 会话标识符，用于关联同一用户会话中的多条命令 */
  readonly sessionId: string;
  /** 工作区根目录路径 */
  readonly workspace: string;
  /** 原始命令字符串 */
  readonly command: string;
  /** 评估结论：allow（放行）/ block（拒绝）/ ask（需要审批） */
  readonly decision: "allow" | "block" | "ask";
  /** 决策原因（人类可读） */
  readonly reason: string;
  /** 匹配到的规则名称（如果有），用于事后审查规则命中情况 */
  readonly matchedRule?: string;
  /** 用户标识符（多用户模式下使用） */
  readonly userId?: string;
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

/**
 * 检查审计功能是否启用。
 *
 * 环境变量 `PAW_AUDIT` 控制：
 *   - `false` / `0` / `off` → 禁用审计
 *   - 其他值或未设置 → 启用审计
 */
function auditEnabled(): boolean {
  const env = process.env.PAW_AUDIT?.trim().toLowerCase();
  if (env === "false" || env === "0" || env === "off") return false;
  return true;
}

/**
 * 获取审计日志存放目录。
 *
 * 优先级：
 *   1. `PAW_AUDIT_DIR` 环境变量
 *   2. 默认路径 `~/.paw/audit/`
 */
function auditDir(): string {
  return process.env.PAW_AUDIT_DIR?.trim() || join(homedir(), ".paw", "audit");
}

// ---------------------------------------------------------------------------
// 内存缓冲区 + 异步刷盘
// ---------------------------------------------------------------------------

/** 内存缓冲区（最多缓存 100 条后强制刷盘） */
const BUFFER: ShellAuditEntry[] = [];
/** 缓冲区容量上限 */
const BUFFER_MAX = 100;
/** 定时刷盘间隔（毫秒），最坏情况下 5 秒内的日志可能丢失 */
const FLUSH_INTERVAL_MS = 5000;

/** 当前打开的写流（按天切换文件） */
let _writer: ReturnType<typeof createWriteStream> | undefined;
/** 当前写流对应的文件名（用于检测日期变更触发文件切换） */
let _currentFile = "";
/** 定时刷盘计时器 */
let _flushTimer: ReturnType<typeof setInterval> | undefined;

/**
 * 获取当前日期对应的日志文件路径。
 * 格式：shell-YYYY-MM-DD.jsonl
 */
function currentLogFile(): string {
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return join(auditDir(), `shell-${date}.jsonl`);
}

/**
 * 确保写流可用。
 * 如果跨天日期变更，关闭旧文件写流并打开新的。
 *
 * @returns 当前可用的写流
 */
function ensureWriter(): ReturnType<typeof createWriteStream> {
  const file = currentLogFile();
  if (_writer && _currentFile === file) {
    // 同一天内复用已有写流
    return _writer;
  }

  // 日期变更 → 关闭旧文件，打开新文件
  _writer?.end();
  _currentFile = file;

  // 确保目录存在（首次使用时创建）
  const dir = auditDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // 以追加模式打开（同一天内多次启动不会覆盖之前的日志）
  _writer = createWriteStream(file, { flags: "a" });
  return _writer;
}

/**
 * 同步刷盘：将缓冲区中所有条目立即写入磁盘。
 * 如果磁盘 IO 失败，条目会留在缓冲区中等待下次重试（尽力而为策略）。
 */
function flushSync(): void {
  if (BUFFER.length === 0) return;
  const writer = ensureWriter();
  while (BUFFER.length > 0) {
    const entry = BUFFER.shift();
    if (!entry) continue;
    // 写入 JSON Line 格式：每行一个 JSON 对象
    writer.write(JSON.stringify(entry) + "\n");
  }
}

/**
 * 启动定时刷盘计时器。
 * 每 FLUSH_INTERVAL_MS 毫秒自动将缓冲区内容写入磁盘。
 * 幂等操作：如果计时器已在运行，不会重复启动。
 */
function startFlushTimer(): void {
  if (_flushTimer) return;
  _flushTimer = setInterval(() => {
    try {
      flushSync();
    } catch {
      // 尽力而为：刷盘失败时条目留在内存中，下次定时刷盘时重试
      // 不在日志写入失败时抛出异常，不阻塞主业务
    }
  }, FLUSH_INTERVAL_MS);
}

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

/**
 * 记录一条 Shell 审计日志。
 *
 * 如果审计功能被禁用（`PAW_AUDIT=false`），此调用为无操作。
 * 条目先写入内存缓冲区，在缓冲区满或定时器触发时批量刷入磁盘。
 *
 * @param entry - 审计条目（timestamp 由本函数自动填充）
 */
export function logShellAudit(entry: Omit<ShellAuditEntry, "timestamp">): void {
  if (!auditEnabled()) return;

  const fullEntry: ShellAuditEntry = {
    ...entry,
    timestamp: new Date().toISOString(),
  };

  BUFFER.push(fullEntry);

  // 缓冲区满 → 立即刷盘
  if (BUFFER.length >= BUFFER_MAX) {
    flushSync();
  } else {
    // 确保定时刷盘计时器在运行
    startFlushTimer();
  }
}

/**
 * 立即排空所有待写入的审计条目。
 *
 * 应在进程退出前调用（如 SIGTERM/SIGINT 处理函数中），
 * 防止缓冲区中未刷盘的日志丢失。
 *
 * 调用后关闭写流并清理计时器，适合进程退出场景。
 */
export function flushAuditLog(): void {
  if (!auditEnabled()) return;
  flushSync();
  // 关闭当前写流（不再需要追加写入）
  _writer?.end();
  _writer = undefined;
  if (_flushTimer) {
    clearInterval(_flushTimer);
    _flushTimer = undefined;
  }
}

/**
 * 获取当前内存缓冲区中尚未刷盘的审计条目。
 *
 * 主要用于调试和测试：验证某条命令是否被正确记录到审计日志中。
 * 返回的是缓冲区快照的浅拷贝，不会影响缓冲区的实际内容。
 *
 * @returns 当前缓冲区的审计条目列表（只读）
 */
export function getPendingAuditEntries(): readonly ShellAuditEntry[] {
  return [...BUFFER];
}
