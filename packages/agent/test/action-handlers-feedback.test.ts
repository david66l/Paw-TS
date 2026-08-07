import { describe, expect, test } from "bun:test";

import { ContextManager } from "@paw/core";

import {
  type ParseFeedback,
  handleAction,
} from "../src/orchestrator/action-handlers.js";
import type { PhaseContext, TurnFlags } from "../src/orchestrator/types.js";
import type { ParseDiagnosis } from "../src/parse-agent-action.js";

interface RecordedMessage {
  role: "user" | "assistant";
  content: string;
}

function makeCtx(overrides?: {
  turn?: number;
  maxSteps?: number;
}): {
  ctx: PhaseContext;
  ctxMgr: ContextManager;
  messages: RecordedMessage[];
  events: unknown[];
} {
  const messages: RecordedMessage[] = [];
  const events: unknown[] = [];
  const ctxMgr = new ContextManager();
  const originalAddUser = ctxMgr.addUser.bind(ctxMgr);
  ctxMgr.addUser = ((content: string) => {
    messages.push({ role: "user", content });
    originalAddUser(content);
  }) as typeof ctxMgr.addUser;
  const originalAddAssistant = ctxMgr.addAssistant.bind(ctxMgr);
  ctxMgr.addAssistant = ((content: string) => {
    messages.push({ role: "assistant", content });
    originalAddAssistant(content);
  }) as typeof ctxMgr.addAssistant;

  const ctx = {
    runId: "test-run",
    workspaceRoot: "/tmp/paw-test",
    turn: overrides?.turn ?? 0,
    maxSteps: overrides?.maxSteps ?? 10,
    model: undefined,
    toolDefs: [],
    toolNameMap: new Map(),
    ctxMgr,
    planner: undefined,
    taskState: undefined,
    emit: (e: unknown) => events.push(e),
    checkpointSeq: { n: 0 },
    specGoal: "test goal",
  } as unknown as PhaseContext;
  return { ctx, ctxMgr, messages, events };
}

function baseFlags(overrides?: Partial<TurnFlags>): TurnFlags {
  return {
    autoContinueNudges: 0,
    lastTurnHadToolCall: false,
    hasEverUsedTools: true,
    ...overrides,
  };
}

const noopSave = () => {};

describe("handleAction — 格式反馈（文本通道解析失败）", () => {
  test("坏 JSON：注入格式反馈并继续，不降级为 completed", async () => {
    const { ctx, messages } = makeCtx();
    const diagnosis: ParseDiagnosis = {
      kind: "malformed",
      reason: "invalid JSON starting near line 2: Unexpected token",
    };
    const result = await handleAction(
      [],
      [],
      ctx,
      baseFlags(),
      '{"tool":"workspace.read_file","args":{"path": "a.txt"',
      undefined,
      { planner: undefined as never, saveStateFn: noopSave },
      { diagnosis },
    );

    expect(result.state.type).toBe("continue");
    if (result.state.type === "continue") {
      expect(result.state.nextFlags.formatErrorNudges).toBe(1);
      expect(result.state.nextFlags.lastTurnHadToolCall).toBe(false);
    }
    const feedback = messages.find(
      (m) => m.role === "user" && m.content.includes("could not be parsed"),
    );
    expect(feedback).toBeDefined();
    expect(feedback!.content).toContain(
      "Reason: invalid JSON starting near line 2",
    );
    expect(feedback!.content).toContain(
      '{"tool":"workspace.read_file","args":{"path":"<file>"}}',
    );
  });

  test("未知工具名：注入 invalid 反馈并继续", async () => {
    const { ctx, messages } = makeCtx();
    const diagnosis: ParseDiagnosis = {
      kind: "invalid",
      reason: 'unknown tool "workspace.unknown_tool" (available tools: a, b)',
    };
    const result = await handleAction(
      [],
      [],
      ctx,
      baseFlags(),
      '{"tool":"workspace.unknown_tool","args":{}}',
      undefined,
      { planner: undefined as never, saveStateFn: noopSave },
      { diagnosis },
    );

    expect(result.state.type).toBe("continue");
    const feedback = messages.find((m) =>
      m.content.includes("could not be parsed"),
    );
    expect(feedback).toBeDefined();
    expect(feedback!.content).toContain("unknown tool");
  });

  test("纯对话 + 诊断 ok：维持原行为（completed）", async () => {
    const { ctx, events } = makeCtx();
    const result = await handleAction(
      [],
      [],
      ctx,
      baseFlags({ hasEverUsedTools: false }),
      "Just chatting, no tools needed.",
      undefined,
      { planner: undefined as never, saveStateFn: noopSave },
      { diagnosis: { kind: "ok" } },
    );

    expect(result.state.type).toBe("completed");
    expect(
      events.some((e) => (e as { type?: string }).type === "model.done"),
    ).toBe(true);
  });

  test("格式错误连续 2 次后停止重试（防死循环）", async () => {
    const { ctx, messages } = makeCtx();
    const diagnosis: ParseDiagnosis = {
      kind: "malformed",
      reason: "invalid JSON starting near line 2",
    };
    // 已反馈 2 次（达到上限）→ 第三次不再反馈，回退到 auto-nudge
    const result = await handleAction(
      [],
      [],
      ctx,
      baseFlags({ formatErrorNudges: 2 }),
      '{"tool":"workspace.read_file","args":broken',
      undefined,
      { planner: undefined as never, saveStateFn: noopSave },
      { diagnosis },
    );

    expect(result.state.type).toBe("continue");
    const feedback = messages.filter((m) =>
      m.content.includes("could not be parsed"),
    );
    expect(feedback.length).toBe(0);
    if (result.state.type === "continue") {
      expect(result.state.nextFlags.formatErrorNudges).toBe(2);
    }
  });

  test("最后一轮没有预算：格式反馈不再触发，直接完成", async () => {
    const { ctx } = makeCtx({ turn: 9, maxSteps: 10 });
    const diagnosis: ParseDiagnosis = {
      kind: "malformed",
      reason: "invalid JSON starting near line 2",
    };
    const result = await handleAction(
      [],
      [],
      ctx,
      baseFlags(),
      '{"tool":"workspace.read_file","args":broken',
      undefined,
      { planner: undefined as never, saveStateFn: noopSave },
      { diagnosis },
    );

    expect(result.state.type).toBe("completed");
  });
});

describe("handleAction — 原生通道坏 args（拒绝执行 + 错误注入）", () => {
  test("解析失败的调用不执行，错误以工具结果注入并继续", async () => {
    const { ctx, events } = makeCtx();
    const feedback: ParseFeedback = {
      nativeToolErrors: [
        {
          id: "call_1",
          name: "workspace.write_file",
          raw: '{"path": "a.txt", "content": "x}',
        },
      ],
    };
    const result = await handleAction(
      [],
      [],
      ctx,
      baseFlags(),
      "I'll write the file.",
      undefined,
      { planner: undefined as never, saveStateFn: noopSave },
      feedback,
    );

    expect(result.state.type).toBe("continue");
    // 没有 tool.call 事件 → 工具从未被请求执行
    expect(
      events.some((e) => (e as { type?: string }).type === "tool.call"),
    ).toBe(false);
    // 有错误工具结果事件
    const errResults = events.filter(
      (e) =>
        (e as { type?: string }).type === "tool.result" &&
        (e as { ok?: boolean }).ok === false,
    );
    expect(errResults.length).toBe(1);
  });

  test("解析失败 + 最后一轮：降级为 completed", async () => {
    const { ctx } = makeCtx({ turn: 9, maxSteps: 10 });
    const feedback: ParseFeedback = {
      nativeToolErrors: [
        { id: "c1", name: "workspace.write_file", raw: "broken" },
      ],
    };
    const result = await handleAction(
      [],
      [],
      ctx,
      baseFlags(),
      "text",
      undefined,
      { planner: undefined as never, saveStateFn: noopSave },
      feedback,
    );
    expect(result.state.type).toBe("completed");
  });
});
