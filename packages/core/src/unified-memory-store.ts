/**
 * Unified memory store — single entry point for all memory types.
 *
 * Aggregates SessionMemory, AutoMemoryEntry, and ProjectMemory into
 * a flat list of {@link MemoryRecord} for retrieval and injection.
 */

import { statSync } from "node:fs";
import { AutoMemoryStore } from "./auto-memory.js";
import {
  type MemoryRecord,
  autoMemoryToRecord,
  sessionMemoryToRecord,
} from "./memory-record.js";
import { SessionMemoryStore } from "./session-memory.js";

export interface UnifiedMemoryStoreOptions {
  readonly workspaceRoot: string;
  readonly sessionId?: string;
  /** Max past session memories to include (newest first). Default 5. */
  readonly sessionPoolSize?: number;
}

const DEFAULT_SESSION_POOL_SIZE = 5;

export class UnifiedMemoryStore {
  private readonly autoStore: AutoMemoryStore;
  private readonly sessionStore: SessionMemoryStore;
  private readonly sessionId?: string;
  private readonly sessionPoolSize: number;

  constructor(opts: UnifiedMemoryStoreOptions) {
    this.autoStore = new AutoMemoryStore({ workspaceRoot: opts.workspaceRoot });
    this.sessionStore = new SessionMemoryStore({
      workspaceRoot: opts.workspaceRoot,
    });
    this.sessionId = opts.sessionId;
    this.sessionPoolSize = opts.sessionPoolSize ?? DEFAULT_SESSION_POOL_SIZE;
  }

  /** List all memories as unified records. */
  list(): MemoryRecord[] {
    const records: MemoryRecord[] = [];

    // Auto memories
    for (const entry of this.autoStore.list()) {
      const mtime = this.getAutoMtime(entry.name);
      records.push(autoMemoryToRecord(entry, mtime));
    }

    // Session memory pool (recent sessions, newest first)
    for (const session of this.sessionStore.listRecent(this.sessionPoolSize)) {
      records.push(sessionMemoryToRecord(session));
    }

    return records;
  }

  /** List memories excluding the current session (to avoid self-reference). */
  listExcludingCurrent(): MemoryRecord[] {
    return this.list().filter((r) => {
      if (r.source !== "session") return true;
      return this.sessionId ? r.id !== this.sessionId : true;
    });
  }

  private getAutoMtime(name: string): number | undefined {
    try {
      const file = `${this.autoStore.memoryDir}/${name}.md`;
      return statSync(file).mtimeMs;
    } catch {
      return undefined;
    }
  }
}
