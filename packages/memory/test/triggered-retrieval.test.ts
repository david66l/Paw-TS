/**
 * 触发式检索管线测试（spec v2 §6，验收 §6.8 七条）
 *
 * 纯函数部分（isActionableError/query 构造/精排校验/T3 去重）不需要 DB；
 * db 部分 LLM 全 mock，ping 失败时 skip 而非 fail：
 *   DATABASE_URL="postgresql://postgres@127.0.0.1:54329/paw_memory_test" bun test test/triggered-retrieval.test.ts
 */

import { describe, test, expect, afterAll } from "bun:test";
import type { RunEvent } from "@paw/core";
import { getSql, closeSql, ping } from "../src/db/connection.js";
import { PostgresMemoryStoreEngine } from "../src/longterm/store/postgres-engine.js";
import { deriveEntryId } from "../src/longterm/store/id.js";
import { queryOpLog } from "../src/longterm/observability/op-log.js";
import { addTrialLesson } from "../src/longterm/write/trial.js";
import {
  TriggeredRetriever,
  isActionableError,
  buildActionFailedQuery,
  isCoveredByHints,
  parseRerankOutput,
  buildRerankPrompt,
  inferApplicabilityLabel,
  resolveInjectStatus,
  type RerankerLlm,
} from "../src/longterm/retrieval/triggered.js";
import type { EpisodicExperience, SemanticFact } from "../src/longterm/store/engine.js";

process.env.DATABASE_URL ??= "postgresql://postgres@127.0.0.1:54329/paw_memory_test";

const dbOk = await ping();
const it = dbOk ? test : test.skip;

// ═══════════════════════════════════════════════════════════════
// 纯函数（不需要 DB）
// ═══════════════════════════════════════════════════════════════

describe("isActionableError（T2 防误检，§6.2）", () => {
  test("可行动错误触发", () => {
    expect(isActionableError("error TS2304: Cannot find name 'foo'")).toBe(true);
    expect(isActionableError("ModuleResolutionError: Cannot find module")).toBe(true);
    expect(isActionableError("3 tests failed")).toBe(true);
    expect(isActionableError("command exited with code 1")).toBe(true);
  });

  test("权限拒绝/用户中止不触发", () => {
    expect(isActionableError("rm: permission denied")).toBe(false);
    expect(isActionableError("Error: EACCES: permission denied, open '/etc/x'")).toBe(false);
    expect(isActionableError("用户中止了操作")).toBe(false);
    expect(isActionableError("process interrupted by SIGINT")).toBe(false);
  });

  test("无错误信号不触发", () => {
    expect(isActionableError("all checks passed")).toBe(false);
  });
});

describe("buildActionFailedQuery（§6.2）", () => {
  test("errorType + 堆栈行 + lastActionSummary", () => {
    const q = buildActionFailedQuery(
      "ModuleResolutionError: Cannot find module 'x'\n    at resolve (internal/loader.ts:10:5)\n    at import (app.ts:3:1)\nmore noise",
      "edit_file package.json (exit 1)",
    );
    expect(q).toContain("ModuleResolutionError");
    expect(q).toContain("at resolve");
    expect(q).toContain("edit_file package.json (exit 1)");
  });

  test("错误输出截断到 400 字符", () => {
    const q = buildActionFailedQuery("Error: " + "x".repeat(1000), "cmd");
    expect(q.length).toBeLessThan(600);
  });
});

describe("isCoveredByHints（T3 去重，§6.1）", () => {
  test("高重叠 → 覆盖", () => {
    expect(isCoveredByHints(
      "the project uses vitest for unit testing",
      ["key decision: the project uses vitest for unit testing across packages"],
    )).toBe(true);
  });

  test("不相关 → 不覆盖", () => {
    expect(isCoveredByHints("database pool defaults to ten connections", ["prefer pnpm workspaces"])).toBe(false);
  });
});

describe("parseRerankOutput（§6.4 输出契约）", () => {
  test("合法输出", () => {
    const r = parseRerankOutput('{"items":[{"seq":2,"why":"相关","label":"applicable"}]}', 3);
    expect(r).toEqual([{ seq: 2, why: "相关", label: "applicable" }]);
  });

  test("越界序号/非法 label/非 JSON → null（降级）", () => {
    expect(parseRerankOutput('{"items":[{"seq":9,"why":"","label":"applicable"}]}', 3)).toBeNull();
    expect(parseRerankOutput('{"items":[{"seq":1,"why":"","label":"maybe"}]}', 3)).toBeNull();
    expect(parseRerankOutput("完全不是 JSON", 3)).toBeNull();
  });

  test("buildRerankPrompt 含整数序号候选", () => {
    const prompt = buildRerankPrompt("q", []);
    expect(prompt).toContain("seq");
  });
});

describe("disagreement gate（§6.5）", () => {
  const now = new Date().toISOString();
  const baseEpisodic = (whenToUse: string, perspective: string): EpisodicExperience => ({
    id: "",
    kind: "episodic",
    repo: "r",
    created: now,
    tValid: now,
    tInvalid: null,
    source: "agent_verified",
    confidence: 0.9,
    evidence: [],
    freq: 0,
    utility: 0,
    whenToUse,
    perspective,
    modification: ["do the thing"],
    issueType: "TestError",
    taskId: "t",
  });

  test("启发式：特征词重叠 ≥2 → applicable，否则 reference", () => {
    const strong = baseEpisodic(
      "When AmberModuleResolutionError appears after ESM migration",
      "Check exports map first",
    );
    expect(
      inferApplicabilityLabel(
        "AmberModuleResolutionError after ESM migration failed",
        strong,
      ),
    ).toBe("applicable");

    const weak = baseEpisodic(
      "When completely unrelated database migrations stall",
      "Vacuum then retry",
    );
    expect(
      inferApplicabilityLabel(
        "AmberModuleResolutionError after ESM migration failed",
        weak,
      ),
    ).toBe("reference");
  });

  test("精排 label 优先于启发式；无 label 时走启发式", () => {
    const entry = baseEpisodic(
      "When AmberModuleResolutionError appears after ESM migration",
      "Check exports map first",
    );
    expect(resolveInjectStatus("AmberModuleResolutionError ESM migration", entry, "reference")).toBe("reference");
    expect(resolveInjectStatus("unrelated query", entry, "applicable")).toBe("verified");
    expect(resolveInjectStatus("AmberModuleResolutionError ESM migration", entry)).toBe("verified");
  });
});

// ═══════════════════════════════════════════════════════════════
// db 集成（§6.8 七条，LLM 全 mock）
// ═══════════════════════════════════════════════════════════════

const RUN = `run_m6_${Date.now().toString(36)}`;
const REPO = `m6-retrieval-${Date.now().toString(36)}`;
const createdIds: string[] = [];
const emitted: RunEvent[] = [];

function makeEpisodic(whenToUse: string, perspective: string, overrides: Partial<EpisodicExperience> = {}): EpisodicExperience {
  const now = new Date().toISOString();
  return {
    id: "", kind: "episodic", repo: REPO, created: now, tValid: now, tInvalid: null,
    source: "agent_verified", confidence: 0.9, evidence: [], freq: 0, utility: 0,
    whenToUse, perspective, modification: ["Check the config field first"],
    issueType: "ModuleResolutionError", taskId: "tsk_m6",
    ...overrides,
  };
}

function makeSemantic(fact: string): SemanticFact {
  const now = new Date().toISOString();
  return {
    id: "", kind: "semantic", repo: REPO, created: now, tValid: now, tInvalid: null,
    source: "agent_verified", confidence: 0.9, evidence: [], freq: 0, utility: 0,
    fact, keywords: [], embeddingKey: fact,
  };
}

/** 解析 prompt 中正文含 marker 的候选序号 */
function seqOf(prompt: string, marker: string): number {
  const re = /候选 (\d+):\n([\s\S]*?)(?=\n\n候选 |\n\n*$|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt))) {
    if (m[2]!.includes(marker)) return Number(m[1]);
  }
  throw new Error(`marker not found in rerank prompt: ${marker}`);
}

function makeRetriever(reranker?: RerankerLlm): TriggeredRetriever {
  return new TriggeredRetriever({
    engine: new PostgresMemoryStoreEngine(),
    reranker,
    countTokens: (t) => Math.ceil(t.length / 4), // 测试用粗估，避免 tiktoken WASM 加载
    emit: (e) => emitted.push(e),
  });
}

describe("TriggeredRetriever db 集成（§6.8）", () => {
  const engine = new PostgresMemoryStoreEngine();

  afterAll(async () => {
    if (dbOk) {
      const sql = getSql();
      for (const id of createdIds) {
        await sql`DELETE FROM memory_embeddings WHERE memory_id = ${id}`;
        await sql`DELETE FROM memory_items WHERE id = ${id}`;
      }
      await sql`DELETE FROM memory_items WHERE scope->>'repositoryId' = ${REPO}`;
      await sql`DELETE FROM memory_op_log WHERE run_id LIKE ${RUN + "%"}`;
      await sql`DELETE FROM memory_trial_lessons WHERE origin_task_id LIKE ${RUN + "%"}`;
    }
    await closeSql();
  });

  it("§6.8-1 20 条记忆 + 1 条高相关经验 → T1 恰好注入 1 条且是目标", async () => {
    // 20 条同池噪声（episodic，修复批次 C #16：与目标同池才算真实竞争；词汇与查询不相交）
    const topics = ["database pooling", "cache headers", "retry backoff", "log rotation", "queue depth",
      "tls handshake", "clock skew", "disk quota", "thread affinity", "heap sizing",
      "shard routing", "lease renewal", "rate limiting", "circuit breaking", "bulkhead isolation",
      "graceful shutdown", "config reload", "health probes", "metric cardinality", "trace sampling"];
    for (const [i, t] of topics.entries()) {
      const noise = makeEpisodic(
        `When tuning ${t} parameters under load`,
        `Operational note ${i + 1} about ${t} tuning under sustained load`,
      );
      await engine.put(noise);
      createdIds.push(deriveEntryId(noise));
    }
    // 1 条高相关经验
    const target = makeEpisodic(
      "When zephyr deployments fail with token mismatch after rotation",
      "Zephyr deployment token mismatches usually come from stale rotation windows",
    );
    await engine.put(target);
    const targetId = deriveEntryId(target);
    createdIds.push(targetId);

    const r = makeRetriever(); // 无精排：k=1 纪律在触发层
    const pkg = await r.retrieve({
      type: "task_start",
      taskDescription: "zephyr deployments fail with token mismatch after rotation",
      repo: REPO,
      runId: `${RUN}_t1`,
    });
    expect(pkg.items).toHaveLength(1);
    expect(pkg.items[0]!.id).toBe(targetId);
    expect(pkg.render()).toContain("<agent-memory");
    expect(pkg.render()).toContain('status="verified"');
    expect(pkg.render()).toContain("建议策略"); // §6.5 applicable 措辞
    // gate op-log
    const gates = await queryOpLog({ runId: `${RUN}_t1`, op: "read.gate" });
    expect(gates.length).toBe(1);
    expect(gates[0]!.detail.applicable).toBe(1);
    expect(gates[0]!.detail.source).toBe("heuristic"); // 无精排
    // RunEvent 发射
    expect(emitted.some((e) => e.type === "memory.trigger" && e.triggerType === "task_start")).toBe(true);
    expect(emitted.some((e) => e.type === "memory.inject")).toBe(true);
    // 账本 freq+1
    expect((await engine.ledger(targetId))!.freq).toBe(1);
  });

  it("§6.8-2 两条相似经验 → 精排只留 1 条", async () => {
    const e1 = makeEpisodic("When quartz jobs deadlock on shutdown hooks", "Quartz job deadlocks usually come from shutdown hook ordering");
    const e2 = makeEpisodic("When quartz jobs deadlock during shutdown", "Quartz shutdown deadlocks usually come from hook ordering issues");
    await engine.put(e1);
    await engine.put(e2);
    createdIds.push(deriveEntryId(e1), deriveEntryId(e2));

    let sawCandidates = 0;
    const reranker: RerankerLlm = {
      complete: async (prompt) => {
        sawCandidates = (prompt.match(/候选 \d+:/g) ?? []).length;
        return JSON.stringify({ items: [{ seq: seqOf(prompt, "hook ordering"), why: "直接匹配", label: "applicable" }] });
      },
    };
    const pkg = await makeRetriever(reranker).retrieve({
      type: "task_start",
      taskDescription: "quartz jobs deadlock on shutdown hooks",
      repo: REPO,
      runId: `${RUN}_t1b`,
    });
    expect(sawCandidates).toBeGreaterThanOrEqual(2);
    expect(pkg.items).toHaveLength(1);
    expect(pkg.items[0]!.id).toBe(deriveEntryId(e1));
  });

  it("§6.8-3 精排判 reference → 弱措辞注入", async () => {
    const e = makeEpisodic("When garnet caches evict too aggressively", "Garnet cache evictions usually come from memory pressure");
    await engine.put(e);
    createdIds.push(deriveEntryId(e));

    const reranker: RerankerLlm = {
      complete: async (prompt) => JSON.stringify({
        items: [{ seq: seqOf(prompt, "Garnet"), why: "与当前任务仅弱相关", label: "reference" }],
      }),
    };
    const pkg = await makeRetriever(reranker).retrieve({
      type: "task_start",
      taskDescription: "garnet caches evict too aggressively",
      repo: REPO,
      runId: `${RUN}_ref`,
    });
    expect(pkg.items).toHaveLength(1);
    expect(pkg.items[0]!.status).toBe("reference");
    expect(pkg.render()).toContain("历史参考（可能不适用）");
    expect(pkg.render()).toContain('status="reference"');
    const gates = await queryOpLog({ runId: `${RUN}_ref`, op: "read.gate" });
    expect(gates[0]!.detail.reference).toBe(1);
    expect(gates[0]!.detail.source).toBe("rerank");
  });

  it("无精排 + 弱相关命中 → 启发式判 reference（宁弱勿强）", async () => {
    // whenToUse 与 query 几乎无共享长特征词 → 启发式 reference
    const e = makeEpisodic(
      "When coral database vacuum stalls overnight",
      "Coral vacuum stalls usually come from lock contention",
    );
    await engine.put(e);
    createdIds.push(deriveEntryId(e));

    // 用 T4 显式查询把条目捞进来（不走精排），query 词面与 whenToUse 弱重叠
    const pkg = await makeRetriever().retrieve({
      type: "explicit_query",
      question: "coral vacuum",
      repo: REPO,
      runId: `${RUN}_heur_ref`,
    });
    const hit = pkg.items.find((i) => i.id === deriveEntryId(e));
    expect(hit).toBeDefined();
    // "coral"/"vacuum" 若被 extractMatchTerms 收成短词可能不够 2 个长特征命中
    // coral=5 chars（≤6 不入选），vacuum=6（≤6 不入选）→ terms 空 → reference
    expect(hit!.status).toBe("reference");
    expect(pkg.render()).toContain("历史参考（可能不适用）");
  });

  it("§6.8-4 否定句逐字保留", async () => {
    const neg = "不要用 legacy API，一律走新客户端";
    const s = makeSemantic(neg);
    await engine.put(s);
    createdIds.push(deriveEntryId(s));

    const pkg = await makeRetriever().retrieve({
      type: "action_failed",
      errorOutput: "Error: 调用 legacy API 失败\n    at callLegacy (client.ts:1:1)",
      lastActionSummary: "run_tests 提交前检查 (exit 1)",
      repo: REPO,
      runId: `${RUN}_neg`,
    });
    expect(pkg.items.length).toBeGreaterThanOrEqual(1);
    expect(pkg.render()).toContain(neg); // 逐字，未 paraphrase
  });

  it("§6.8-5 过期条目 T1/T2/T3 不可见，T4 可见且带失效标注", async () => {
    const s = makeSemantic("Topaz scheduler requires manual lease renewal every hour");
    await engine.put(s);
    const id = deriveEntryId(s);
    createdIds.push(id);
    const tInvalid = new Date().toISOString();
    await engine.invalidate(id, tInvalid);

    // T2 不可见
    const pkgT2 = await makeRetriever().retrieve({
      type: "action_failed",
      errorOutput: "SchedulerError: topaz lease expired\n    at renew (topaz.ts:2:2)",
      lastActionSummary: "run topaz scheduler (exit 1)",
      repo: REPO,
      runId: `${RUN}_stale_t2`,
    });
    expect(pkgT2.items.map((i) => i.id)).not.toContain(id);

    // T4 可见 + 失效标注
    const pkgT4 = await makeRetriever().retrieve({
      type: "explicit_query",
      question: "topaz scheduler lease renewal",
      repo: REPO,
      runId: `${RUN}_stale_t4`,
    });
    const hit = pkgT4.items.find((i) => i.id === id);
    expect(hit).toBeDefined();
    expect(hit!.tInvalid).toBe(tInvalid);
    expect(pkgT4.render()).toContain("已于");
    expect(pkgT4.render()).toContain("失效");
  });

  it("§6.8-6 空库 → 无检索调用、无注入（op-log 可证）", async () => {
    const emptyRepo = `${REPO}-empty`;
    const runId = `${RUN}_empty`;
    const pkg = await makeRetriever().retrieve({
      type: "task_start",
      taskDescription: "any task",
      repo: emptyRepo,
      runId,
    });
    expect(pkg.items).toHaveLength(0);
    expect(pkg.totalTokens).toBe(0);
    expect(pkg.render()).toBe("");

    const triggers = await queryOpLog({ runId, op: "read.trigger" });
    expect(triggers.some((l) => l.detail.skipped === "empty_store")).toBe(true);
    const injects = await queryOpLog({ runId, op: "read.inject" });
    expect(injects).toHaveLength(0);
  });

  it("§6.8-7 注入总量 ≤500 tokens（超限截断记 op-log）", async () => {
    // 5 条各 ~600 字符（粗估 150 tokens）的条目，T4 上限 5 条 → 必超 500
    for (let i = 0; i < 5; i++) {
      const s = makeSemantic(`Iodine migration note ${i}: ` + "detailed migration step description. ".repeat(20));
      await engine.put(s);
      createdIds.push(deriveEntryId(s));
    }
    const runId = `${RUN}_budget`;
    const pkg = await makeRetriever().retrieve({
      type: "explicit_query",
      question: "iodine migration",
      repo: REPO,
      runId,
    });
    expect(pkg.items.length).toBeGreaterThanOrEqual(1);
    expect(pkg.totalTokens).toBeLessThanOrEqual(500);
    if (pkg.items.length < 5) {
      const trunc = await queryOpLog({ runId, op: "read.truncated" });
      expect(trunc.length).toBe(1);
    }
    // op-log read.inject 的 totalTokens 也在预算内
    const injects = await queryOpLog({ runId, op: "read.inject" });
    expect((injects[0]!.detail.totalTokens as number)).toBeLessThanOrEqual(500);
  });

  it("精排失败 → 召回直取 k 减半 + degraded（§6.7）", async () => {
    for (let i = 0; i < 3; i++) {
      const s = makeSemantic(`Peridot cache invalidation strategy variant ${i} uses versioned keys`);
      await engine.put(s);
      createdIds.push(deriveEntryId(s));
    }
    const badReranker: RerankerLlm = { complete: async () => "格式完全错误的输出" };
    const runId = `${RUN}_rerankfail`;
    const pkg = await makeRetriever(badReranker).retrieve({
      type: "action_failed",
      errorOutput: "CacheError: peridot invalidation failed\n    at invalidate (peridot.ts:3:3)",
      lastActionSummary: "flush peridot cache (exit 1)",
      repo: REPO,
      runId,
    });
    expect(pkg.degraded).toBe(true);
    expect(pkg.items.length).toBeLessThanOrEqual(1); // k=3 减半 → 1
    const logs = await queryOpLog({ runId, op: "read.degraded" });
    expect(logs.some((l) => l.detail.stage === "rerank")).toBe(true);
  });

  it("trial 池随行：T2 命中试用教训，不占正式条额", async () => {
    const lesson = await addTrialLesson(
      "ModuleResolutionError cannot find module 时先检查 exports 字段配置",
      `${RUN}_trial_origin`,
    );
    const s = makeSemantic("Zircon loader resolves modules through the exports map");
    await engine.put(s);
    createdIds.push(deriveEntryId(s));

    const pkg = await makeRetriever().retrieve({
      type: "action_failed",
      errorOutput: "ModuleResolutionError: Cannot find module 'zircon'\n    at resolve (loader.ts:9:9)",
      lastActionSummary: "run build (exit 1)",
      repo: REPO,
      runId: `${RUN}_trial`,
    });
    const trialItem = pkg.items.find((i) => i.kind === "trial");
    expect(trialItem).toBeDefined();
    expect(trialItem!.status).toBe("trial");
    expect(pkg.render()).toContain("试用经验（未验证）");

    // 试用不占正式条额、不进正式账本
    const injects = await queryOpLog({ runId: `${RUN}_trial`, op: "read.inject" });
    expect(injects[0]!.entryIds).not.toContain(lesson.id);
  });

  it("T3 与 SessionMemory 去重（§6.1）", async () => {
    const s = makeSemantic("the build pipeline uses incremental compilation for speed");
    await engine.put(s);
    const id = deriveEntryId(s);
    createdIds.push(id);

    const covered = await makeRetriever().retrieve({
      type: "post_compact",
      summaryHead: "讨论构建管线的增量编译",
      goal: "build pipeline incremental compilation",
      existingContextHints: ["Key Decision: the build pipeline uses incremental compilation for speed"],
      repo: REPO,
      runId: `${RUN}_t3`,
    });
    expect(covered.items.map((i) => i.id)).not.toContain(id);
  });
});
