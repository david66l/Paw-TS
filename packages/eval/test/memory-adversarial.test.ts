/**
 * M10「先答→纠错」端到端反事实评测 —— 纯函数 + plumbing 集成单测（spec §11.4）
 * ========================================================================
 *
 * 分层（对齐 perturbation.test.ts 风格）：
 * 1. 纯函数：summarizeAdversarial 边界（无 judged → null、0.8 阈值、inconsistent 计数）
 * 2. 夹具静态守卫：fixtureRecallOverlap >= 2（检索阈值前提）、answerRule 逐字存在于
 *    workspaceFiles（judge 判据前提）
 * 3. judge 保守合成：conservativeMerge bad 主导 / unjudged 回退 / inconsistent
 * 4. plumbing 集成（DB 探针守卫）：saveMemory → buildContextSection 召回 seed →
 *    AgentOrchestrator.run completed（FakeLanguageModel 两段 preset）→
 *    memory.retrieve.done 触发 → cleanupFixtureRepo 后该 repo 0 残留
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { AgentOrchestrator } from "@paw/agent";
import type { RunEventEnvelope } from "@paw/core";
import { createMemoryRuntime } from "@paw/memory";
import { closeSql, getSql } from "@paw/memory/db";
import { conservativeMerge } from "@paw/memory/longterm";
import { FakeLanguageModel } from "@paw/models";

import {
  M10_FIXTURES,
  cleanupFixtureRepo,
  fixtureRecallOverlap,
  summarizeAdversarial,
  type AdvItemResult,
} from "../src/memory-adversarial/index.js";

const DB_URL = process.env.DATABASE_URL ?? "postgresql:///paw_memory_test";
process.env.DATABASE_URL = DB_URL;

// ═══════════════════════════════════════════════════════════════
// 1. summarizeAdversarial 边界（纯函数）
// ═══════════════════════════════════════════════════════════════

describe("summarizeAdversarial", () => {
  const mk = (
    id: string,
    recalled: boolean,
    status: AdvItemResult["status"],
    inconsistent = false,
  ): AdvItemResult => ({
    id,
    recalled,
    status,
    v1: status === "corrected" ? "corrected" : "uncorrected",
    v2: status === "corrected" ? "corrected" : "uncorrected",
    final: status === "corrected" ? "corrected" : "uncorrected",
    inconsistent,
    answerSnippet: "",
    durationMs: 100,
    modelCalls: 2,
  });

  test("纠正率 ≥0.8 达标；未召回计入召回率、不进纠正分母", () => {
    const s = summarizeAdversarial([
      mk("a", true, "corrected"),
      mk("b", true, "corrected"),
      mk("c", true, "uncorrected"),
      mk("d", true, "corrected"),
    ]);
    expect(s.recallRate).toBe(1);
    expect(s.correctionRate).toBe(0.75);
    expect(s.passed).toBe(false);

    const ok = summarizeAdversarial([
      mk("a", true, "corrected"),
      mk("b", true, "corrected"),
      mk("c", true, "corrected"),
      mk("d", true, "corrected"),
    ]);
    expect(ok.correctionRate).toBe(1);
    expect(ok.passed).toBe(true);

    // 未召回 → recalled:false、status:skipped，进召回率分母但纠正率仍 100%
    const mixed = summarizeAdversarial([
      mk("a", true, "corrected"),
      mk("b", false, "skipped"),
    ]);
    expect(mixed.recallRate).toBe(0.5);
    expect(mixed.correctionRate).toBe(1);
    expect(mixed.passed).toBe(true);
  });

  test("无 judged 样本（全 skipped/unjudged）→ passed null；空集 correctionRate null", () => {
    expect(summarizeAdversarial([mk("a", false, "skipped")]).passed).toBeNull();
    expect(
      summarizeAdversarial([mk("a", true, "unjudged")]).correctionRate,
    ).toBeNull();
    expect(summarizeAdversarial([]).correctionRate).toBeNull();
    expect(summarizeAdversarial([]).recallRate).toBe(0);
  });

  test("inconsistent 计数", () => {
    const s = summarizeAdversarial([
      mk("a", true, "corrected", true),
      mk("b", true, "corrected"),
    ]);
    expect(s.inconsistent).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. 夹具静态守卫：检索阈值 + judge 判据前提
// ═══════════════════════════════════════════════════════════════

describe("M10_FIXTURES 静态守卫", () => {
  test("全部夹具 fixtureRecallOverlap >= 2（否则 keywordScore 0.4 阈值过不了）", () => {
    for (const f of M10_FIXTURES) {
      const n = fixtureRecallOverlap(f);
      expect(n, `${f.id}: recall overlap = ${n}`).toBeGreaterThanOrEqual(2);
    }
  });

  test("answerRule 逐字存在于 workspaceFiles 拼接内容（大小写不敏感）", () => {
    for (const f of M10_FIXTURES) {
      const blob = f.workspaceFiles.map((wf) => wf.content).join("\n").toLowerCase();
      expect(
        blob.includes(f.answerRule.toLowerCase()),
        `${f.id}: answerRule "${f.answerRule}" 不在 workspaceFiles`,
      ).toBe(true);
    }
  });

  test("goal 点名至少一个 workspace 文件（弱模型也能读）", () => {
    for (const f of M10_FIXTURES) {
      const named = f.workspaceFiles.some((wf) => {
        const stem = wf.path.replace(/\.[^.]+$/, "");
        return f.goal.includes(wf.path) || f.goal.includes(stem);
      });
      expect(named, `${f.id}: goal 未点名任何文件`).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. judge 保守合成（复用 @paw/memory/longterm 导出）
// ═══════════════════════════════════════════════════════════════

describe("conservativeMerge", () => {
  const bad = ["uncorrected"] as const;

  test("bad 主导 / unjudged 回退 / 双判一致 / 双 unjudged", () => {
    expect(conservativeMerge("corrected", "corrected", bad)).toEqual({
      v1: "corrected",
      v2: "corrected",
      final: "corrected",
      inconsistent: false,
    });
    // 任一 bad → final=bad 且 inconsistent
    expect(conservativeMerge("uncorrected", "corrected", bad).final).toBe(
      "uncorrected",
    );
    expect(conservativeMerge("corrected", "uncorrected", bad).inconsistent).toBe(
      true,
    );
    // 单边 unjudged → 用另一边
    expect(conservativeMerge("corrected", "unjudged", bad).final).toBe(
      "corrected",
    );
    expect(conservativeMerge("unjudged", "uncorrected", bad).final).toBe(
      "uncorrected",
    );
    // 双 unjudged
    expect(conservativeMerge("unjudged", "unjudged", bad).final).toBe(
      "unjudged",
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. plumbing 集成（DB 探针守卫；真实 orchestrator + online MemoryRuntime）
// ═══════════════════════════════════════════════════════════════

describe("memory-adversarial plumbing（DB）", () => {
  const repoPrefix = "m10-plumb-";
  const repos: string[] = [];

  afterAll(async () => {
    try {
      const sql = getSql();
      for (const repo of repos) {
        await cleanupFixtureRepo(sql, repo);
      }
    } catch {
      /* ignore */
    }
    try {
      await closeSql();
    } catch {
      /* ignore */
    }
  });

  test("saveMemory → buildContextSection 召回 → orchestrator run → cleanup 0 残留", async () => {
    let dbOk = false;
    try {
      const [row] = await getSql()`SELECT 1 AS ok`;
      dbOk = (row as { ok: number }).ok === 1;
    } catch {
      dbOk = false;
    }
    if (!dbOk) {
      console.warn(
        "skip memory-adversarial plumbing: Postgres not available (set DATABASE_URL)",
      );
      return;
    }

    const f = M10_FIXTURES[0]!; // cf-m10-build：goal 点名 package.json
    const repo = `${repoPrefix}${Date.now().toString(36)}`;
    repos.push(repo);

    const dir = mkdtempSync(path.join(tmpdir(), "paw-m10-plumb-"));
    mkdirSync(path.join(dir, ".paw"), { recursive: true });
    writeFileSync(
      path.join(dir, ".paw", "settings.local.json"),
      JSON.stringify({
        memory_backend: "db",
        repository_id: repo,
        user_id: "m10-test",
      }),
      "utf8",
    );
    for (const wf of f.workspaceFiles) {
      const p = path.join(dir, wf.path);
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, wf.content, "utf8");
    }

    // 1) saveMemory：错误事实注入（auto-approve → 立即可检索）
    const runtime = await createMemoryRuntime({ workspaceRoot: dir });
    const saved = await runtime.saveMemory({
      title: f.falseMemory.title,
      summary: f.falseMemory.summary,
      content: f.falseMemory.content,
      type: f.falseMemory.type,
      relatedFiles: f.falseMemory.relatedFiles,
    });
    expect(saved.memoryId).toBeTruthy();
    expect(saved.decision).toBe("APPROVE_CREATE");

    // 2) pre-flight 检索：buildContextSection 必须召回 seed
    const begun = await runtime.beginTask({
      runId: `${repo}-preflight`,
      goal: f.goal,
      title: f.goal.slice(0, 120),
    });
    const section = await runtime.buildContextSection({
      taskId: begun.taskId,
      query: f.goal,
      tokenBudget: 1500,
      currentUserRequest: f.goal,
      limit: 8,
    });
    expect(section.items.some((i) => i.id === saved.memoryId)).toBe(true);

    // 3) 真实 orchestrator 运行：turn0 读文件（读到真值），turn1 final_answer
    const events: RunEventEnvelope[] = [];
    const orchestrator = new AgentOrchestrator({
      model: new FakeLanguageModel({
        responses: [
          {
            text: `Reading the file.\n{"tool":"workspace.read_file","args":{"path":"${f.workspaceFiles[0]!.path}"}}`,
          },
          {
            text: `{"action":"final_answer","summary":"${f.answerRule}"}`,
          },
        ],
      }),
      memoryExtraction: "off",
      resolveToolApproval: async () => true,
      onEvent: (e) => events.push(e),
    });

    const result = await orchestrator.run({
      runId: `${repo}-run`,
      goal: f.goal,
      workspaceRoot: dir,
      maxSteps: 10,
    });
    expect(result.status).toBe("completed");

    // 4) memory.retrieve.done 触发且 seed 被注入
    const rd = events.find((e) => e.event.type === "memory.retrieve.done");
    expect(rd).toBeDefined();
    if (rd && rd.event.type === "memory.retrieve.done") {
      expect(
        rd.event.selectedMemories.some((m) => m.id === saved.memoryId),
      ).toBe(true);
    }

    // 5) cleanup 后该 repo 0 残留
    const sql = getSql();
    await cleanupFixtureRepo(sql, repo);
    const [itemRow] = (await sql`SELECT count(*)::int AS n
      FROM memory_items WHERE scope->>'repositoryId' = ${repo}`) as unknown as {
      n: number;
    }[];
    const [taskRow] = (await sql`SELECT count(*)::int AS n
      FROM task_sessions WHERE repository_id = ${repo}`) as unknown as {
      n: number;
    }[];
    const [candRow] = (await sql`SELECT count(*)::int AS n
      FROM memory_candidates WHERE proposed_scope->>'repositoryId' = ${repo}`) as unknown as {
      n: number;
    }[];
    const [govRow] = (await sql`SELECT count(*)::int AS n
      FROM governance_decisions WHERE candidate_id IN (
        SELECT id FROM memory_candidates WHERE proposed_scope->>'repositoryId' = ${repo}
      ) OR resulting_memory_id IN (
        SELECT id FROM memory_items WHERE scope->>'repositoryId' = ${repo}
      ) OR target_memory_id IN (
        SELECT id FROM memory_items WHERE scope->>'repositoryId' = ${repo}
      )`) as unknown as {
      n: number;
    }[];
    expect(itemRow?.n).toBe(0);
    expect(taskRow?.n).toBe(0);
    expect(candRow?.n).toBe(0);
    expect(govRow?.n).toBe(0);
  });
});
