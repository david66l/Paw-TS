/**
 * Lightweight task-list (todo) tracking for the agent orchestrator.
 */

export interface TodoItem {
  readonly id: string;
  readonly content: string;
  readonly status: "pending" | "in_progress" | "done";
  readonly priority?: "low" | "medium" | "high";
}

export interface TodoStore {
  readonly items: readonly TodoItem[];
  set(items: readonly TodoItem[]): void;
  add(item: TodoItem): void;
  update(id: string, patch: Partial<Omit<TodoItem, "id">>): boolean;
  remove(id: string): boolean;
  clear(): void;
}

export class InMemoryTodoStore implements TodoStore {
  private _items: TodoItem[] = [];

  get items(): readonly TodoItem[] {
    return this._items;
  }

  set(items: readonly TodoItem[]): void {
    this._items = items.slice();
  }

  add(item: TodoItem): void {
    const idx = this._items.findIndex((t) => t.id === item.id);
    if (idx >= 0) {
      this._items[idx] = item;
    } else {
      this._items.push(item);
    }
  }

  update(id: string, patch: Partial<Omit<TodoItem, "id">>): boolean {
    const idx = this._items.findIndex((t) => t.id === id);
    if (idx < 0) return false;
    const existing = this._items[idx]!;
    this._items[idx] = {
      ...existing,
      ...patch,
      id,
    };
    return true;
  }

  remove(id: string): boolean {
    const before = this._items.length;
    this._items = this._items.filter((t) => t.id !== id);
    return this._items.length < before;
  }

  clear(): void {
    this._items = [];
  }
}

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
