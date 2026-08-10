/**
 * 轨迹回放 Δ 代理评测（spec v2 §11.1 MVP 廉价代理 / §11.2 shadow 回放，M8）
 *
 * 输入 JSONL（每行一条轨迹）：
 *   {"taskId":"t1","description":"…","repo":"…",
 *    "events":[{"type":"action_failed","errorOutput":"…","lastActionSummary":"…"}],
 *    "outcome":"success|failed|unknown"}
 *
 * 逻辑：对每条轨迹，在任务开始 + 每个 action_failed 事件点以 shadow 方式跑检索，
 * 产出"假设注入包"；JudgeLlm 判定每条注入"是否会帮助避免该轨迹中的错误"
 * （helpful/neutral/harmful 三档）。汇总 Δ 报告：命中率、helpful/harmful 占比
 * （目标 helpful>harmful 且 harmful<5%），n<30 给出样本不足提示。
 *
 * 统计显著性从简（MVP 代理）：逐轨迹判定列表 + 汇总比例；
 * 完整配对检验（p<0.05）留到真实任务评测集（§11.1）。
 */

import type { MemoryStoreEngine } from "../store/engine.js";
import { PostgresMemoryStoreEngine } from "../store/postgres-engine.js";
import { TriggeredRetriever, type RetrieverOptions } from "../retrieval/triggered.js";

// ── 输入格式 ──

export interface ReplayEvent {
  type: "action_failed";
  errorOutput: string;
  lastActionSummary?: string;
}

export interface ReplayTrajectory {
  taskId: string;
  description: string;
  repo?: string;
  events?: ReplayEvent[];
  outcome?: "success" | "failed" | "unknown";
}

/** 解析 JSONL，坏行报行号 */
export function parseReplayJsonl(text: string): ReplayTrajectory[] {
  const out: ReplayTrajectory[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (e) {
      throw new Error(`第 ${i + 1} 行不是合法 JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
    const t = parsed as Record<string, unknown>;
    if (typeof t.taskId !== "string" || typeof t.description !== "string") {
      throw new Error(`第 ${i + 1} 行缺 taskId/description`);
    }
    out.push(t as unknown as ReplayTrajectory);
  }
  return out;
}

// ── Judge ──

export interface JudgeLlm {
  complete(prompt: string): Promise<string>;
}

export type JudgeVerdict = "helpful" | "neutral" | "harmful" | "unjudged";

export function buildJudgePrompt(trajectory: ReplayTrajectory, injectedText: string): string {
  const failures = (trajectory.events ?? [])
    .map((e, i) => `失败 ${i + 1}: ${e.errorOutput.slice(0, 300)}`)
    .join("\n");
  return `你是记忆注入评测员。判断这条"假设注入的记忆"对该任务轨迹的影响。

三档判定：
- helpful：注入的经验能帮助避免轨迹中的错误或显著加速任务
- neutral：与任务无关但无误导
- harmful：会误导 Agent 采取错误行动（如注入已过期/相反的建议）

输出 JSON（不要输出其它内容）：{ "verdict": "helpful|neutral|harmful", "reason": "一句理由" }

任务描述：
${trajectory.description}

轨迹中的失败：
${failures || "(无失败事件)"}
任务 outcome：${trajectory.outcome ?? "unknown"}

假设注入的记忆：
${injectedText}`;
}

/** 手写校验 judge 输出；非法 → null（调用方记 unjudged） */
export function parseJudgeOutput(raw: string): { verdict: Exclude<JudgeVerdict, "unjudged">; reason: string } | null {
  try {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    if (parsed.verdict !== "helpful" && parsed.verdict !== "neutral" && parsed.verdict !== "harmful") return null;
    return { verdict: parsed.verdict, reason: typeof parsed.reason === "string" ? parsed.reason : "" };
  } catch {
    return null;
  }
}

// ── 报告 ──

export interface ReplayJudgment {
  taskId: string;
  entryId: string;
  verdict: JudgeVerdict;
  reason: string;
}

export interface ReplayReport {
  generatedAt: string;
  trajectories: number;
  /** 至少产出一条假设注入的轨迹数 */
  trajectoriesWithHits: number;
  hitRate: number;
  judgments: { helpful: number; neutral: number; harmful: number; unjudged: number };
  /** 仅统计已判定（helpful/neutral/harmful）的比例；无判定数据为 null */
  helpfulRate: number | null;
  harmfulRate: number | null;
  /** n<30 时的样本不足提示 */
  sampleWarning: string | null;
  results: {
    taskId: string;
    injections: number;
    entryIds: string[];
    judgments: ReplayJudgment[];
  }[];
}

export interface ReplayOptions {
  engine?: MemoryStoreEngine;
  /** 缺省时判定记 unjudged（CLI 无 LLM 配置的默认路径） */
  judge?: JudgeLlm;
  repo?: string;
  /** 透传 retriever 配置（测试注入 countTokens 等）；shadow 强制为 true */
  retrieverOptions?: Partial<RetrieverOptions>;
  now?: () => Date;
}

export async function runReplay(
  trajectories: readonly ReplayTrajectory[],
  opts: ReplayOptions = {},
): Promise<ReplayReport> {
  const engine = opts.engine ?? new PostgresMemoryStoreEngine();
  // shadow：回放只记录假设注入包，绝不影响真实账本与注入（§11.2）
  // 修复批次 C #20：shadow 放在展开之后强制为 true，调用方无法覆盖
  const retriever = new TriggeredRetriever({
    engine,
    ...opts.retrieverOptions,
    shadow: true,
  });
  const now = opts.now ?? (() => new Date());

  const results: ReplayReport["results"] = [];
  let withHits = 0;
  const totals = { helpful: 0, neutral: 0, harmful: 0, unjudged: 0 };

  for (const t of trajectories) {
    const repo = t.repo ?? opts.repo;
    const judgments: ReplayJudgment[] = [];
    const entryIds: string[] = [];

    // 触发点：任务开始 + 每个可行动的失败事件
    const packages = [
      await retriever.retrieve({ type: "task_start", taskDescription: t.description, repo, runId: t.taskId }),
    ];
    for (const ev of t.events ?? []) {
      packages.push(await retriever.retrieve({
        type: "action_failed",
        errorOutput: ev.errorOutput,
        lastActionSummary: ev.lastActionSummary ?? "",
        repo,
        runId: t.taskId,
      }));
    }

    for (const pkg of packages) {
      for (const item of pkg.items) {
        if (entryIds.includes(item.id)) continue;
        entryIds.push(item.id);
        let judgment: ReplayJudgment;
        if (!opts.judge) {
          judgment = { taskId: t.taskId, entryId: item.id, verdict: "unjudged", reason: "no judge configured" };
        } else {
          const raw = await opts.judge.complete(buildJudgePrompt(t, item.text)).catch(() => "");
          const parsed = parseJudgeOutput(raw);
          judgment = parsed
            ? { taskId: t.taskId, entryId: item.id, verdict: parsed.verdict, reason: parsed.reason }
            : { taskId: t.taskId, entryId: item.id, verdict: "unjudged", reason: "judge_output_unparseable" };
        }
        judgments.push(judgment);
        totals[judgment.verdict] += 1;
      }
    }

    if (entryIds.length > 0) withHits += 1;
    results.push({ taskId: t.taskId, injections: entryIds.length, entryIds, judgments });
  }

  const judged = totals.helpful + totals.neutral + totals.harmful;
  const n = trajectories.length;
  return {
    generatedAt: now().toISOString(),
    trajectories: n,
    trajectoriesWithHits: withHits,
    hitRate: n > 0 ? withHits / n : 0,
    judgments: totals,
    helpfulRate: judged > 0 ? totals.helpful / judged : null,
    harmfulRate: judged > 0 ? totals.harmful / judged : null,
    sampleWarning: n < 30 ? `样本量 n=${n} < 30，比例仅供参考（统计显著性检验留待真实评测集）` : null,
    results,
  };
}

/** 控制台表格渲染（纯函数） */
export function renderReplayReport(r: ReplayReport): string {
  const pct = (v: number | null) => (v === null ? "n/a" : `${(v * 100).toFixed(1)}%`);
  const lines = [
    "轨迹回放 Δ 代理报告",
    `  生成时间: ${r.generatedAt}`,
    `  轨迹数: ${r.trajectories}    有命中: ${r.trajectoriesWithHits}    命中率: ${(r.hitRate * 100).toFixed(1)}%`,
    `  判定: helpful=${r.judgments.helpful}  neutral=${r.judgments.neutral}  harmful=${r.judgments.harmful}  unjudged=${r.judgments.unjudged}`,
    `  helpful 占比: ${pct(r.helpfulRate)}    harmful 占比: ${pct(r.harmfulRate)}（目标 helpful>harmful 且 harmful<5%）`,
  ];
  if (r.sampleWarning) lines.push(`  ⚠ ${r.sampleWarning}`);
  lines.push("  ── 逐轨迹 ──");
  for (const res of r.results) {
    const verdicts = res.judgments.map((j) => `${j.entryId.slice(0, 24)}:${j.verdict}`).join("  ");
    lines.push(`  ${res.taskId}  注入 ${res.injections} 条${verdicts ? `    ${verdicts}` : ""}`);
  }
  return lines.join("\n");
}
