/**
 * Shell command audit logger.
 *
 * Every command evaluated by the shell guard is recorded for compliance
 * and incident investigation. Logs are written as JSON Lines for easy
 * ingestion into SIEM / log aggregation systems.
 *
 * In production environments audit is always-on. In development it can
 * be disabled via `PAW_AUDIT=false`.
 */

import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ShellAuditEntry {
  /** ISO-8601 timestamp */
  readonly timestamp: string;
  /** Session identifier */
  readonly sessionId: string;
  /** Workspace root path */
  readonly workspace: string;
  /** Raw command string */
  readonly command: string;
  /** Decision: allow / block / ask (approval required) */
  readonly decision: "allow" | "block" | "ask";
  /** Human-readable reason */
  readonly reason: string;
  /** Name of the rule that matched (if any) */
  readonly matchedRule?: string;
  /** User identifier (when running in multi-user mode) */
  readonly userId?: string;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function auditEnabled(): boolean {
  const env = process.env.PAW_AUDIT?.trim().toLowerCase();
  if (env === "false" || env === "0" || env === "off") return false;
  return true;
}

function auditDir(): string {
  return process.env.PAW_AUDIT_DIR?.trim() || join(homedir(), ".paw", "audit");
}

// ---------------------------------------------------------------------------
// In-memory buffer + async flush
// ---------------------------------------------------------------------------

const BUFFER: ShellAuditEntry[] = [];
const BUFFER_MAX = 100;
const FLUSH_INTERVAL_MS = 5000;

let _writer: ReturnType<typeof createWriteStream> | undefined;
let _currentFile = "";
let _flushTimer: ReturnType<typeof setInterval> | undefined;

function currentLogFile(): string {
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return join(auditDir(), `shell-${date}.jsonl`);
}

function ensureWriter(): ReturnType<typeof createWriteStream> {
  const file = currentLogFile();
  if (_writer && _currentFile === file) {
    return _writer;
  }

  // Rotate to new file
  _writer?.end();
  _currentFile = file;

  const dir = auditDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  _writer = createWriteStream(file, { flags: "a" });
  return _writer;
}

function flushSync(): void {
  if (BUFFER.length === 0) return;
  const writer = ensureWriter();
  while (BUFFER.length > 0) {
    const entry = BUFFER.shift();
    if (!entry) continue;
    writer.write(JSON.stringify(entry) + "\n");
  }
}

function startFlushTimer(): void {
  if (_flushTimer) return;
  _flushTimer = setInterval(() => {
    try {
      flushSync();
    } catch {
      // Best-effort: if flush fails we keep entries in memory
      // and retry on next event.
    }
  }, FLUSH_INTERVAL_MS);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function logShellAudit(entry: Omit<ShellAuditEntry, "timestamp">): void {
  if (!auditEnabled()) return;

  const fullEntry: ShellAuditEntry = {
    ...entry,
    timestamp: new Date().toISOString(),
  };

  BUFFER.push(fullEntry);

  if (BUFFER.length >= BUFFER_MAX) {
    flushSync();
  } else {
    startFlushTimer();
  }
}

/** Flush any pending entries immediately. Used before process exit. */
export function flushAuditLog(): void {
  if (!auditEnabled()) return;
  flushSync();
  _writer?.end();
  _writer = undefined;
  if (_flushTimer) {
    clearInterval(_flushTimer);
    _flushTimer = undefined;
  }
}

/** Read recent audit entries (for debugging / testing). */
export function getPendingAuditEntries(): readonly ShellAuditEntry[] {
  return [...BUFFER];
}
