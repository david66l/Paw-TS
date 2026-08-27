/**
 * 多 Agent 小断点包 —— 回归测试
 * ================================================================
 * 覆盖 5 个已修断点，防止回退：
 * 1. 子 Agent runId 为 `child-<parentRunId>-<i>`，不再是 `sub-${Date.now()}` 占位符
 * 2. 子 Agent trace.messages 非空（独立 ContextManager 回填完整对话）
 * 3. Spec 路径合并父级 constraints / state（用户 must/never 约束不再被丢弃）
 * 4. root Spec 的 maxSteps 经工厂（rootMaxSteps）与 PersistentSession 传递
 * 5. 文档不再引用不存在的 `registerFromPath`（真实 API：register + writeAgentFile + reload）
 */

import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { ChatMessage, LanguageModel } from "@paw/models";
import { AgentRegistry } from "../src/agents/registry.js";
import { writeAgentFile } from "../src/agents/write.js";
import { createRunOrchestrator } from "../src/orchestrator-factory.js";
import { AgentOrchestrator } from "../src/orchestrator.js";
import { createPersistentSession } from "../src/session.js";
import { DefaultSubAgentLauncher } from "../src/sub-agent-launcher.js";
import { cleanup, tmpDir, writeFileMemorySettings } from "./fixtures.js";

const tmpRoots: string[] = [];

afterEach(() => {
  for (const d of tmpRoots.splice(0)) cleanup(d);
});

function ws(prefix: string): string {
  const d = tmpDir(prefix);
  tmpRoots.push(d);
  return d;
}

function makeFakeModel(sequence: string[] = []): LanguageModel {
  let idx = 0;
  return {
    label: "fake",
    capabilities: { contextWindow: 128_000 },
    async complete() {
      const text =
        sequence[idx] ?? '{"action":"final_answer","summary":"done"}';
      idx += 1;
      return { text, finishReason: "stop" };
    },
  };
}

// ─────────────────────────────────────────────────────────────
// 1. 子 Agent runId 与 AgentGroup child id 格式一致
// ─────────────────────────────────────────────────────────────

describe("断点1: subResults runId 占位符", () => {
  it("子 Agent agentId 为 child-<parentRunId>-<i>", async () => {
    const dir = ws("paw-fix-runid-");

    const parentModel = makeFakeModel([
      '{"tool":"workspace.run_agent","args":{"goal":"task A"}}\n{"tool":"workspace.run_agent","args":{"goal":"task B"}}',
      '{"action":"final_answer","summary":"parent done"}',
    ]);

    const seenAgentIds: string[] = [];
    const seenParentRunIds: string[] = [];
    const fakeLauncher = {
      async launch() {
        throw new Error("orchestrator 路径应走 launchStreaming");
      },
      async launchStreaming(options: {
        parentRunId: string;
        agentId: string;
      }) {
        seenParentRunIds.push(options.parentRunId);
        seenAgentIds.push(options.agentId);
        return {
          status: "completed" as const,
          summary: "child ok",
          trace: { messages: [], events: [], stepsTaken: 1 },
        };
      },
    };

    const orch = new AgentOrchestrator({
      model: parentModel,
      subAgentLauncher: fakeLauncher,
    });
    const result = await orch.run({
      runId: "runX",
      goal: "delegate",
      workspaceRoot: dir,
      maxSteps: 4,
    });

    expect(result.status).toBe("completed");
    expect(seenParentRunIds).toEqual(["runX", "runX"]);
    expect(seenAgentIds).toEqual(["child-runX-0", "child-runX-1"]);
    // 不再是 Date.now() 占位符格式
    for (const id of seenAgentIds) {
      expect(id.startsWith("sub-")).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────
// 2. 子 Agent trace.messages 非空
// ─────────────────────────────────────────────────────────────

describe("断点2: trace.messages 恒空", () => {
  it("launchStreaming 结束后 trace.messages 含完整对话（system + user + assistant）", async () => {
    const dir = ws("paw-fix-trace-");
    const launcher = new DefaultSubAgentLauncher({
      workspaceRoot: dir,
      model: makeFakeModel(['{"action":"final_answer","summary":"child done"}']),
      maxSteps: 3,
    });

    const result = await launcher.launchStreaming({
      goal: "调查内存泄漏",
      parentRunId: "p1",
      agentId: "child-p1-0",
      onEvent: () => {},
    });

    expect(result.status).toBe("completed");
    // 修复前硬编码 messages: []；现在应含 system prompt + 用户目标
    const messages = result.trace?.messages ?? [];
    expect(messages.length).toBeGreaterThanOrEqual(2);
    expect(messages[0]!.role).toBe("system");
    expect(messages[0]!.content.length).toBeGreaterThan(0);
    expect(
      messages.some((m) => m.role === "user" && m.content.includes("调查内存泄漏")),
    ).toBe(true);
    // 最终答复经 result.summary 返回（final_answer 不落 messages）
    expect(result.summary).toBe("child done");
  });
});

// ─────────────────────────────────────────────────────────────
// 3. Spec 路径合并父级 constraints / state
// ─────────────────────────────────────────────────────────────

describe("断点3: Spec 路径丢弃父级 constraints/state", () => {
  it("父级上下文合入首条 user task envelope 且不污染稳定 system", async () => {
    const dir = ws("paw-fix-constraints-");
    writeFileMemorySettings(dir);

    // 落盘一个 worker Spec（launcher 每次 spawn 前会 reload 注册表）
    const wr = writeAgentFile(
      dir,
      {
        id: "worker1",
        name: "测试工",
        prompt: "你是测试工人。",
        kind: "worker",
        canSpawn: false,
      },
      { overwrite: true },
    );
    expect(wr.ok).toBe(true);

    const launcher = new DefaultSubAgentLauncher({
      workspaceRoot: dir,
      model: makeFakeModel(),
      maxSteps: 3,
      agentRegistry: new AgentRegistry(dir),
    });

    const result = await launcher.launchStreaming({
      goal: "执行子任务",
      parentRunId: "p2",
      agentId: "child-p2-0",
      onEvent: () => {},
      args: { agent_id: "worker1" },
      sharedContext: {
        role: "父总控",
        task: "父任务",
        facts: ["fact-from-parent"],
        constraints: ["NEVER touch production DB"],
        artifacts: [],
        state: { completed: ["step-1 已完成"], pending: ["step-2 待办"] },
        outputFormat: "markdown",
      },
    });

    expect(result.status).toBe("completed");
    const systemMsg = result.trace?.messages?.find((m) => m.role === "system");
    const firstUserMsg = result.trace?.messages?.find((m) => m.role === "user");
    expect(systemMsg).toBeDefined();
    expect(firstUserMsg).toBeDefined();
    const sys = systemMsg?.content ?? "";
    const task = firstUserMsg?.content ?? "";
    expect(task).toStartWith(
      '<paw-subagent-task schema="paw.subagent-task.v1">',
    );
    // 父级约束合入（修复前会被 Spec 物化整体覆盖丢弃）
    expect(task).toContain("NEVER touch production DB");
    // Spec 自带安全约束仍在
    expect(task).toContain("Do not modify files outside the workspace.");
    // 父级进度状态合入
    expect(task).toContain("step-1 已完成");
    expect(task).toContain("step-2 待办");
    // 父级 facts 合入
    expect(task).toContain("fact-from-parent");
    // 动态父级上下文不得进入 provider-visible system 前缀
    expect(sys).not.toContain("NEVER touch production DB");
    expect(sys).not.toContain("step-1 已完成");
    expect(sys).not.toContain("fact-from-parent");
  });

  it("恢复旧 child checkpoint 时重建 v1 task envelope", async () => {
    const dir = ws("paw-fix-child-resume-");
    let providerMessages: readonly ChatMessage[] = [];
    const sharedContext = {
      role: "恢复调查员",
      task: "恢复后继续定位故障",
      facts: ["legacy-system-only-fact"],
      constraints: ["NEVER lose the delegated constraint"],
      artifacts: [],
      state: { completed: [], pending: ["继续检查日志"] },
      outputFormat: "返回结论",
    } as const;
    const orch = new AgentOrchestrator({
      model: makeFakeModel(),
      runMode: "child",
      sharedContext,
      memoryExtraction: "off",
      evalHooks: {
        beforeModelCall: ({ messages }) => {
          providerMessages = messages;
        },
      },
    });

    const result = await orch.run({
      runId: "legacy-child-resume",
      goal: "恢复后继续定位故障",
      workspaceRoot: dir,
      maxSteps: 2,
      resumeFromState: {
        runId: "legacy-child-resume",
        goal: "恢复后继续定位故障",
        workspaceRoot: dir,
        turn: 1,
        maxSteps: 2,
        savedAt: Date.now(),
        messages: [
          {
            role: "system",
            content:
              "old child system containing legacy-system-only-fact and task context",
          },
          { role: "user", content: "legacy raw goal" },
          { role: "assistant", content: "partial investigation" },
        ],
      },
    });

    expect(result.status).toBe("completed");
    const system = providerMessages.find((m) => m.role === "system");
    const users = providerMessages.filter((m) => m.role === "user");
    expect(system?.content).not.toContain("legacy-system-only-fact");
    expect(users[0]?.content).toStartWith(
      '<paw-subagent-task schema="paw.subagent-task.v1">',
    );
    expect(users[0]?.content).toContain("legacy-system-only-fact");
    expect(users[0]?.content).toContain("NEVER lose the delegated constraint");
    expect(users[1]?.content).toBe("legacy raw goal");
  });
});

// ─────────────────────────────────────────────────────────────
// 4. root Spec maxSteps 传递（工厂 + PersistentSession）
// ─────────────────────────────────────────────────────────────

const LIHUA_MD_7 = `---
id: lihua
name: 测试狸花
role: 总控
tools: inherit
childPolicy: read_write
model: inherit
canSpawn: true
maxSteps: 7
kind: root
---
测试 root。
`;

function writeLhua(dir: string, md: string): void {
  const agentsDirPath = path.join(dir, ".paw", "agents");
  fs.mkdirSync(agentsDirPath, { recursive: true });
  fs.writeFileSync(path.join(agentsDirPath, "lihua.md"), md, "utf8");
}

describe("断点4: root maxSteps 不生效", () => {
  it("createRunOrchestrator 返回 root Spec 的 rootMaxSteps", () => {
    const dir = ws("paw-fix-maxsteps-");
    writeFileMemorySettings(dir);
    writeLhua(dir, LIHUA_MD_7);

    const run = createRunOrchestrator({
      workspaceRoot: dir,
      collaborationMode: "orchestrated",
    });
    try {
      expect(run.rootMaxSteps).toBe(7);
      expect(run.collaborationMode).toBe("orchestrated");
    } finally {
      run.watcher.stop();
    }
  });

  it("PersistentSession 用 root Spec maxSteps（显式传参优先）", async () => {
    const dir = ws("paw-fix-session-");
    writeFileMemorySettings(dir);
    writeLhua(dir, LIHUA_MD_7);

    const session = createPersistentSession({
      workspaceRoot: dir,
      collaborationMode: "orchestrated",
    });
    try {
      let seen: number | undefined;
      const orch = session.orch as unknown as {
        run: (opts: { maxSteps?: number }) => Promise<{
          status: "completed";
          message: string;
        }>;
      };
      orch.run = (opts) => {
        seen = opts.maxSteps;
        return Promise.resolve({ status: "completed", message: "ok" });
      };
      await session.submit("hi");
      expect(seen).toBe(7);

      // 显式传参优先于 Spec
      const session2 = createPersistentSession({
        workspaceRoot: dir,
        collaborationMode: "orchestrated",
        maxSteps: 3,
      });
      try {
        let seen2: number | undefined;
        const orch2 = session2.orch as unknown as {
          run: (opts: { maxSteps?: number }) => Promise<{
            status: "completed";
            message: string;
          }>;
        };
        orch2.run = (opts) => {
          seen2 = opts.maxSteps;
          return Promise.resolve({ status: "completed", message: "ok" });
        };
        await session2.submit("hi");
        expect(seen2).toBe(3);
      } finally {
        session2.dispose();
      }
    } finally {
      session.dispose();
    }
  });
});

// ─────────────────────────────────────────────────────────────
// 5. registerFromPath 不存在（文档已改为真实 API）
// ─────────────────────────────────────────────────────────────

describe("断点5: 文档中的 registerFromPath", () => {
  it("文档不再引用 registerFromPath，真实 API 为 register/writeAgentFile/reload", () => {
    const docPath = path.join(
      __dirname,
      "..",
      "..",
      "..",
      "docs",
      "agent-registry-note.md",
    );
    expect(fs.existsSync(docPath)).toBe(true);
    const content = fs.readFileSync(docPath, "utf8");
    expect(content).not.toContain("registerFromPath");

    const reg = new AgentRegistry(ws("paw-fix-reg-"));
    expect(typeof reg.register).toBe("function");
    expect(typeof reg.reload).toBe("function");
    expect(typeof writeAgentFile).toBe("function");
    expect(
      (reg as unknown as Record<string, unknown>).registerFromPath,
    ).toBeUndefined();
  });
});
