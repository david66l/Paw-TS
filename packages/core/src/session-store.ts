/**
 * 会话持久化模块 —— 以追加写 JSONL 流的方式记录 Agent 运行时的所有事件。
 *
 * ## 模块职责
 *
 * AI Agent 的每一次运行都会产生大量事件：运行开始/结束、模型请求/响应、工具调用、
 * 思考过程、错误等。这些事件需要被持久化以便：
 * 1. **事后审计**：用户可以回顾 Agent 的完整决策过程
 * 2. **调试分析**：开发者可以定位问题发生时的上下文
 * 3. **UI 展示**：前端可以加载、回放运行历史
 * 4. **统计分析**：汇总工具调用次数、模型使用情况等指标
 *
 * ## 存储格式
 *
 * 每条运行记录是一个 JSONL（JSON Lines）文件，路径为：
 * ```
 * <workspaceRoot>/.paw/sessions/<runId>.jsonl
 * ```
 *
 * JSONL 的优势：
 * - **追加写效率高**：新事件只需 append 到文件末尾，无需读取整个文件
 * - **流式可读**：可以逐行读取，适合大文件的回放和分页加载
 * - **容错性好**：单行损坏不影响其他行的解析
 * - **可压缩性强**：线级结构化数据适合 gzip 等压缩算法
 *
 * ## 架构设计
 *
 * - 定义了 `SessionStore` 接口，`FileSystemSessionStore` 为文件系统实现
 * - 支持多种读取方式：全量加载、分页加载、流式回放（AsyncIterable）
 * - `getRunSummary` 提供轻量级摘要（只读文件头尾），避免大文件全量读取
 * - 自动清理：当运行数量超过 maxRuns 时，按修改时间删除最旧的记录
 *
 * ## 关键设计决策
 *
 * - **追加写而非覆盖写**：事件是只增不删的，使用 append 保证性能和数据安全
 * - **行数估算**：`estimateLineCount` 通过采样首 4KB 计算平均行长来估算总行数，
 *   避免逐行扫描大文件
 * - **文件尾读取**：`getRunSummary` 只读取文件最后 16KB 来获取最终状态，
 *   而非加载整个文件
 * - **流式回放**：`replayRun` 使用 `fs.createReadStream` 和 AsyncIterator 模式，
 *   内存占用恒定，适合超大运行记录的回放
 */

import fs from "node:fs";
import path from "node:path";

import type { RunEventEnvelope } from "./run-events.js";
import { sanitizeRunId, sessionsDir } from "./workspace-paths.js";

/**
 * 运行摘要 —— 从会话文件中提取的关键统计信息。
 *
 * 相比全量加载所有事件，摘要只需要读取文件的头部（获取 start 信息）和
 * 尾部（获取完成状态），速度更快，内存占用更低。
 */
export interface RunSummary {
  /** 运行唯一标识符 */
  readonly runId: string;
  /** 运行目标描述 */
  readonly goal: string;
  /** 运行状态：已完成、已失败、运行中 */
  readonly status: "completed" | "failed" | "running";
  /** 运行开始时间戳（毫秒） */
  readonly startedAt: number;
  /** 运行完成时间戳（毫秒），运行中时为 undefined */
  readonly completedAt?: number;
  /** 事件总数 */
  readonly eventCount: number;
  /** 使用的模型标签 */
  readonly modelLabel?: string;
  /** 工具调用次数 */
  readonly toolCallCount: number;
  /** 最终结果消息 */
  readonly finalMessage?: string;
}

/**
 * 会话存储接口。
 *
 * 定义了完整的 CRUD + 查询操作，以及两种读取策略（分页、流式回放）。
 */
export interface SessionStore {
  /** 向运行的 JSONL 文件追加一条事件信封 */
  saveEvent(runId: string, envelope: RunEventEnvelope): void;
  /** 列出所有至少有一条事件记录的运行，按开始时间降序排列 */
  listRuns(): RunSummary[];
  /** 按序号顺序加载一次运行的全部事件信封 */
  loadRun(runId: string): RunEventEnvelope[] | null;
  /**
   * Fail-closed journal load for authoritative resume/replay. Unlike loadRun,
   * any malformed or truncated non-empty line rejects the whole prefix.
   */
  loadRunStrict(runId: string): RunEventEnvelope[] | null;
  /** 分页加载运行的事件信封（支持偏移量和限制数量） */
  loadRunPaginated(
    runId: string,
    offset: number,
    limit: number,
  ): { events: RunEventEnvelope[]; total: number } | null;
  /**
   * 以 AsyncIterable 方式回放运行。
   *
   * 适合超大运行记录：内存占用恒定，不需要一次性将全部事件加载到内存中。
   * 使用 Node.js 可读流逐行解析 JSONL。
   */
  replayRun(runId: string): AsyncIterable<RunEventEnvelope> | null;
  /** 从已存储的事件中构建运行摘要（比 loadRun 更轻量） */
  getRunSummary(runId: string): RunSummary | null;
  /** 删除一次运行的会话文件 */
  deleteRun(runId: string): boolean;
}

/** FileSystemSessionStore 的配置选项 */
export interface FileSystemSessionStoreOptions {
  /** 工作区根目录路径 */
  readonly workspaceRoot: string;
  /**
   * 最多保留的运行记录数。
   * 超出限制时，按修改时间删除最旧的记录（LRU 策略）。
   * 默认值：100
   */
  readonly maxRuns?: number;
}

/**
 * 基于文件系统的会话存储实现。
 *
 * 每个运行存储为一个 JSONL 文件，位于 `.paw/sessions/<runId>.jsonl`。
 * 构造函数自动创建 sessions 目录（如果不存在）。
 */
export class FileSystemSessionStore implements SessionStore {
  private readonly sessionsDir: string;
  private readonly maxRuns: number;

  constructor(opts: FileSystemSessionStoreOptions) {
    this.sessionsDir = sessionsDir(opts.workspaceRoot);
    this.maxRuns = opts.maxRuns ?? 100;
    fs.mkdirSync(this.sessionsDir, { recursive: true });
  }

  /** 根据 runId 生成安全的文件路径 */
  private runPath(runId: string): string {
    const safe = sanitizeRunId(runId);
    return path.join(this.sessionsDir, `${safe}.jsonl`);
  }

  /**
   * 将事件追加到 JSONL 文件末尾。
   *
   * 每次写入后检查是否需要清理旧记录。
   */
  saveEvent(runId: string, envelope: RunEventEnvelope): void {
    const p = this.runPath(runId);
    const line = `${JSON.stringify(envelope)}\n`;
    fs.appendFileSync(p, line, "utf8");
    this.maybePrune();
  }

  /**
   * 列出所有运行摘要，按开始时间降序排列（最新的排在最前）。
   *
   * 注意：此方法会对每个 JSONL 文件调用 getRunSummary，
   * 在大数量运行记录时可能较慢。
   */
  listRuns(): RunSummary[] {
    const entries: RunSummary[] = [];
    for (const name of fs.readdirSync(this.sessionsDir)) {
      if (!name.endsWith(".jsonl")) continue;
      const runId = name.slice(0, -6);  // 去掉 .jsonl 后缀得到 runId
      const s = this.getRunSummary(runId);
      if (s) entries.push(s);
    }
    return entries.sort((a, b) => b.startedAt - a.startedAt);
  }

  /**
   * 全量加载一次运行的所有事件。
   *
   * 警告：对于大文件（>10MB）可能消耗大量内存，考虑使用 loadRunPaginated
   * 或 replayRun 替代。
   */
  loadRun(runId: string): RunEventEnvelope[] | null {
    const p = this.runPath(runId);
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim() !== "");
    const out: RunEventEnvelope[] = [];
    for (const line of lines) {
      try {
        const obj = JSON.parse(line) as unknown;
        if (isEnvelope(obj)) out.push(obj);
      } catch {
        // 跳过损坏行（JSON 解析失败），不影响其他行
      }
    }
    return out;
  }

  loadRunStrict(runId: string): RunEventEnvelope[] | null {
    const p = this.runPath(runId);
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, "utf8");
    const lines = raw.split("\n");
    const out: RunEventEnvelope[] = [];
    let priorSeq = 0;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (line.trim() === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        throw new Error(`Session journal line ${index + 1} is not valid JSON`);
      }
      if (!isEnvelope(parsed) || parsed.runId !== runId) {
        throw new Error(`Session journal line ${index + 1} is not a valid envelope`);
      }
      if (parsed.seq <= priorSeq) {
        throw new Error(
          `Session journal sequence must increase at line ${index + 1}`,
        );
      }
      priorSeq = parsed.seq;
      out.push(parsed);
    }
    return out;
  }

  /**
   * 分页加载运行的事件。
   *
   * 使用 offset 和 limit 控制读取范围，适合大文件的分页展示。
   * 注意：当前实现仍然需要读取整个文件来计算 total（行数），
   * 对大文件仍有一定开销。
   */
  loadRunPaginated(
    runId: string,
    offset: number,
    limit: number,
  ): { events: RunEventEnvelope[]; total: number } | null {
    const p = this.runPath(runId);
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim() !== "");
    const total = lines.length;
    // 计算实际读取范围，处理越界情况
    const start = Math.max(0, offset);
    const end = Math.min(lines.length, start + limit);
    const events: RunEventEnvelope[] = [];
    for (let i = start; i < end; i++) {
      try {
        const obj = JSON.parse(lines[i]!) as unknown;
        if (isEnvelope(obj)) events.push(obj);
      } catch {
        // 跳过损坏行
      }
    }
    return { events, total };
  }

  /**
   * 以 AsyncIterable 方式流式回放运行。
   *
   * ## 工作原理
   * 1. 使用 `fs.createReadStream` 创建文件可读流（逐块读取，非一次性加载）
   * 2. 内部维护一个 buffer，累积读取的数据块
   * 3. 每次查找 buffer 中的换行符来定位完整的事件行
   * 4. 解析 JSON 并 yield 结果
   *
   * ## 优势
   * - 内存占用恒定（只保留当前 buffer，不会一次性加载整个文件）
   * - 适合超大运行记录（百万行级别）
   * - 支持提前终止（break 循环或调用 return()）
   *
   * ## 生命周期管理
   * - `replayFile` 的 `finally` 负责销毁流（正常结束、提前 break、抛异常三条路径）
   * - 损坏行按既有语义跳过，不影响其余事件
   */
  replayRun(runId: string): AsyncIterable<RunEventEnvelope> | null {
    const p = this.runPath(runId);
    if (!fs.existsSync(p)) return null;
    // 每次迭代各自开一条流：既保持「可多次迭代」的既有语义，也避免把流状态
    // 泄漏到 generator 之外。逐块解析由 replayFile 的 for-await 完成 ——
    // 旧实现用 stream.once("data"/"end"/"error") 每个 chunk 注册三个监听器，
    // 但只有一个会触发，其余永久挂在流上（监听器随 chunk 数线性泄漏）。
    return {
      [Symbol.asyncIterator]: () => replayFile(p),
    };
  }

  /**
   * 从已存储的事件中构建运行摘要。
   *
   * ## 读取策略
   * 1. **文件头（前 8KB）**：读取第一条事件获取开始时间戳和目标
   * 2. **文件尾（后 16KB）**：读取最后一批事件获取完成状态、模型标签、
   *    工具调用次数和最终消息
   * 3. **行数估算**：通过采样计算平均行长来估算事件总数，避免逐行扫描
   *
   * 这样设计的原因是：一次运行可能产生数万行事件，全量读取会浪费 IO 和内存。
   */
  getRunSummary(runId: string): RunSummary | null {
    const p = this.runPath(runId);
    if (!fs.existsSync(p)) return null;

    const fd = fs.openSync(p, "r");
    try {
      // 读取首行以获取开始信息。
      //
      // 旧实现固定读 8192 字节再 split("\n")[0]：如果第一条事件超过 8KB，
      // 拿到的就是半截 JSON，解析失败后 startedAt 静默变成 0、goal 变成 ""。
      // 这里改为按换行符定位真正的首行，并设上限避免病态文件拖垮摘要。
      const firstLine = readFirstLineSync(fd);
      let startedAt = 0;
      let goal = "";
      if (firstLine) {
        try {
          const first = JSON.parse(firstLine) as unknown;
          if (isEnvelope(first)) {
            startedAt = first.ts;
            // 从 run.started 事件中提取目标描述
            if (
              typeof first.event === "object" &&
              first.event !== null &&
              "type" in first.event &&
              first.event.type === "run.started" &&
              "goal" in first.event
            ) {
              goal = String(first.event.goal);
            }
          }
        } catch {
          // JSON 解析失败，忽略
        }
      }

      // 读取文件尾部以获取完成状态和其他统计信息
      const stat = fs.statSync(p);
      const fileSize = stat.size;
      let eventCount = 0;
      let status: RunSummary["status"] = "running";
      let completedAt: number | undefined;
      let modelLabel: string | undefined;
      let toolCallCount = 0;
      let finalMessage: string | undefined;

      if (fileSize > 0) {
        // 读取最后 16KB 获取状态信息
        const tailSize = Math.min(fileSize, 16384);
        const tailBuf = Buffer.alloc(tailSize);
        fs.readSync(fd, tailBuf, 0, tailSize, fileSize - tailSize);
        const tail = tailBuf.toString("utf8");
        const tailLines = tail.split("\n").filter((l) => l.trim() !== "");
        // 通过采样估算总行数（而非逐行扫描整个文件）
        eventCount = this.estimateLineCount(p, fileSize);

        // 遍历尾部事件行，汇总状态信息
        for (const line of tailLines) {
          try {
            const ev = JSON.parse(line) as unknown;
            if (!isEnvelope(ev)) continue;
            const e = ev.event;
            if (e.type === "run.completed") {
              status = e.status === "failed" ? "failed" : "completed";
              completedAt = ev.ts;
              if ("message" in e) finalMessage = String(e.message);
            } else if (e.type === "run.failed") {
              status = "failed";
              completedAt = ev.ts;
              if ("message" in e) finalMessage = String(e.message);
            } else if (e.type === "model.request" && "label" in e) {
              modelLabel = String(e.label);
            } else if (e.type === "tool.call") {
              toolCallCount++;
            }
          } catch {
            // 忽略解析失败的行
          }
        }
      }

      return {
        runId,
        goal,
        status,
        startedAt,
        completedAt,
        eventCount,
        modelLabel,
        toolCallCount,
        finalMessage,
      };
    } finally {
      fs.closeSync(fd);
    }
  }

  /** 删除指定运行的 JSONL 文件，返回是否成功 */
  deleteRun(runId: string): boolean {
    const p = this.runPath(runId);
    if (!fs.existsSync(p)) return false;
    fs.unlinkSync(p);
    return true;
  }

  /**
   * 快速估算 JSONL 文件的行数。
   *
   * ## 算法
   * 1. 读取文件首 4KB 作为字节样本
   * 2. 数出样本中的行数，得到「每行平均字节数」
   * 3. 用文件总字节数除以每行平均字节数
   *
   * ## 为什么必须用字节而不是字符串长度
   * `fileSize` 来自 `statSync`，单位是**字节**。先前实现用
   * `sample.length`（UTF-16 码元数）当分子，两者量纲不同：纯 ASCII 时恰好
   * 相等所以看不出问题，而中文内容每个字符占 3 字节却只有 1 个码元，
   * 估算值会被放大约 3 倍。这里统一用 `bytesRead`。
   *
   * ## 优缺点
   * - 优点：O(1) 时间复杂度，不受文件大小影响
   * - 缺点：假设行长度分布均匀，对于行长度差异极大的文件可能不够准确
   */
  private estimateLineCount(p: string, fileSize: number): number {
    // 采样首 4KB 计算平均行长
    const fd = fs.openSync(p, "r");
    let bytesRead = 0;
    let sample: string;
    try {
      const buf = Buffer.alloc(4096);
      bytesRead = fs.readSync(fd, buf, 0, 4096, 0);
      sample = buf.toString("utf8", 0, bytesRead);
    } finally {
      fs.closeSync(fd);
    }
    if (bytesRead === 0) return 0;
    const lines = sample.split("\n").filter((l) => l.trim() !== "").length;
    if (lines === 0) return 0;
    const bytesPerLine = bytesRead / lines;
    return Math.round(fileSize / bytesPerLine);
  }

  /**
   * 自动清理旧记录。
   *
   * 当 JSONL 文件数量超过 `maxRuns` 时，按修改时间升序排列，
   * 删除最旧的记录直到数量回到限制范围内。
   * 此方法在每次 saveEvent 后自动调用。
   */
  /**
   * 自动清理旧记录。
   *
   * 当 JSONL 文件数量超过 `maxRuns` 时，按修改时间升序排列，
   * 删除最旧的记录直到数量回到限制范围内。
   * 此方法在每次 saveEvent 后自动调用。
   *
   * 性能：先只做一次 `readdirSync` 数个数，未超限就直接返回 ——
   * 旧实现对**每个**文件都 `statSync` 一次，且每次写事件都执行一遍，
   * 于是写一个事件的开销是 O(运行数) 次系统调用。`maxRuns` 语义不变：
   * 一旦超限，仍然立即精确裁剪回上限。
   */
  private maybePrune(): void {
    if (this.maxRuns <= 0) return;
    const names = fs
      .readdirSync(this.sessionsDir)
      .filter((n) => n.endsWith(".jsonl"));
    if (names.length <= this.maxRuns) return;
    const files = names
      .map((name) => ({
        name,
        mtime: fs.statSync(path.join(this.sessionsDir, name)).mtimeMs,
      }))
      .sort((a, b) => a.mtime - b.mtime);  // 按修改时间升序（最旧的排在最前）
    while (files.length > this.maxRuns) {
      const oldest = files.shift();
      if (oldest) {
        fs.unlinkSync(path.join(this.sessionsDir, oldest.name));
      }
    }
  }
}

/**
 * 类型守卫：验证一个未知值是否符合 RunEventEnvelope 的结构。
 *
 * RunEventEnvelope 必须包含四个字段：
 * - runId: string — 运行标识符
 * - seq: number — 事件序列号
 * - ts: number — 时间戳
 * - event: object — 事件对象
 */
function isEnvelope(v: unknown): v is RunEventEnvelope {
  return (
    typeof v === "object" &&
    v !== null &&
    "runId" in v &&
    typeof (v as Record<string, unknown>).runId === "string" &&
    "seq" in v &&
    typeof (v as Record<string, unknown>).seq === "number" &&
    "ts" in v &&
    typeof (v as Record<string, unknown>).ts === "number" &&
    "event" in v &&
    typeof (v as Record<string, unknown>).event === "object"
  );
}

/** 解析一行 JSONL；空行与损坏行返回 null（回放语义：跳过）。 */
function parseEnvelopeLine(line: string): RunEventEnvelope | null {
  if (line.trim() === "") return null;
  try {
    const obj = JSON.parse(line) as unknown;
    return isEnvelope(obj) ? obj : null;
  } catch {
    return null;
  }
}

/**
 * 从已打开的文件描述符读取第一条完整行（按字节定位换行符）。
 *
 * 在 Buffer 上找 `0x0A` 再解码，避免把多字节 UTF-8 序列截断。
 * 超过 `maxBytes` 仍未遇到换行时，返回已读到的内容（而不是静默返回空串），
 * 让调用方的 JSON 解析失败保持可见。
 */
function readFirstLineSync(fd: number, maxBytes = 1_048_576): string {
  const chunk = Buffer.alloc(65_536);
  const parts: Buffer[] = [];
  let position = 0;
  while (position < maxBytes) {
    const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, position);
    if (bytesRead <= 0) break;
    const slice = chunk.subarray(0, bytesRead);
    const newlineIndex = slice.indexOf(0x0a);
    if (newlineIndex !== -1) {
      parts.push(Buffer.from(slice.subarray(0, newlineIndex)));
      break;
    }
    parts.push(Buffer.from(slice));
    position += bytesRead;
  }
  return Buffer.concat(parts).toString("utf8").replace(/\r$/, "");
}

/**
 * 以恒定内存流式回放一个 JSONL 会话文件。
 *
 * 使用流的异步迭代协议（`for await`）而不是手动注册 `data`/`end`/`error`
 * 监听器：后者每读一个 chunk 就注册三个 `once` 监听器，而其中只有一个会触发，
 * 剩下的会一直挂在流对象上，监听器数量随文件块数线性增长。
 * `finally` 保证正常结束、调用方提前 `break`、以及抛异常三条路径都会销毁流。
 */
async function* replayFile(
  filePath: string,
): AsyncGenerator<RunEventEnvelope, void, undefined> {
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  let buffer = "";
  try {
    for await (const chunk of stream) {
      buffer += String(chunk);
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        const envelope = parseEnvelopeLine(line);
        if (envelope) yield envelope;
        newlineIndex = buffer.indexOf("\n");
      }
    }
    // 末行可能没有尾随换行符。
    const trailing = parseEnvelopeLine(buffer);
    if (trailing) yield trailing;
    buffer = "";
  } finally {
    stream.destroy();
  }
}
