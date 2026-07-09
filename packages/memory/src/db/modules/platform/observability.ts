/**
 * 可观测性基础 (8.18 simplified)
 *
 * 结构化日志 + 计数器。不依赖外部服务，纯内存累积。
 * prod 环境可注入 OpenTelemetry / Prometheus exporter。
 */

export interface LogEntry {
  level: "INFO" | "WARN" | "ERROR";
  event: string;
  module: string;
  message: string;
  durationMs?: number;
  error?: string;
  taskId?: string;
  memoryId?: string;
  timestamp: string;
}

export class Observability {
  private logs: LogEntry[] = [];
  readonly counters = new Map<string, number>();
  readonly maxLogs: number;

  constructor(maxLogs = 10000) {
    this.maxLogs = maxLogs;
  }

  log(entry: Omit<LogEntry, "timestamp">): void {
    const record: LogEntry = { ...entry, timestamp: new Date().toISOString() };
    this.logs.push(record);
    if (this.logs.length > this.maxLogs) this.logs.splice(0, this.logs.length - this.maxLogs);
    if (entry.level === "ERROR") console.error(`[${entry.module}] ${entry.event}: ${entry.message}`);
  }

  count(name: string, delta = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + delta);
  }

  snapshot() {
    return {
      counters: Object.fromEntries(this.counters),
      recentErrors: this.logs.filter((l) => l.level === "ERROR").slice(-20),
      recentLogs: this.logs.slice(-50),
    };
  }
}

/** 单例 */
export const obs = new Observability();
