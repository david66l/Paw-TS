/**
 * 统一记忆仓库（Unified Memory Store）——所有记忆类型的单一入口。
 *
 * ## 模块定位
 *
 * 本模块是整个记忆系统的"数据层"。它将三种记忆来源聚合为统一的 MemoryRecord 列表：
 * - AutoMemoryStore: 从文件系统读取自动持久化的记忆（.md 文件 + YAML frontmatter）
 * - SessionMemoryStore: 从会话文件中读取历史会话记忆
 *
 * 上层模块（memory-retriever、memory-scorer 等）只与 UnifiedMemoryStore 交互，
 * 无需关心记忆的具体来源和存储格式。
 *
 * ## 为什么需要统一仓库
 *
 * 1. **单一数据入口**: 检索器只需要一个 store.list() 调用就能拿到全部记忆
 * 2. **来源透明**: 上层代码不区分 session/auto/project 记忆，统一打分和选择
 * 3. **易于扩展**: 新增记忆类型只需在此聚合，不影响检索逻辑
 * 4. **测试友好**: memoryDir 参数允许注入测试目录，无需真实文件系统
 *
 * ## 关键设计决策
 *
 * - sessionPoolSize 默认为 10：只加载最近 10 个会话的记忆，
 *   避免在长期运行后记忆池膨胀导致检索性能下降
 * - listExcludingCurrent() 排除当前会话：防止记忆检索时自引用
 *   （当前会话的动作不应被自己的记忆影响，造成循环）
 * - getAutoMtime 从文件系统读取 mtime：因为 AutoMemoryEntry 可能不携带
 *   时间戳，需要从文件系统补充，用于时效性衰减计算
 * - 所有 store 实例在构造函数中创建并在整个生命周期内复用，
 *   避免反复解析文件系统
 */

import { statSync } from "node:fs";
import { AutoMemoryStore } from "./auto-memory.js";
import {
  type MemoryRecord,
  autoMemoryToRecord,
  sessionMemoryToRecord,
} from "./memory-record.js";
import { SessionMemoryStore } from "./session-memory.js";

/**
 * 统一记忆仓库的初始化选项。
 *
 * - workspaceRoot: 工作区根目录，用于定位记忆文件
 * - sessionId: 当前会话 ID，用于排除当前会话避免自引用
 * - sessionPoolSize: 历史会话记忆池大小，控制加载的会话数量
 * - memoryDir: 自动记忆目录覆盖（测试时使用）
 */
export interface UnifiedMemoryStoreOptions {
  readonly workspaceRoot: string;
  readonly sessionId?: string;
  /** 最多包含多少个历史 session 的记忆（按最新排序）。默认 10。 */
  readonly sessionPoolSize?: number;
  /** 覆盖自动记忆目录（用于测试）。 */
  readonly memoryDir?: string;
}

/** session 记忆池的默认大小 */
const DEFAULT_SESSION_POOL_SIZE = 10;

/**
 * 统一记忆仓库类。
 *
 * 职责：
 * 1. 初始化并管理 AutoMemoryStore 和 SessionMemoryStore 两个子仓库
 * 2. 提供 list() 方法聚合全部记忆为 MemoryRecord 列表
 * 3. 提供 listExcludingCurrent() 方法排除当前会话
 * 4. 从文件系统读取 auto 记忆的 mtime 用于时效性计算
 */
export class UnifiedMemoryStore {
  /** 自动记忆子仓库 */
  private readonly autoStore: AutoMemoryStore;
  /** 会话记忆子仓库 */
  private readonly sessionStore: SessionMemoryStore;
  /** 当前会话 ID（用于排除） */
  private readonly sessionId?: string;
  /** session 记忆池大小限制 */
  private readonly sessionPoolSize: number;

  constructor(opts: UnifiedMemoryStoreOptions) {
    // 初始化自动记忆仓库
    this.autoStore = new AutoMemoryStore({
      workspaceRoot: opts.workspaceRoot,
      memoryDir: opts.memoryDir,
    });
    // 初始化会话记忆仓库
    this.sessionStore = new SessionMemoryStore({
      workspaceRoot: opts.workspaceRoot,
    });
    this.sessionId = opts.sessionId;
    this.sessionPoolSize = opts.sessionPoolSize ?? DEFAULT_SESSION_POOL_SIZE;
  }

  /**
   * 列出全部记忆为统一的 MemoryRecord 列表。
   *
   * 聚合逻辑：
   * 1. 遍历 autoStore 中每条自动记忆 → 通过 autoMemoryToRecord 转换
   * 2. 遍历 sessionStore 中最近的 N 条会话 → 通过 sessionMemoryToRecord 转换
   *
   * 注意：auto 记忆需要额外从文件系统读取 mtime，因为 AutoMemoryEntry
   * 可能不包含时间戳字段。
   */
  list(): MemoryRecord[] {
    const records: MemoryRecord[] = [];

    // 自动记忆：从文件系统读取并附加 mtime
    for (const entry of this.autoStore.list()) {
      const mtime = this.getAutoMtime(entry.name);
      records.push(autoMemoryToRecord(entry, mtime));
    }

    // 会话记忆池：按时间倒序取最近 N 条
    for (const session of this.sessionStore.listRecent(this.sessionPoolSize)) {
      records.push(sessionMemoryToRecord(session));
    }

    return records;
  }

  /**
   * 列出所有记忆，但排除当前会话。
   *
   * 为什么需要排除当前会话：
   * - 防止自引用：当前会话的检索行为不应被自己的记忆影响
   * - 避免循环：如果当前会话的记忆包含了本次检索的结果，会导致无限循环
   * - 保持上下文新鲜度：历史记忆用于补充，当前会话上下文已经是完整可用的
   *
   * 过滤逻辑：对于 session 类型的记录，如果其 id 等于当前 sessionId 则排除；
   * 对于非 session 类型（auto/project 等）全部保留。
   */
  listExcludingCurrent(): MemoryRecord[] {
    return this.list().filter((r) => {
      // 非 session 类型的记录全部保留
      if (r.source !== "session") return true;
      // session 类型：有 sessionId 时排除匹配的，没有 sessionId 时全部保留
      return this.sessionId ? r.id !== this.sessionId : true;
    });
  }

  /**
   * 从文件系统读取自动记忆文件的修改时间（mtime）。
   *
   * 为什么需要这个函数：
   * - AutoMemoryEntry 的 YAML frontmatter 中不一定包含时间戳
   * - 文件系统的 mtime 是可靠的修改时间来源
   * - 这个 mtime 会被传入 autoMemoryToRecord 作为 createdAt/updatedAt 的回退值
   *
   * 文件路径格式：{memoryDir}/{name}.md
   * 如果文件不存在（如 statSync 抛出异常），返回 undefined，
   * 此时 autoMemoryToRecord 会回退到 Date.now()。
   */
  private getAutoMtime(name: string): number | undefined {
    try {
      // 构建完整的文件路径
      const file = `${this.autoStore.memoryDir}/${name}.md`;
      return statSync(file).mtimeMs;
    } catch {
      // 文件不存在或无法读取，返回 undefined 让调用方回退
      return undefined;
    }
  }
}
