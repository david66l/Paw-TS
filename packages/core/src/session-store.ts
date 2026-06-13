/**
 * Session persistence: append RunEventEnvelope streams to
 * `<workspaceRoot>/.paw/sessions/<runId>.jsonl`.
 *
 * Each file is a newline-delimited JSON stream (JSONL).
 */

import fs from "node:fs";
import path from "node:path";

import type { RunEventEnvelope } from "./run-events.js";

export interface RunSummary {
  readonly runId: string;
  readonly goal: string;
  readonly status: "completed" | "failed" | "running";
  readonly startedAt: number;
  readonly completedAt?: number;
  readonly eventCount: number;
  readonly modelLabel?: string;
  readonly toolCallCount: number;
  readonly finalMessage?: string;
}

export interface SessionStore {
  /** Append a single event envelope to the run's JSONL file. */
  saveEvent(runId: string, envelope: RunEventEnvelope): void;
  /** List all runs for which at least one event was saved, newest first. */
  listRuns(): RunSummary[];
  /** Load every envelope for a run in seq order. */
  loadRun(runId: string): RunEventEnvelope[] | null;
  /** Load a slice of envelopes for a run in seq order. */
  loadRunPaginated(
    runId: string,
    offset: number,
    limit: number,
  ): { events: RunEventEnvelope[]; total: number } | null;
  /** Replay a run as an async iterable (memory-efficient for large runs). */
  replayRun(runId: string): AsyncIterable<RunEventEnvelope> | null;
  /** Build a summary from stored events (cheaper than loadRun for large runs). */
  getRunSummary(runId: string): RunSummary | null;
  /** Delete a run's session file. */
  deleteRun(runId: string): boolean;
}

export interface FileSystemSessionStoreOptions {
  readonly workspaceRoot: string;
  /** Max runs to keep. Oldest runs are pruned when exceeded. */
  readonly maxRuns?: number;
}

export class FileSystemSessionStore implements SessionStore {
  private readonly sessionsDir: string;
  private readonly maxRuns: number;

  constructor(opts: FileSystemSessionStoreOptions) {
    this.sessionsDir = path.join(opts.workspaceRoot, ".paw", "sessions");
    this.maxRuns = opts.maxRuns ?? 100;
    fs.mkdirSync(this.sessionsDir, { recursive: true });
  }

  private runPath(runId: string): string {
    // Sanitize: only allow alphanumeric, hyphen, underscore, dot
    const safe = runId.replace(/[^a-zA-Z0-9._-]/g, "_");
    return path.join(this.sessionsDir, `${safe}.jsonl`);
  }

  saveEvent(runId: string, envelope: RunEventEnvelope): void {
    const p = this.runPath(runId);
    const line = `${JSON.stringify(envelope)}\n`;
    fs.appendFileSync(p, line, "utf8");
    this.maybePrune();
  }

  listRuns(): RunSummary[] {
    const entries: RunSummary[] = [];
    for (const name of fs.readdirSync(this.sessionsDir)) {
      if (!name.endsWith(".jsonl")) continue;
      const runId = name.slice(0, -6);
      const s = this.getRunSummary(runId);
      if (s) entries.push(s);
    }
    return entries.sort((a, b) => b.startedAt - a.startedAt);
  }

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
        // skip corrupt line
      }
    }
    return out;
  }

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
    const start = Math.max(0, offset);
    const end = Math.min(lines.length, start + limit);
    const events: RunEventEnvelope[] = [];
    for (let i = start; i < end; i++) {
      try {
        const obj = JSON.parse(lines[i]!) as unknown;
        if (isEnvelope(obj)) events.push(obj);
      } catch {
        // skip corrupt line
      }
    }
    return { events, total };
  }

  replayRun(runId: string): AsyncIterable<RunEventEnvelope> | null {
    const p = this.runPath(runId);
    if (!fs.existsSync(p)) return null;
    const stream = fs.createReadStream(p, { encoding: "utf8" });
    let buffer = "";
    return {
      [Symbol.asyncIterator](): AsyncIterator<RunEventEnvelope> {
        return {
          async next(): Promise<IteratorResult<RunEventEnvelope>> {
            while (true) {
              const newlineIndex = buffer.indexOf("\n");
              if (newlineIndex !== -1) {
                const line = buffer.slice(0, newlineIndex);
                buffer = buffer.slice(newlineIndex + 1);
                if (line.trim() === "") continue;
                try {
                  const obj = JSON.parse(line) as unknown;
                  if (isEnvelope(obj)) {
                    return { value: obj, done: false };
                  }
                } catch {
                  // skip corrupt line, continue to next
                }
                continue;
              }
              const chunk = await new Promise<string | null>((resolve) => {
                stream.once("data", (data) => resolve(String(data)));
                stream.once("end", () => resolve(null));
                stream.once("error", () => resolve(null));
              });
              if (chunk === null) {
                // Process any remaining buffer before ending
                if (buffer.trim() !== "") {
                  const line = buffer;
                  buffer = "";
                  try {
                    const obj = JSON.parse(line) as unknown;
                    if (isEnvelope(obj)) {
                      return { value: obj, done: false };
                    }
                  } catch {
                    // skip corrupt final line
                  }
                }
                return { value: undefined, done: true };
              }
              buffer += chunk;
            }
          },
        };
      },
    };
  }

  getRunSummary(runId: string): RunSummary | null {
    const p = this.runPath(runId);
    if (!fs.existsSync(p)) return null;

    const fd = fs.openSync(p, "r");
    try {
      const buf = Buffer.alloc(8192);
      const n = fs.readSync(fd, buf, 0, 8192, 0);
      const head = buf.toString("utf8", 0, n);
      const firstLine = head.split("\n")[0];
      let startedAt = 0;
      let goal = "";
      if (firstLine) {
        try {
          const first = JSON.parse(firstLine) as unknown;
          if (isEnvelope(first)) {
            startedAt = first.ts;
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
          // ignore
        }
      }

      // Count lines and inspect last events for status
      const stat = fs.statSync(p);
      const fileSize = stat.size;
      let eventCount = 0;
      let status: RunSummary["status"] = "running";
      let completedAt: number | undefined;
      let modelLabel: string | undefined;
      let toolCallCount = 0;
      let finalMessage: string | undefined;

      if (fileSize > 0) {
        // Read tail for status/completion info
        const tailSize = Math.min(fileSize, 16384);
        const tailBuf = Buffer.alloc(tailSize);
        fs.readSync(fd, tailBuf, 0, tailSize, fileSize - tailSize);
        const tail = tailBuf.toString("utf8");
        const tailLines = tail.split("\n").filter((l) => l.trim() !== "");
        eventCount = this.estimateLineCount(p, fileSize);

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
            // ignore
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

  deleteRun(runId: string): boolean {
    const p = this.runPath(runId);
    if (!fs.existsSync(p)) return false;
    fs.unlinkSync(p);
    return true;
  }

  private estimateLineCount(p: string, fileSize: number): number {
    // Fast estimate: sample first 4KB for average line length
    const fd = fs.openSync(p, "r");
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, 4096, 0);
    fs.closeSync(fd);
    const sample = buf.toString("utf8", 0, n);
    const lines = sample.split("\n").filter((l) => l.trim() !== "");
    if (lines.length === 0) return 0;
    const avg = sample.length / lines.length;
    return Math.round(fileSize / avg);
  }

  private maybePrune(): void {
    if (this.maxRuns <= 0) return;
    const files = fs
      .readdirSync(this.sessionsDir)
      .filter((n) => n.endsWith(".jsonl"))
      .map((n) => ({
        name: n,
        mtime: fs.statSync(path.join(this.sessionsDir, n)).mtimeMs,
      }))
      .sort((a, b) => a.mtime - b.mtime);
    while (files.length > this.maxRuns) {
      const oldest = files.shift();
      if (oldest) {
        fs.unlinkSync(path.join(this.sessionsDir, oldest.name));
      }
    }
  }
}

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
