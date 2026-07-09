/**
 * Memory health check unit tests.
 * DB 相关用例需要 Postgres；file 模式不依赖 DB。
 */

import { describe, expect, test } from "bun:test";
import {
  checkMemoryHealth,
  resolveMemoryBackendFromSettings,
} from "../src/runtime/health.js";

describe("resolveMemoryBackendFromSettings", () => {
  test("defaults to db", () => {
    const prev = process.env.PAW_MEMORY_BACKEND;
    delete process.env.PAW_MEMORY_BACKEND;
    expect(resolveMemoryBackendFromSettings(undefined)).toBe("db");
    expect(resolveMemoryBackendFromSettings({})).toBe("db");
    expect(resolveMemoryBackendFromSettings({ memory_backend: "db" })).toBe(
      "db",
    );
    if (prev !== undefined) process.env.PAW_MEMORY_BACKEND = prev;
  });

  test("PAW_MEMORY_BACKEND=file still resolves for doctor only", () => {
    const prev = process.env.PAW_MEMORY_BACKEND;
    process.env.PAW_MEMORY_BACKEND = "file";
    expect(resolveMemoryBackendFromSettings({})).toBe("file");
    if (prev !== undefined) process.env.PAW_MEMORY_BACKEND = prev;
    else delete process.env.PAW_MEMORY_BACKEND;
  });
});

describe("checkMemoryHealth", () => {
  test("file backend is always ok without Postgres", async () => {
    const report = await checkMemoryHealth({
      backend: "file",
      closeConnection: true,
    });
    expect(report.backend).toBe("file");
    expect(report.ok).toBe(true);
    expect(report.messages.some((m) => m.includes("file"))).toBe(true);
  });

  test("db backend reports ping and migrations when DATABASE_URL works", async () => {
    process.env.DATABASE_URL =
      process.env.DATABASE_URL ?? "postgresql:///paw_memory_test";
    const report = await checkMemoryHealth({
      backend: "db",
      closeConnection: true,
    });
    expect(report.backend).toBe("db");
    // 本地有 test DB 时应 ok；无 DB 时至少有 messages
    expect(report.messages.length).toBeGreaterThan(0);
    if (report.pingOk) {
      expect(report.totalMigrations).toBeGreaterThan(0);
    }
  });
});
