import { describe, expect, test } from "bun:test";

import { ArtifactRegistry, ContextManager, parseArchiveStub } from "@paw/core";
import { CONTEXT_RECALL, executeTool } from "@paw/harness";

import { finalizeToolExecution } from "../src/orchestrator/tool-runner.js";
import {
  createPayloadDeduper,
  truncatePayloadWithOutcome,
} from "../src/orchestrator/truncate-payload.js";

const ROOT = "C:/work/repo";
const RUN_ID = "run-1";

/** 组装一条工具结果注入上下文（P1 入口闸 + P3 归档接线） */
function injectToolResult(opts: {
  tool: string;
  payload: unknown;
  turn: number;
  text?: string;
  registry?: ArtifactRegistry;
  deduper?: ReturnType<typeof createPayloadDeduper>;
}): {
  ctxMgr: ContextManager;
  registry: ArtifactRegistry;
  deduper: ReturnType<typeof createPayloadDeduper>;
  messages: string[];
} {
  const ctxMgr = new ContextManager();
  const registry = opts.registry ?? new ArtifactRegistry();
  registry.startTurn(opts.turn);
  const deduper = opts.deduper ?? createPayloadDeduper();
  finalizeToolExecution(
    [{ type: "tool_call", tool: opts.tool, args: {} }],
    [{ ok: true, payload: opts.payload, summary: `run ${opts.tool}` }],
    {
      ctxMgr,
      emit: () => {},
      runId: RUN_ID,
      workspaceRoot: ROOT,
      turn: opts.turn,
      maxSteps: 30,
      specGoal: "test",
      text: opts.text ?? `{"tool":"${opts.tool}","args":{}}`,
      saveStateFn: () => {},
      payloadDeduper: deduper,
      artifactRegistry: registry,
    },
  );
  return {
    ctxMgr,
    registry,
    deduper,
    messages: ctxMgr.buildMessages().map((m) => m.content),
  };
}

describe("P3 冷库接线 — 截断 → 归档 → context.recall", () => {
  test("AC-P3-10 截断发生时全文归档 + 引用桩注入（含 id）", () => {
    const big = `head-line\n${"noise\n".repeat(30_000)}tail-line`; // ~150KB
    const { messages, registry } = injectToolResult({
      tool: "workspace.run_shell",
      payload: big,
      turn: 3,
    });
    const toolMsg = messages.find((m) => m.includes("[Tool workspace.run_shell"))!;
    expect(toolMsg).toBeDefined();
    // 截断预览（头尾）+ 引用桩
    expect(toolMsg).toContain("[truncated");
    expect(toolMsg).toContain("[archived id=1");
    const stub = parseArchiveStub(toolMsg);
    expect(stub?.tool).toBe("workspace.run_shell");
    expect(stub?.size).toBe(big.length);
    // 全文在注册表（可寻址恢复）
    expect(registry.get(stub!.id)?.content).toBe(big);
  });

  test("AC-P1-7/AC-P3-12 recall 取回全文（needle 恢复）", async () => {
    const needle = "THE_NEEDLE_IS_HERE_42";
    // needle 埋在输出尾部（错误/exit code 常见位置）：tail 窗口取回即可命中
    const big = `${"filler\n".repeat(20_000)}${needle}\nfinal`;
    const { messages, registry } = injectToolResult({
      tool: "workspace.run_shell",
      payload: big,
      turn: 5,
    });
    const stub = parseArchiveStub(messages.join("\n"));
    expect(stub).not.toBeNull();

    // 通过 harness context.recall 工具取回（tail 窗口）
    registry.startTurn(6);
    const r = await executeTool(
      { workspaceRoot: ROOT, artifactRegistry: registry },
      CONTEXT_RECALL,
      { id: stub!.id, part: "tail" },
    );
    expect(r.ok).toBe(true);
    const text = String(r.payload);
    expect(text).toContain(needle);
    expect(text).toContain(`id=${stub!.id}`);
    // Cited 契约：recall 过的 id 不可驱逐
    expect(registry.isCited(stub!.id)).toBe(true);
  });

  test("AC-P3-4 recall 超限：无效 id → 候选列表；每轮 ≤2 次", async () => {
    const { messages, registry } = injectToolResult({
      tool: "workspace.run_shell",
      // >40K 触发截断 → 归档 → 产生引用桩
      payload: "unique content abc123\n" + "x".repeat(50_000),
      turn: 1,
    });
    const stub = parseArchiveStub(messages.join("\n"));
    expect(stub).not.toBeNull();

    registry.startTurn(2);
    // 无效 ID → 转关键词检索返回候选（不静默失败）
    const miss = await executeTool(
      { workspaceRoot: ROOT, artifactRegistry: registry },
      CONTEXT_RECALL,
      { id: "99999" },
    );
    expect(miss.ok).toBe(false);
    const missPayload = miss.payload as { candidates?: unknown[]; error: string };
    expect(missPayload.error).toContain("no archived artifact");
    expect(missPayload.candidates?.length).toBeGreaterThan(0);

    // 每轮 ≤2 次：第 3 次被预算拒绝
    registry.startTurn(2);
    await executeTool(
      { workspaceRoot: ROOT, artifactRegistry: registry },
      CONTEXT_RECALL,
      { id: stub!.id },
    );
    await executeTool(
      { workspaceRoot: ROOT, artifactRegistry: registry },
      CONTEXT_RECALL,
      { id: stub!.id },
    );
    const third = await executeTool(
      { workspaceRoot: ROOT, artifactRegistry: registry },
      CONTEXT_RECALL,
      { id: stub!.id },
    );
    expect(third.ok).toBe(false);
    expect(JSON.stringify(third.payload)).toContain("budget");
  });

  test("AC-P3-6 超长取回分块：head / tail / chunk 窗口正确", async () => {
    const registry = new ArtifactRegistry();
    const content = "ABCDEFGHIJ".repeat(2_500); // 25K
    const id = registry.store(content, {
      tool: "workspace.run_shell",
      ok: true,
      turn: 1,
    })!;
    registry.startTurn(2);
    const head = await executeTool(
      { workspaceRoot: ROOT, artifactRegistry: registry },
      CONTEXT_RECALL,
      { id, part: "head", limit: 8_000 },
    );
    expect(String(head.payload)).toContain("ABCDEFGHIJ");
    registry.startTurn(3);
    const tail = await executeTool(
      { workspaceRoot: ROOT, artifactRegistry: registry },
      CONTEXT_RECALL,
      { id, part: "tail", limit: 8_000 },
    );
    const tailText = String(tail.payload);
    expect(tailText.slice(0, 200)).toContain("[window tail");
    expect(tailText).toContain("total=25000");
  });

  test("AC-P3-1 去重后引用桩链接到同一归档 id", () => {
    // >40K：既参与去重（≥2K）又触发截断归档
    const content = "repeat-me\n".repeat(6_000); // 60K
    const a = injectToolResult({ tool: "workspace.run_shell", payload: content, turn: 1 });
    const b = injectToolResult({
      tool: "workspace.run_shell",
      payload: content,
      turn: 4,
      registry: a.registry,
      deduper: a.deduper,
    });
    // 第二次出现：repeat 标记 + 归档 stub（同一 id）
    const msgs = b.messages.join("\n");
    expect(msgs).toContain("[repeat of #");
    const stubs = [...msgs.matchAll(/\[archived id=(\d+)/g)].map((m) => m[1]);
    expect(stubs.length).toBe(1);
    expect(stubs[0]).toBe("1");
  });

  test("read 类工具永不截断 → 不归档（原文注入）", () => {
    const big = "x".repeat(100_000);
    const { messages, registry } = injectToolResult({
      tool: "workspace.read_file",
      payload: big,
      turn: 1,
    });
    expect(messages.join("\n")).toContain(big);
    expect(messages.join("\n")).not.toContain("[archived");
    expect(registry.size).toBe(0);
  });

  test("truncatePayloadWithOutcome：截断标记 fullText 与归档一致", () => {
    const big = "y".repeat(60_000);
    const outcome = truncatePayloadWithOutcome(big, "workspace.run_shell");
    expect(outcome.truncated).toBe(true);
    expect(outcome.fullText).toBe(big);
    const small = "ok";
    expect(truncatePayloadWithOutcome(small, "workspace.run_shell").truncated).toBe(false);
  });
});
