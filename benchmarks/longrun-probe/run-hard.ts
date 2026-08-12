/**
 * Hard long-flow probe: evolve JobQueue + mid-run requirement pivot (Phase A→B).
 *
 * bun run benchmarks/longrun-probe/run-hard.ts
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runStubRun } from "../../packages/agent/src/stub-run.ts";

const workspaceRoot = path.resolve("E:/A_Louis/paw-longrun-probe/jobqueue");
const outDir = path.resolve("E:/A_Louis/paw-longrun-probe/runs");
mkdirSync(outDir, { recursive: true });

const goal = `这是加压长流程任务。仔细阅读 REQUIREMENTS-HARD.md，在现有 JobQueue monorepo 上演进。

关键纪律：
1. 先按 Phase A 实现，再严格执行 Phase B 的需求变更（B 覆盖 A 的冲突点，不要两套并存）
2. 禁止破坏已有 core/persist/cli 测试；根 npm test 必须最终全绿
3. packages/http 使用 Node 内置 http，不要引入 express/fastify
4. 不要使用 [skip_verify]；测试失败就继续修
5. 可按需调度花名册子 Agent，但正确性优先

完成后用中文汇报 Phase B 最终 API、测试数量、踩过的坑。`;

const toolCalls: string[] = [];
const phases: string[] = [];
let maxTurn = 0;
let loopTicks = 0;
const childStarts: string[] = [];

const t0 = Date.now();
const r = await runStubRun(goal, {
  workspaceRoot,
  maxSteps: 90,
  autonomy: "headless",
  onEvent: (env) => {
    const e = env.event as Record<string, unknown>;
    const type = String(e.type ?? "");
    if (type === "loop.tick") {
      loopTicks += 1;
      const turn = Number(e.turn ?? 0);
      if (Number.isFinite(turn)) maxTurn = Math.max(maxTurn, turn);
    }
    if (type === "tool.call") {
      const tool = String(e.tool ?? "");
      toolCalls.push(tool);
      if (tool === "workspace.run_agent") {
        const args = (e.args ?? {}) as Record<string, unknown>;
        childStarts.push(
          typeof args.agent_id === "string"
            ? args.agent_id
            : typeof args.goal === "string"
              ? args.goal.slice(0, 80)
              : "?",
        );
      }
    }
    if (type === "phase") phases.push(String(e.name ?? ""));
  },
});

function walkFiles(dir: string, acc: string[] = [], depth = 0): string[] {
  if (depth > 7 || !existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    if (
      name === "node_modules" ||
      name === ".paw" ||
      name === ".git" ||
      name === ".jobqueue"
    ) {
      continue;
    }
    const p = path.join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walkFiles(p, acc, depth + 1);
    else acc.push(path.relative(workspaceRoot, p).replaceAll("\\", "/"));
  }
  return acc;
}

const npmTest = spawnSync("npm", ["test"], {
  cwd: workspaceRoot,
  encoding: "utf8",
  shell: true,
  timeout: 180_000,
  env: { ...process.env, JOBQUEUE_TOKEN: "test-token" },
});
const typecheck = spawnSync("npm", ["run", "typecheck"], {
  cwd: workspaceRoot,
  encoding: "utf8",
  shell: true,
  timeout: 120_000,
});

let resultJson: Record<string, unknown> = {};
try {
  resultJson = JSON.parse(r.text) as Record<string, unknown>;
} catch {
  resultJson = { raw: r.text.slice(0, 4000) };
}

const report = {
  workspaceRoot,
  task: "JobQueue HARD: Phase A http+auth then Phase B pivot",
  elapsedMs: Date.now() - t0,
  exitCode: r.exitCode,
  metrics: {
    loopTicks,
    maxTurn,
    toolCallCount: toolCalls.length,
    runAgentCount: toolCalls.filter((t) => t === "workspace.run_agent").length,
    childStarts,
    writeCount: toolCalls.filter((t) =>
      [
        "workspace.write_file",
        "workspace.edit_file",
        "workspace.apply_patch",
      ].includes(t),
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
        ? resultJson.message.slice(0, 3000)
        : undefined,
    evidence: resultJson.evidence,
  },
  producedFiles: walkFiles(workspaceRoot),
  independentVerify: {
    npmTest: {
      ok: npmTest.status === 0,
      out: `${npmTest.stdout ?? ""}\n${npmTest.stderr ?? ""}`.slice(-2500),
    },
    typecheck: {
      ok: typecheck.status === 0,
      out: `${typecheck.stdout ?? ""}\n${typecheck.stderr ?? ""}`.slice(-1500),
    },
  },
};

const outPath = path.join(outDir, `jobqueue-hard-${Date.now()}.json`);
writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");
console.log(
  JSON.stringify(
    {
      outPath,
      metrics: report.metrics,
      runResult: {
        status: report.runResult.status,
        outcome: report.runResult.outcome,
        completionReason: report.runResult.completionReason,
      },
      verify: {
        npmTest: report.independentVerify.npmTest.ok,
        typecheck: report.independentVerify.typecheck.ok,
      },
      exitCode: r.exitCode,
      messagePreview: report.runResult.messagePreview?.slice(0, 1200),
    },
    null,
    2,
  ),
);
