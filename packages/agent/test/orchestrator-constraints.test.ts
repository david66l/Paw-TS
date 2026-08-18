import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ChatMessage, RunEventEnvelope } from "@paw/core";

import { AgentOrchestrator } from "../src/orchestrator.js";

/** 隔离工作区：自带 .paw 标记，避免 findPawRoot 重定向到用户主目录 */
function isoDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  mkdirSync(path.join(dir, ".paw"), { recursive: true });
  return dir;
}

const finalAnswerModel = {
  label: "final-only",
  capabilities: { contextWindow: 128_000 },
  async complete() {
    return { text: '{"action":"final_answer","summary":"Done."}' };
  },
  async *completeStream() {
    yield { type: "done" as const };
  },
};

/**
 * 约束生命周期集成测试：多轮会话中用户反转意图 →
 * LLM 调和判定 → 旧约束移出红线区，新约束生效。
 */
describe("约束生命周期（Constraint Lifecycle）", () => {
  test("用户反转意图：旧约束 superseded，新约束进入 [Constraints]", async () => {
    const dir = isoDir("paw-lifecycle-");
    const events: RunEventEnvelope[] = [];

    // ── run 1：用户说"不要修改 src/a.txt"（初始约束）──
    const o1 = new AgentOrchestrator({
      model: finalAnswerModel,
      onEvent: (e) => events.push(e),
    });
    const r1 = await o1.run({
      runId: "lc1",
      goal: "不要修改 src/a.txt，只看一下",
      workspaceRoot: dir,
      maxSteps: 1,
    });
    expect(r1.status).toBe("completed");

    // ── run 2：resume + 用户反转："算了，src/a.txt 可以改了，重构它" ──
    const history: ChatMessage[] = [
      { role: "user", content: "不要修改 src/a.txt，只看一下" },
      {
        role: "assistant",
        content: '{"action":"final_answer","summary":"Done."}',
      },
    ];
    const events2: RunEventEnvelope[] = [];
    const hostStates: string[] = [];
    // 第 1 轮调工具、第 2 轮 final；第一轮本身必须看到调和后的约束。
    // 注意：不提供 completeStream（否则走流式路径，mock 的 text 被丢弃）
    const turnModel = {
      label: "cycle",
      capabilities: { contextWindow: 128_000 },
      responses: [
        '{"tool":"workspace.read_file","args":{"path":"a.txt"}}',
        '{"action":"final_answer","summary":"Done."}',
      ] as readonly string[],
      async complete() {
        const text =
          this.responses[0]! ?? '{"action":"final_answer","summary":"Done."}';
        this.responses = this.responses.slice(1);
        return { text };
      },
    };
    const reconcileModel = {
      label: "aux-reconcile",
      capabilities: { contextWindow: 128_000 },
      async complete(messages: readonly ChatMessage[]) {
        const user =
          messages.find((m) => m.role === "user")?.content?.toString() ?? "";
        if (user.includes("Existing active constraints")) {
          // LLM 判定：旧约束被反转 → drop；新约束 add
          return {
            text: '{"keep":[],"drop":[0],"add":[{"text":"重构 src/a.txt 为模块化结构"}]}',
          };
        }
        return { text: "" };
      },
      async *completeStream() {
        yield { type: "done" as const };
      },
    };
    const o2 = new AgentOrchestrator({
      model: turnModel,
      auxiliaryModel: reconcileModel,
      evalHooks: {
        beforeModelCall: ({ messages }) => {
          const pkg = (messages as ChatMessage[]).find((m) =>
            m.content.startsWith("[Host State v1]"),
          );
          if (pkg) hostStates.push(pkg.content);
        },
      },
      onEvent: (e) => events2.push(e),
    });
    const r2 = await o2.run({
      runId: "lc1",
      goal: "算了，src/a.txt 可以改了，重构它",
      workspaceRoot: dir,
      maxSteps: 3,
      resumeFromState: {
        runId: "lc1",
        goal: "不要修改 src/a.txt，只看一下",
        workspaceRoot: dir,
        turn: 1,
        maxSteps: 3,
        savedAt: Date.now(),
        messages: history,
        // 真实 resume 由 saveState 持久化 taskState（含约束记录）
        taskState: {
          goal: "不要修改 src/a.txt，只看一下",
          constraints: [
            {
              text: "不要修改 src/a.txt，只看一下",
              sourceTurn: 0,
              status: "active",
            },
          ],
          plan: [],
          filesRead: [],
          filesChanged: [],
          commandsRun: [],
          testResults: [],
          rejectedHypotheses: [],
          pinnedFacts: [],
          knownNonGoals: [],
          updatedAt: Date.now(),
        },
      },
    });
    expect(r2.status).toBe("completed");

    // 调和事件：旧约束 superseded，新约束 active
    const updated = events2.find(
      (e) => e.event.type === "task.constraints.updated",
    );
    expect(updated?.event.type).toBe("task.constraints.updated");
    if (updated?.event.type === "task.constraints.updated") {
      expect(updated.event.superseded).toContain(
        "不要修改 src/a.txt，只看一下",
      );
      expect(updated.event.active).toContain("重构 src/a.txt 为模块化结构");
    }

    // 同一轮的 HostState（红线区）：旧约束消失，新约束立即进入。
    expect(hostStates[0]).toContain("重构 src/a.txt 为模块化结构");
    expect(hostStates[0]).not.toContain("不要修改 src/a.txt");
  });

  test("LLM 调和故障 → 降级：约束全部保留（不丢红线）", async () => {
    const dir = isoDir("paw-lifecycle-fail-");
    const events: RunEventEnvelope[] = [];
    const failingAux = {
      label: "aux-fail",
      capabilities: { contextWindow: 128_000 },
      async complete() {
        throw new Error("aux down");
      },
      async *completeStream() {
        yield { type: "done" as const };
      },
    };
    const o = new AgentOrchestrator({
      model: finalAnswerModel,
      auxiliaryModel: failingAux,
      onEvent: (e) => events.push(e),
    });
    const r = await o.run({
      runId: "lc2",
      goal: "不要修改 src/a.txt，只看一下",
      workspaceRoot: dir,
      maxSteps: 2,
      resumeFromState: {
        runId: "lc2",
        goal: "算了，改成可以改吧",
        workspaceRoot: dir,
        turn: 1,
        maxSteps: 2,
        savedAt: Date.now(),
        messages: [
          { role: "user", content: "不要修改 src/a.txt，只看一下" },
          { role: "assistant", content: "ok" },
        ],
      },
    });
    expect(r.status).toBe("completed");
    const updated = events.find(
      (e) => e.event.type === "task.constraints.updated",
    );
    expect(updated?.event.type).toBe("task.constraints.updated");
    if (updated?.event.type === "task.constraints.updated") {
      // 降级：ok=false，约束保留（不丢红线）
      expect(updated.event.ok).toBe(false);
      expect(updated.event.active).toContain("不要修改 src/a.txt，只看一下");
    }
  });
});
