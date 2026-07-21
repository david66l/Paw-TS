import { describe, expect, it } from "bun:test";

import {
  buildConversationAwareQuery,
  cleanMemoryTitle,
  extractExplicitRememberText,
  hasDurableMemorySignal,
  isLowValueChitchat,
  isSystemFinalizeMessage,
  isWorthWritingLongTermMemory,
  shouldWriteTaskSummary,
  tokenizeForMemoryScore,
} from "../src/shared/memory-quality.js";
import { applyTypeQuotas } from "../src/db/modules/read/memoryRetriever.js";
import type { MemoryItem } from "../src/db/types.js";
import { extractCleanMemoryQuery } from "../src/shared/memory-query.js";

describe("isLowValueChitchat", () => {
  it("flags pure greetings", () => {
    expect(isLowValueChitchat("hi")).toBe(true);
    expect(isLowValueChitchat("hello")).toBe(true);
    expect(isLowValueChitchat("你好")).toBe(true);
    expect(isLowValueChitchat("谢谢")).toBe(true);
    expect(isLowValueChitchat("ok")).toBe(true);
  });

  it("keeps durable or technical asks", () => {
    expect(isLowValueChitchat("记住以后用 vitest")).toBe(false);
    expect(isLowValueChitchat("Add Redis caching to auth")).toBe(false);
    expect(isLowValueChitchat("修复 packages/agent 的类型错误")).toBe(false);
  });
});

describe("isWorthWritingLongTermMemory", () => {
  it("skips empty chitchat sessions", () => {
    expect(
      isWorthWritingLongTermMemory({
        goal: "hello",
        completedSteps: [],
        executedTools: [],
        modifiedFiles: [],
      }),
    ).toBe(false);
  });

  it("writes when durable remember signal", () => {
    expect(
      isWorthWritingLongTermMemory({
        goal: "记住以后测试用 vitest，不要用 jest",
        completedSteps: [],
        executedTools: [],
      }),
    ).toBe(true);
  });

  it("does not treat ephemeral remember-as-game as durable write", () => {
    expect(
      isWorthWritingLongTermMemory({
        goal: "不要调用工具。请记住一个暗号词：蓝鲸。只回复：已记下",
        completedSteps: [],
        executedTools: [],
      }),
    ).toBe(false);
    expect(
      hasDurableMemorySignal(
        "不要调用工具。请记住一个暗号词：蓝鲸。只回复：已记下",
      ),
    ).toBe(false);
  });

  it("writes when files modified", () => {
    expect(
      isWorthWritingLongTermMemory({
        goal: "hi",
        modifiedFiles: [{ filePath: "src/a.ts" }],
      }),
    ).toBe(true);
  });

  it("writes on tool failure", () => {
    expect(
      isWorthWritingLongTermMemory({
        goal: "run tests",
        executedTools: [
          { toolName: "workspace.run_shell", status: "failure", summary: "fail" },
        ],
      }),
    ).toBe(true);
  });

  it("ignores system finalize steps alone", () => {
    expect(
      isWorthWritingLongTermMemory({
        goal: "hello",
        completedSteps: [{ summary: "desktop conversation ended" }],
        executedTools: [],
      }),
    ).toBe(false);
  });

  it("skips pure read-only sessions without durable signal", () => {
    expect(
      isWorthWritingLongTermMemory({
        goal: "请用工具读取 packages/memory/package.json 并简述 name",
        readFiles: [{ filePath: "packages/memory/package.json" }],
        executedTools: [
          {
            toolName: "workspace.read_file",
            status: "success",
            summary: "ok",
          },
        ],
        modifiedFiles: [],
        completedSteps: [],
      }),
    ).toBe(false);
  });
});

describe("shouldWriteTaskSummary", () => {
  it("false for read-only", () => {
    expect(
      shouldWriteTaskSummary({
        goal: "read package.json",
        readFiles: [{ filePath: "package.json" }],
        executedTools: [
          { toolName: "workspace.read_file", status: "success" },
        ],
      }),
    ).toBe(false);
  });

  it("true when files modified", () => {
    expect(
      shouldWriteTaskSummary({
        goal: "edit",
        modifiedFiles: [{ filePath: "a.ts" }],
      }),
    ).toBe(true);
  });

  it("true on decision step", () => {
    expect(
      shouldWriteTaskSummary({
        goal: "choose client",
        completedSteps: [{ summary: "Decided to use ioredis for Redis" }],
      }),
    ).toBe(true);
  });
});

describe("tokenizeForMemoryScore", () => {
  it("splits english words", () => {
    const t = tokenizeForMemoryScore("Redis caching for auth service");
    expect(t).toContain("redis");
    expect(t).toContain("caching");
    expect(t).toContain("auth");
  });

  it("splits chinese into bigrams", () => {
    const t = tokenizeForMemoryScore("添加缓存到认证服务");
    expect(t.some((x) => x.includes("缓存") || x === "缓存")).toBe(true);
    expect(t.length).toBeGreaterThan(2);
  });
});

describe("buildConversationAwareQuery", () => {
  it("extracts current request after marker", () => {
    const goal = [
      "[Conversation so far — context only.]",
      "User: 记住以后用 vitest",
      "Assistant: 好的",
      "",
      "[Current user request]",
      "继续改 auth 缓存",
    ].join("\n");
    expect(extractCleanMemoryQuery(goal)).toBe("继续改 auth 缓存");
    const q = buildConversationAwareQuery(goal);
    expect(q).toContain("继续改 auth 缓存");
    // history durable signal should contribute
    expect(/vitest/i.test(q)).toBe(true);
  });

  it("includes file paths from history", () => {
    const goal = [
      "User: look at packages/agent/src/orchestrator.ts",
      "[Current user request]",
      "fix the bug",
    ].join("\n");
    const q = buildConversationAwareQuery(goal);
    expect(q).toContain("orchestrator.ts");
  });
});

describe("cleanMemoryTitle / finalize markers", () => {
  it("cleans multi-turn goal for title", () => {
    const goal =
      "User: a\nAssistant: b\n\n[Current user request]\nPrefer ioredis for Redis";
    expect(cleanMemoryTitle(goal)).toBe("Prefer ioredis for Redis");
  });

  it("detects system finalize messages", () => {
    expect(isSystemFinalizeMessage("desktop: new conversation")).toBe(true);
    expect(isSystemFinalizeMessage("desktop conversation ended")).toBe(true);
    expect(isSystemFinalizeMessage("Decided to use ioredis")).toBe(false);
  });

  it("detects durable signals", () => {
    expect(hasDurableMemorySignal("always use vitest")).toBe(true);
    expect(hasDurableMemorySignal("记住以后用 ioredis")).toBe(true);
    expect(hasDurableMemorySignal("hello")).toBe(false);
    expect(hasDurableMemorySignal("记住暗号词蓝鲸")).toBe(false);
  });
});

describe("extractExplicitRememberText", () => {
  it("extracts durable remember", () => {
    const t = extractExplicitRememberText("记住以后单测用 vitest");
    expect(t).toBeTruthy();
    expect(t!).toMatch(/vitest/i);
  });

  it("rejects ephemeral and chitchat", () => {
    expect(extractExplicitRememberText("记住暗号词蓝鲸")).toBeNull();
    expect(extractExplicitRememberText("hello")).toBeNull();
    expect(
      extractExplicitRememberText(
        "不要调用工具。请记住一个暗号词：蓝鲸。只回复：已记下",
      ),
    ).toBeNull();
  });
});

describe("applyTypeQuotas", () => {
  it("caps task_summary and prefers preferences", () => {
    const mk = (type: string, id: string, score: number) =>
      ({
        memory: { id, type, title: id, summary: id } as MemoryItem,
        score,
        matchReasons: [],
      });
    const ranked = [
      mk("task_summary", "t1", 0.9),
      mk("task_summary", "t2", 0.85),
      mk("user_preference", "p1", 0.8),
      mk("user_preference", "p2", 0.7),
      mk("user_preference", "p3", 0.6),
      mk("user_preference", "p4", 0.5),
      mk("decision", "d1", 0.4),
    ];
    const out = applyTypeQuotas(ranked, 6);
    expect(out.filter((x) => x.memory.type === "task_summary")).toHaveLength(1);
    expect(out.filter((x) => x.memory.type === "user_preference").length).toBeLessThanOrEqual(3);
    expect(out.length).toBeLessThanOrEqual(6);
  });
});
