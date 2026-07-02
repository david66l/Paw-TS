/**
 * 轻量级任务列表（Todo）跟踪 —— 供 agent 编排器使用
 * Lightweight task-list (todo) tracking for the agent orchestrator.
 *
 * ============================================================================
 * 模块职责 (Module Purpose)
 * ============================================================================
 * 本模块提供 agent 编排器所需的任务跟踪能力。当 agent 需要拆解并跟踪多个子任务时
 * （例如 "先重构 A 模块，再修复 B bug，最后写测试"），编排器使用本模块来：
 *
 *   1. **状态管理**：每个 TodoItem 有三种状态 —— pending（待办）、in_progress（进行中）、
 *      done（已完成）。
 *   2. **优先级标记**：支持 low / medium / high 三级优先级。
 *   3. **存储抽象**：通过 TodoStore 接口解耦，默认提供 InMemoryTodoStore 实现。
 *   4. **提示格式化**：formatTodosForPrompt 将任务列表序列化为 LLM prompt 可用的
 *      文本格式。
 *
 * 架构定位：属于编排层（orchestrator）的工具模块，不涉及持久化。
 * 所有数据仅存在于内存中，agent 会话结束后即销毁。
 * ============================================================================
 */

/**
 * 单个任务项。
 * Todo item representing a single task.
 */
export interface TodoItem {
  /** 唯一标识符 */
  readonly id: string;
  /** 任务内容描述 */
  readonly content: string;
  /** 任务状态：待办 / 进行中 / 已完成 */
  readonly status: "pending" | "in_progress" | "done";
  /** 优先级（可选） */
  readonly priority?: "low" | "medium" | "high";
}

/**
 * 任务存储的抽象接口。
 * 定义标准的 CRUD 操作，允许替换不同的存储后端（内存、文件、数据库等）。
 *
 * Todo store interface — allows different storage backends.
 */
export interface TodoStore {
  /** 只读的任务列表 */
  readonly items: readonly TodoItem[];
  /** 整体替换任务列表 */
  set(items: readonly TodoItem[]): void;
  /** 添加或更新（按 id）一个任务项 */
  add(item: TodoItem): void;
  /** 按 id 更新任务的部分字段，返回是否成功 */
  update(id: string, patch: Partial<Omit<TodoItem, "id">>): boolean;
  /** 按 id 删除任务，返回是否成功 */
  remove(id: string): boolean;
  /** 清空所有任务 */
  clear(): void;
}

/**
 * 基于内存数组的 TodoStore 实现。
 * 数据仅存在于进程生命周期内，重启后丢失。
 *
 * In-memory implementation of TodoStore.
 */
export class InMemoryTodoStore implements TodoStore {
  private _items: TodoItem[] = [];

  /** 返回当前任务列表的只读视图 */
  get items(): readonly TodoItem[] {
    return this._items;
  }

  /** 整体替换（浅拷贝传入数组，防止外部修改影响内部状态） */
  set(items: readonly TodoItem[]): void {
    this._items = items.slice();
  }

  /** 按 id 添加或更新：已存在则原地更新，不存在则追加到末尾 */
  add(item: TodoItem): void {
    const idx = this._items.findIndex((t) => t.id === item.id);
    if (idx >= 0) {
      this._items[idx] = item;
    } else {
      this._items.push(item);
    }
  }

  /** 按 id 部分更新：合并 patch，强制保留 id 不变 */
  update(id: string, patch: Partial<Omit<TodoItem, "id">>): boolean {
    const idx = this._items.findIndex((t) => t.id === id);
    if (idx < 0) return false;
    const existing = this._items[idx]!;
    this._items[idx] = {
      ...existing,
      ...patch,
      id, // 确保 id 不被 patch 覆盖
    };
    return true;
  }

  /** 按 id 过滤删除，返回 true 表示实际删除了项目 */
  remove(id: string): boolean {
    const before = this._items.length;
    this._items = this._items.filter((t) => t.id !== id);
    return this._items.length < before;
  }

  /** 清空所有任务 */
  clear(): void {
    this._items = [];
  }
}

/**
 * 将任务列表格式化为 LLM prompt 可用的文本表示。
 *
 * 输出格式：
 *   Current tasks:
 *     - [pending] task-1: 重构用户模块 [high]
 *     - [in_progress] task-2: 修复登录 bug [medium]
 *     - [done] task-3: 添加单元测试
 *
 * 空列表时返回 "Current tasks: none"。
 *
 * Format the todo list as a prompt-ready string.
 */
export function formatTodosForPrompt(items: readonly TodoItem[]): string {
  if (items.length === 0) {
    return "Current tasks: none";
  }
  const lines = items.map((t) => {
    const p = t.priority ? ` [${t.priority}]` : "";
    return `  - [${t.status}] ${t.id}: ${t.content}${p}`;
  });
  return `Current tasks:\n${lines.join("\n")}`;
}
