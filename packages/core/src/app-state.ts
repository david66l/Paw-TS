import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import type { ChatMessage } from "./context-manager.js";
import type { TodoItem } from "./todo.js";

/**
 * Snapshot of an in-progress (or completed) orchestrator run.
 * Enough to resume the conversation from the exact turn boundary.
 */
export interface AppState {
  readonly runId: string;
  readonly goal: string;
  readonly workspaceRoot: string;
  /** Turn index the orchestrator is about to execute (0-based). */
  readonly turn: number;
  readonly maxSteps: number;
  /** System prompt + message history at save time. */
  readonly messages: readonly ChatMessage[];
  /** Plan revision and items (if any). */
  readonly plan?: {
    readonly revision: number;
    readonly items: readonly unknown[];
  };
  /** Todo items at save time. */
  readonly todos?: readonly TodoItem[];
  /** Final outcome when the run has already completed. */
  readonly outcome?: {
    readonly status: "completed" | "failed";
    readonly message: string;
  };
  /** Timestamp when the state was saved. */
  readonly savedAt: number;
}

/** Persist and load {@link AppState} snapshots. */
export interface AppStateStore {
  save(state: AppState): Promise<void> | void;
  load(runId: string): Promise<AppState | null> | AppState | null;
  list(): Promise<readonly AppState[]> | readonly AppState[];
  delete(runId: string): Promise<void> | void;
}

/**
 * Default file-system implementation storing one JSON file per runId
 * under `.paw/states/<runId>.json`.
 */
export class FileSystemAppStateStore implements AppStateStore {
  private readonly statesDir: string;

  constructor(opts?: { readonly statesDir?: string }) {
    this.statesDir =
      opts?.statesDir ?? path.join(process.cwd(), ".paw", "states");
    mkdirSync(this.statesDir, { recursive: true });
  }

  save(state: AppState): void {
    const file = path.join(this.statesDir, `${state.runId}.json`);
    writeFileSync(file, JSON.stringify(state, null, 2));
  }

  load(runId: string): AppState | null {
    const file = path.join(this.statesDir, `${runId}.json`);
    try {
      const raw = readFileSync(file, "utf-8");
      return JSON.parse(raw) as AppState;
    } catch {
      return null;
    }
  }

  list(): readonly AppState[] {
    try {
      const entries = readdirSync(this.statesDir);
      const states: AppState[] = [];
      for (const entry of entries) {
        if (!entry.endsWith(".json")) continue;
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

  delete(runId: string): void {
    const file = path.join(this.statesDir, `${runId}.json`);
    try {
      rmSync(file);
    } catch {
      // ignore missing
    }
  }
}

/** Simple in-memory store for tests. */
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

// --- Selectors ---

/** True when the saved state represents a completed or failed run. */
export function isAppStateFinished(state: AppState): boolean {
  return state.outcome !== undefined;
}

/** Human-readable summary of a state snapshot. */
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
