/**
 * 应用状态持久化模块 —— 保存和恢复 Agent 运行时的完整状态快照。
 *
 * ## 模块职责
 *
 * 在 AI Agent 的长期运行中，需要在以下场景保存和恢复状态：
 * 1. **中断恢复**：Agent 运行过程中进程崩溃或用户主动中断，需要能从上次断点继续
 * 2. **会话管理**：用户可以查看历史运行记录，重新加载之前的运行状态
 * 3. **状态查询**：前端 UI 可以列出所有运行及其当前进度
 *
 * AppState 记录了运行的全量状态：目标描述、工作区路径、当前回合索引、消息历史、
 * 计划信息、待办列表以及最终结果。这些信息足以从精确的回合边界恢复对话。
 *
 * ## 架构设计
 *
 * - 定义了 `AppStateStore` 接口，支持两种实现：
 *   - `FileSystemAppStateStore`：生产环境使用，每个 runId 一个 JSON 文件
 *   - `InMemoryAppStateStore`：测试环境使用，数据驻留在内存中
 * - 存储路径：`.paw/states/<runId>.json`
 *
 * ## 关键设计决策
 *
 * - **不可变状态**：AppState 所有字段标记为 readonly，状态变更通过创建新对象完成，
 *   避免意外的副作用
 * - **最小化序列化**：只保存恢复运行所需的关键字段，不保存瞬态数据（如流式响应的
 *   中间状态、WebSocket 连接等）
 * - **按时间排序**：list() 返回的结果按 savedAt 降序排列，最新保存的状态排在最前
 */

import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { atomicWrite } from "./utils/fs.js";

import type { ChatMessage } from "./context/manager.js";
import type { TodoItem } from "./todo.js";

/**
 * 正在运行中（或已完成）的 orchestrator 运行的状态快照。
 *
 * 携带足够的信息以从精确的回合边界恢复对话。
 * 所有字段均为 readonly，状态变更通过创建新对象完成。
 */
export interface AppState {
  /** 运行唯一标识符 */
  readonly runId: string;
  /** 用户输入的初始目标描述 */
  readonly goal: string;
  /** 工作区根目录路径 */
  readonly workspaceRoot: string;
  /** orchestrator 即将执行的回合索引（从 0 开始计数） */
  readonly turn: number;
  /** 最大执行步数限制 */
  readonly maxSteps: number;
  /** 保存时的系统提示词 + 消息历史 */
  readonly messages: readonly ChatMessage[];
  /** 计划版本和条目（如果存在） */
  readonly plan?: {
    /** 计划修订版本号 */
    readonly revision: number;
    /** 计划条目列表 */
    readonly items: readonly unknown[];
  };
  /** 保存时的待办事项列表 */
  readonly todos?: readonly TodoItem[];
  /** 运行已完成时的最终结果 */
  readonly outcome?: {
    /** 完成状态：成功或失败 */
    readonly status: "completed" | "failed";
    /** 结果描述信息 */
    readonly message: string;
  };
  /** 状态保存时间戳（毫秒） */
  readonly savedAt: number;
}

/**
 * 应用状态持久化存储接口。
 *
 * 定义了 save（保存）、load（加载）、list（列表）、delete（删除）四个标准操作。
 * 不同实现可以选择不同的存储后端（文件系统、内存、数据库等）。
 */
export interface AppStateStore {
  save(state: AppState): Promise<void> | void;
  load(runId: string): Promise<AppState | null> | AppState | null;
  list(): Promise<readonly AppState[]> | readonly AppState[];
  delete(runId: string): Promise<void> | void;
}

/**
 * 基于文件系统的默认实现：每个 runId 存储为一个 JSON 文件。
 *
 * 存储路径：`.paw/states/<runId>.json`
 * 构造函数自动创建 states 目录（如不存在）。
 */
export class FileSystemAppStateStore implements AppStateStore {
  private readonly statesDir: string;

  constructor(opts?: { readonly statesDir?: string }) {
    this.statesDir =
      opts?.statesDir ?? path.join(process.cwd(), ".paw", "states");
    mkdirSync(this.statesDir, { recursive: true });
  }

  /** 将状态序列化为 JSON 并写入文件 */
  save(state: AppState): void {
    const file = path.join(this.statesDir, `${state.runId}.json`);
    atomicWrite(file, JSON.stringify(state, null, 2));
  }

  /** 从 JSON 文件加载状态，文件不存在时返回 null */
  load(runId: string): AppState | null {
    const file = path.join(this.statesDir, `${runId}.json`);
    try {
      const raw = readFileSync(file, "utf-8");
      return JSON.parse(raw) as AppState;
    } catch {
      return null;
    }
  }

  /**
   * 列出所有已保存的状态快照。
   * 遍历 states 目录下的所有 .json 文件，加载并验证后返回，
   * 按 savedAt 降序排列（最新保存的排在最前）。
   */
  list(): readonly AppState[] {
    try {
      const entries = readdirSync(this.statesDir);
      const states: AppState[] = [];
      for (const entry of entries) {
        if (!entry.endsWith(".json")) continue;
        // 通过文件名提取 runId（去掉 .json 后缀）
        const runId = entry.slice(0, -5);
        const state = this.load(runId);
        if (state) {
          states.push(state);
        }
      }
      return states.sort((a, b) => b.savedAt - a.savedAt);
    } catch {
      return [];
    }
  }

  /** 删除指定 runId 的状态文件 */
  delete(runId: string): void {
    const file = path.join(this.statesDir, `${runId}.json`);
    try {
      rmSync(file);
    } catch {
      // 文件不存在时忽略错误
    }
  }
}

/**
 * 基于内存的简单实现 —— 用于测试场景。
 *
 * 数据存储在 Map 中，进程退出后丢失。
 * 不依赖文件系统，适合单元测试和集成测试。
 */
export class InMemoryAppStateStore implements AppStateStore {
  private readonly map = new Map<string, AppState>();

  save(state: AppState): void {
    this.map.set(state.runId, state);
  }

  load(runId: string): AppState | null {
    return this.map.get(runId) ?? null;
  }

  list(): readonly AppState[] {
    return [...this.map.values()].sort((a, b) => b.savedAt - a.savedAt);
  }

  delete(runId: string): void {
    this.map.delete(runId);
  }
}

// --- 状态查询辅助函数 ---

/** 判断保存的状态是否代表一个已完成或已失败的运行 */
export function isAppStateFinished(state: AppState): boolean {
  return state.outcome !== undefined;
}

/**
 * 生成状态快照的人类可读摘要字符串。
 *
 * 格式示例：
 * "Run abc123 | goal: 实现用户登录功能… | turn 3/10 | saved: 2025-06-24T10:30:00.000Z"
 */
export function appStateSummary(state: AppState): string {
  const parts: string[] = [];
  parts.push(`Run ${state.runId}`);
  parts.push(
    `goal: ${state.goal.slice(0, 60)}${state.goal.length > 60 ? "…" : ""}`,
  );
  if (state.outcome) {
    parts.push(`status: ${state.outcome.status}`);
  } else {
    parts.push(`turn ${state.turn}/${state.maxSteps}`);
  }
  parts.push(`saved: ${new Date(state.savedAt).toISOString()}`);
  return parts.join(" | ");
}
