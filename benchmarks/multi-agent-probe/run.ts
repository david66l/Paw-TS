/**
 * Multi-agent architecture probe vs real GitHub clone (pgilad/leasot).
 *
 * bun run benchmarks/multi-agent-probe/run.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runStubRun } from "../../packages/agent/src/stub-run.ts";

const workspaceRoot = path.resolve("E:/A_Louis/paw-multiagent-probe/leasot");
const outDir = path.resolve("E:/A_Louis/paw-multiagent-probe/runs");
mkdirSync(outDir, { recursive: true });

const goal = `你是狸花（总控调度 Agent）。工作区是 GitHub 开源项目 leasot（https://github.com/pgilad/leasot）：从源码注释解析 TODO/FIXME。

【任务】把 HACK 提升为一等内置标签（与 TODO/FIXME 同级，进入 DEFAULT_TAGS），并补测试。

【多 Agent 硬性规则】
1. 你必须使用 workspace.run_agent，且必须传 agent_id（花名册：xianluo 调研、bianmu/demu/samo 实现、keji 审查、buou 测试、jinmao 文档）。
2. 你本人禁止调用 write_file / edit_file / apply_patch；写代码必须交给编码犬（bianmu 等）。
3. 至少调度 2 个不同的 agent_id（建议：先实现再用 keji 或 buou 验收）。
4. 最终必须用项目的 npm test（或等价）跑通相关测试，有通过证据后再 final_answer。

【验收】
- DEFAULT_TAGS（或等价默认标签列表）包含 HACK
- 有覆盖 HACK 的测试且通过
- 不破坏现有 TODO/FIXME 行为
- 用中文简要汇报：调度了谁、改了哪些文件、测试结果`;

const events: Array<Record<string, unknown>> = [];
const toolCalls: Array<{ tool: string; args?: unknown; callId?: string }> = [];
const toolResults: Array<{ tool: string; ok: boolean; summary?: string }> = [];
const childEvents: Array<{ type: string; agentId?: string; goal?: string }> = [];

const t0 = Date.now();
const r = await runStubRun(goal, {
  workspaceRoot,
  maxSteps: 48,
  autonomy: "headless",
  onEvent: (env) => {
    const e = env.event as Record<string, unknown>;
    const type = String(e.type ?? "");
    events.push({ seq: env.seq, type, ts: env.ts });
    if (type === "tool.call") {
      toolCalls.push({
        tool: String(e.tool ?? ""),
        args: e.args,
        callId: e.callId ? String(e.callId) : undefined,
      });
    }
    if (type === "tool.result") {
      toolResults.push({
        tool: String(e.tool ?? ""),
        ok: Boolean(e.ok),
        summary:
          typeof e.summary === "string" ? e.summary.slice(0, 240) : undefined,
      });
    }
    if (type.startsWith("child.")) {
      childEvents.push({
        type,
        agentId: e.agentId ? String(e.agentId) : undefined,
        goal: e.goal ? String(e.goal).slice(0, 120) : undefined,
      });
    }
  },
});

const runAgentCalls = toolCalls.filter((c) => c.tool === "workspace.run_agent");
const agentIds = runAgentCalls.map((c) => {
  const args = (c.args ?? {}) as Record<string, unknown>;
  return typeof args.agent_id === "string"
    ? args.agent_id
    : typeof args.agentId === "string"
      ? args.agentId
      : "(none)";
});

const report = {
  workspaceRoot,
  repo: "https://github.com/pgilad/leasot",
  elapsedMs: Date.now() - t0,
  exitCode: r.exitCode,
  resultTextPreview: r.text.slice(0, 4000),
  metrics: {
    eventCount: events.length,
    toolCallCount: toolCalls.length,
    runAgentCount: runAgentCalls.length,
    distinctAgentIds: [...new Set(agentIds)],
    childEventCount: childEvents.length,
    mutatingToolsByParent: toolCalls.filter((c) =>
      [
        "workspace.write_file",
        "workspace.edit_file",
        "workspace.apply_patch",
      ].includes(c.tool),
    ).length,
  },
  runAgentCalls: runAgentCalls.map((c, i) => ({
    i,
    agentId: agentIds[i],
    args: c.args,
  })),
  toolCalls: toolCalls.map((c) => ({ tool: c.tool, callId: c.callId })),
  toolResults: toolResults.slice(0, 80),
  childEvents: childEvents.slice(0, 80),
};

const outPath = path.join(outDir, `leasot-hack-${Date.now()}.json`);
writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");
console.log(
  JSON.stringify({ outPath, metrics: report.metrics, exitCode: r.exitCode }, null, 2),
);
console.log("--- result ---");
console.log(r.text.slice(0, 2500));
