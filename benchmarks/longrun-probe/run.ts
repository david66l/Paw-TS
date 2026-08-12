/**
 * Long-flow TaskLifecycle probe: build a multi-package JobQueue monorepo from REQUIREMENTS.md
 *
 * bun run benchmarks/longrun-probe/run.ts
 */
import { mkdirSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runStubRun } from "../../packages/agent/src/stub-run.ts";

const workspaceRoot = path.resolve("E:/A_Louis/paw-longrun-probe/jobqueue");
const outDir = path.resolve("E:/A_Louis/paw-longrun-probe/runs");
mkdirSync(outDir, { recursive: true });

const goal = `阅读工作区根目录 REQUIREMENTS.md，从零实现完整的 TypeScript ESM monorepo JobQueue。

硬性要求：
1. 按文档实现 packages/core、packages/persist、packages/cli 与根 workspace
2. 必须有可运行的根级测试命令，且最终测试通过（不要用 [skip_verify] 糊弄）
3. CLI 至少能 enqueue / list / run-once（可用相对简单实现，但要真实可用）
4. 这是长流程任务：先规划再分阶段落地；可按需使用 workspace.run_agent 调度花名册 Agent，但质量与测试通过优先
5. 未完成或测试失败时不要假装完成；只有验收通过再 final_answer

最终用中文汇报：目录结构、如何跑测试、CLI 用法、还缺什么。`;

const events: Array<{ type: string; turn?: number }> = [];
const toolCalls: string[] = [];
const phases: string[] = [];
let maxTurn = 0;
let loopTicks = 0;

const t0 = Date.now();
const r = await runStubRun(goal, {
  workspaceRoot,
  maxSteps: 72,
  autonomy: "headless",
  onEvent: (env) => {
    const e = env.event as Record<string, unknown>;
    const type = String(e.type ?? "");
    events.push({ type });
    if (type === "loop.tick") {
      loopTicks += 1;
      const turn = Number(e.turn ?? 0);
      if (Number.isFinite(turn)) maxTurn = Math.max(maxTurn, turn);
    }
    if (type === "tool.call") toolCalls.push(String(e.tool ?? ""));
    if (type === "phase") phases.push(String(e.name ?? ""));
  },
});

function walkFiles(dir: string, acc: string[] = [], depth = 0): string[] {
  if (depth > 6 || !existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".paw" || name === ".git") continue;
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkFiles(p, acc, depth + 1);
    else acc.push(path.relative(workspaceRoot, p).replaceAll("\\", "/"));
  }
  return acc;
}

const produced = walkFiles(workspaceRoot).filter((f) => f !== "REQUIREMENTS.md");

// Independent verification attempts
const verifyCmds = [
  ["npm", ["test"]],
  ["bun", ["test"]],
  ["npm", ["run", "test"]],
];
const verifyResults: Array<{ cmd: string; ok: boolean; out: string }> = [];
for (const [bin, args] of verifyCmds) {
  const res = spawnSync(bin, args, {
    cwd: workspaceRoot,
    encoding: "utf8",
    shell: true,
    timeout: 120_000,
  });
  const out = `${res.stdout ?? ""}\n${res.stderr ?? ""}`.slice(0, 2000);
  verifyResults.push({
    cmd: `${bin} ${args.join(" ")}`,
    ok: res.status === 0,
    out,
  });
  if (res.status === 0) break;
}

let resultJson: Record<string, unknown> = {};
try {
  resultJson = JSON.parse(r.text) as Record<string, unknown>;
} catch {
  resultJson = { raw: r.text.slice(0, 3000) };
}

const report = {
  workspaceRoot,
  task: "JobQueue monorepo from REQUIREMENTS.md",
  elapsedMs: Date.now() - t0,
  exitCode: r.exitCode,
  metrics: {
    eventCount: events.length,
    loopTicks,
    maxTurn,
    toolCallCount: toolCalls.length,
    runAgentCount: toolCalls.filter((t) => t === "workspace.run_agent").length,
    writeCount: toolCalls.filter((t) =>
      ["workspace.write_file", "workspace.edit_file", "workspace.apply_patch"].includes(t),
    ).length,
    shellCount: toolCalls.filter((t) => t === "workspace.run_shell").length,
    uniqueTools: [...new Set(toolCalls)],
    phases: [...new Set(phases)],
  },
  runResult: {
    status: resultJson.status,
    outcome: resultJson.outcome,
    completionReason: resultJson.completionReason,
    messagePreview:
      typeof resultJson.message === "string"
        ? resultJson.message.slice(0, 2500)
        : undefined,
    evidence: resultJson.evidence,
  },
  producedFiles: produced,
  independentVerify: verifyResults,
};

const outPath = path.join(outDir, `jobqueue-${Date.now()}.json`);
writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify({ outPath, metrics: report.metrics, runResult: report.runResult, verify: verifyResults.map((v) => ({ cmd: v.cmd, ok: v.ok })), exitCode: r.exitCode, fileCount: produced.length }, null, 2));
