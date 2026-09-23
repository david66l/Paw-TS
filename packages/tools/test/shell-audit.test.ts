import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { flushAuditLog, getPendingAuditEntries, logShellAudit } from "../src/shell-audit.js";

/**
 * §D9 点名 `logShellAudit` / `flushAuditLog` 没有任何用例 —— 而它们决定策略判定
 * 是否留下可审计的痕迹。`getPendingAuditEntries()` 的文档说明它就是给测试用的，
 * 所以这里断言缓冲与刷盘两段行为，不去碰 `~/.paw/audit`（用 PAW_AUDIT_DIR 指到
 * 临时目录）。
 *
 * 模块级单例（缓冲 + 写流 + 定时器）在用例之间共享，因此每个用例开头都先
 * `flushAuditLog()` 清空上一轮留下的状态。
 */
const AUDIT_DIR = mkdtempSync(join(tmpdir(), "paw-audit-"));
const MARKER = "paw-audit-contract-marker";

function entry(command: string) {
  return {
    sessionId: "session-1",
    workspace: "/tmp/workspace",
    command,
    decision: "block" as const,
    reason: "blocked: destructive git operation",
    matchedRule: "git reset --hard",
    userId: "user-1",
  };
}

beforeEach(() => {
  process.env.PAW_AUDIT_DIR = AUDIT_DIR;
  process.env.PAW_AUDIT = "true";
  flushAuditLog();
});

afterAll(() => {
  flushAuditLog();
  rmSync(AUDIT_DIR, { recursive: true, force: true });
  delete process.env.PAW_AUDIT;
  delete process.env.PAW_AUDIT_DIR;
});

describe("shell audit log", () => {
  test("buffers the entry in memory and fills the timestamp itself", () => {
    logShellAudit(entry(MARKER));
    const pending = getPendingAuditEntries();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.command).toBe(MARKER);
    expect(pending[0]?.sessionId).toBe("session-1");
    expect(pending[0]?.decision).toBe("block");
    // timestamp 不接受调用方传入，由 logShellAudit 自己填
    expect(Number.isNaN(Date.parse(pending[0]?.timestamp ?? ""))).toBe(false);
  });

  test("flushAuditLog drains the buffer", () => {
    logShellAudit(entry(MARKER));
    expect(getPendingAuditEntries().length).toBeGreaterThan(0);
    flushAuditLog();
    expect(getPendingAuditEntries()).toHaveLength(0);
  });

  test("flush writes the buffered entry to the audit directory", async () => {
    logShellAudit(entry(MARKER));
    flushAuditLog();
    // 写盘走的是 fs 写流：`flushAuditLog` 里的 `_writer.end()` 之后内容才落盘，
    // 所以这里必须让出一个 tick 再读，否则读到的是空文件。
    await Bun.sleep(50);
    const files = readdirSync(AUDIT_DIR);
    expect(files.length).toBeGreaterThan(0);
    const combined = files.map((f) => readFileSync(join(AUDIT_DIR, f), "utf8")).join("\n");
    expect(combined).toContain(MARKER);
    expect(combined).toContain("blocked: destructive git operation");
  });

  test("PAW_AUDIT=false makes logging a no-op", () => {
    const readAll = () =>
      readdirSync(AUDIT_DIR)
        .map((f) => readFileSync(join(AUDIT_DIR, f), "utf8"))
        .join("\n");
    const before = readAll();

    process.env.PAW_AUDIT = "false";
    logShellAudit(entry(`${MARKER}-disabled`));
    expect(getPendingAuditEntries()).toHaveLength(0);
    flushAuditLog();

    // 关闭审计时磁盘内容完全不变（不是"没找到某个字符串"那种空断言）
    expect(readAll()).toBe(before);
    expect(readAll()).not.toContain(`${MARKER}-disabled`);
  });
});
