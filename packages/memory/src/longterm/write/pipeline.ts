/**
 * 写入管线（spec v2 §5 / §9.1，M4）
 *
 * 五道关：事件收集（outbox 持久化队列）→ 验证门控（Verifier Gate）→
 * 密钥拦截（双道）→ 去具体化蒸馏（Distiller）→ Governor 裁决（M5 接口点）。
 * 全异步，主循环零阻塞；进程崩溃不丢（db outbox 为真相源）。
 *
 * 复用 V007 outbox_events 表（aggregate_type='memory_write' 命名空间隔离），
 * worker 串行处理、任务间隔默认 2s、失败重试 3 次进死信（outboxManager.markFailed）。
 *
 * 成本熔断（§5.2）：当日蒸馏 LLM 调用数超 dailyBudget（默认 50）→
 * 降级"只存原文摘要"；用量达 80% 记 op-log write.budget_warn 提前告警。
 */

import type { RunEvent } from "@paw/core";
import { getSql, parseJson } from "../../db/connection.js";
import { generateId } from "../../db/modules/platform/idGen.js";
import type { MemoryEntry, MemoryStoreEngine, SemanticFact } from "../store/engine.js";
import { PostgresMemoryStoreEngine } from "../store/postgres-engine.js";
import { deriveEntryId } from "../store/id.js";
import { appendOpLog } from "../observability/op-log.js";
import { scanForSecrets } from "./secrets.js";
import { MemoryDistiller, type DistillInput } from "./distiller.js";
import { LongtermGovernor, type GovernorLlm } from "./governor.js";
import { addTrialLesson } from "./trial.js";

// ── 事件与门控类型（spec §9.1 + §5.3）──

/** 验证信号（§5.3）：测试/编译 outcome | 用户显式验收 | 无信号 */
export type Verdict =
  | { kind: "test" | "compile"; passed: boolean }
  | { kind: "user_accepted" }
  | { kind: "none" };

export type MemoryWriteEvent =
  | { type: "task_succeeded"; runId: string; trajectoryRef: string; repo?: string; goal?: string; trajectory?: string; verdict?: Verdict }
  | { type: "task_failed"; runId: string; trajectoryRef: string; repo?: string; goal?: string; trajectory?: string; verdict?: Verdict }
  | { type: "user_correction"; text: string; messageRef: string; runId?: string; repo?: string }
  | { type: "session_finalize"; conversationId: string; runId?: string; repo?: string; goal?: string; trajectory?: string };

export type ProcessResult =
  | { status: "written"; memoryIds: string[] }
  | { status: "corrected"; memoryId: string; undoHint: string }
  | { status: "trialed"; trialId: string }
  | { status: "rejected"; reason: "secret" | "unverified" }
  | { status: "degraded"; memoryId: string }
  | { status: "noop"; reason: string };

/** Governor 接口点（M5 实现为 LongtermGovernor；缺省时直接 ADD） */
export interface GovernorHook {
  adjudicate(
    candidate: SemanticFact,
    similar: MemoryEntry[],
  ): Promise<{ op: "ADD" | "UPDATE" | "INVALIDATE" | "NOOP"; targetId?: string; reason?: string }>;
  /** 批量裁决（spec §5.6，默认路径）；实现后管线一次调用裁决整批 */
  adjudicateBatch?(
    items: { candidate: SemanticFact; similar: MemoryEntry[] }[],
  ): Promise<{ op: "ADD" | "UPDATE" | "INVALIDATE" | "NOOP"; targetId?: string; reason?: string }[]>;
}

export interface WritePipelineOptions {
  engine?: MemoryStoreEngine;
  /** 缺省时固化通道直接降级为原文摘要 */
  distiller?: MemoryDistiller;
  /** 显式注入 Governor（测试 mock 优先）；与 governorLlm 二选一 */
  governor?: GovernorHook;
  /** 提供 LLM 时自动构造 LongtermGovernor（M5 默认接线） */
  governorLlm?: GovernorLlm;
  /** 批量裁决开关（spec §9.4 write.batchAdjudication），默认 true */
  batchAdjudication?: boolean;
  /** worker 任务间隔，默认 2000ms */
  intervalMs?: number;
  /** 当日蒸馏 LLM 调用预算，默认 50（spec §5.2） */
  dailyBudget?: number;
  /** RunEvent 发射钩子（memory.write.* / memory.governed，§9.5） */
  emit?: (event: RunEvent) => void;
  now?: () => Date;
}

const OUTBOX_AGGREGATE = "memory-write-queue";
const OUTBOX_TYPE = "memory_write";

/** 粗略 token 估算（§5.2 dry-run：chars/4） */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export class MemoryWritePipeline {
  private readonly engine: MemoryStoreEngine;
  private readonly distiller?: MemoryDistiller;
  private readonly governor?: GovernorHook;
  private readonly batchAdjudication: boolean;
  private readonly intervalMs: number;
  private readonly dailyBudget: number;
  private readonly emit?: (event: RunEvent) => void;
  private readonly now: () => Date;
  private timer: ReturnType<typeof setInterval> | null = null;
  private processing = false;

  constructor(opts: WritePipelineOptions = {}) {
    this.engine = opts.engine ?? new PostgresMemoryStoreEngine();
    this.distiller = opts.distiller;
    this.governor = opts.governor
      ?? (opts.governorLlm ? new LongtermGovernor({ llm: opts.governorLlm, now: opts.now }) : undefined);
    this.batchAdjudication = opts.batchAdjudication ?? true;
    this.intervalMs = opts.intervalMs ?? 2000;
    this.dailyBudget = opts.dailyBudget ?? 50;
    this.emit = opts.emit;
    this.now = opts.now ?? (() => new Date());
  }

  /** 入队：落 db outbox（崩溃不丢）+ op-log + RunEvent，worker 被唤醒 */
  async enqueue(event: MemoryWriteEvent): Promise<void> {
    const sql = getSql();
    const estimated = estimateTokens("goal" in event ? `${event.goal ?? ""}\n${event.trajectory ?? ""}` : "text" in event ? event.text : "");
    await sql`
      INSERT INTO outbox_events (
        id, event_type, aggregate_type, aggregate_id, payload,
        sequence, transaction_id, status, created_at
      ) VALUES (
        ${generateId("outbox")}, ${event.type}, ${OUTBOX_TYPE}, ${OUTBOX_AGGREGATE},
        ${sql.json(event as any)},
        (SELECT COALESCE(MAX(sequence), 0) + 1 FROM outbox_events WHERE aggregate_id = ${OUTBOX_AGGREGATE}),
        ${generateId("tx")}, 'pending', now()
      )
    `;
    await appendOpLog("write.enqueued", {
      runId: "runId" in event ? event.runId : undefined,
      detail: { eventType: event.type, estimatedTokens: estimated },
    });
    this.emit?.({ type: "memory.write.enqueued", eventType: event.type, runId: "runId" in event ? event.runId : undefined });
  }

  /** 启动 worker：串行轮询 db 队列（间隔默认 2s） */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (await this.processNext()) { /* 串行排空 */ }
    } finally {
      this.processing = false;
    }
  }

  /** 处理一条待处理事件（测试可直接调用）；无待处理返回 false */
  async processNext(): Promise<boolean> {
    const sql = getSql();
    const rows = await sql`
      SELECT id, payload FROM outbox_events
      WHERE aggregate_type = ${OUTBOX_TYPE} AND status = 'pending'
        AND (next_retry_at IS NULL OR next_retry_at <= now())
      ORDER BY sequence ASC LIMIT 1
    `;
    const row = rows[0] as { id: string; payload: unknown } | undefined;
    if (!row) return false;

    try {
      await this.processEvent(parseJson(row.payload) as MemoryWriteEvent);
      await sql`UPDATE outbox_events SET status = 'published', published_at = now() WHERE id = ${row.id}`;
    } catch (e) {
      // 失败重试 3 次进死信（retry_count>=max_retries → dead_letter）
      const msg = e instanceof Error ? e.message : String(e);
      await sql`
        UPDATE outbox_events SET
          status = CASE WHEN retry_count >= max_retries THEN 'dead_letter' ELSE 'pending' END,
          retry_count = retry_count + 1,
          last_error = ${msg},
          next_retry_at = CASE WHEN retry_count >= max_retries THEN NULL ELSE now() + interval '5 seconds' END
        WHERE id = ${row.id}
      `;
      await appendOpLog("error", { detail: { stage: "write.process", error: msg } });
    }
    return true;
  }

  /** 单事件处理主流程（五道关） */
  async processEvent(event: MemoryWriteEvent): Promise<ProcessResult> {
    const repo = "repo" in event ? (event.repo ?? "") : "";
    const runId = "runId" in event ? event.runId : undefined;

    // ── 第一道（双道之一）：密钥拦截——蒸馏前 ──
    const contentText = "text" in event ? event.text : `${"goal" in event ? (event.goal ?? "") : ""}\n${"trajectory" in event ? (event.trajectory ?? "") : ""}`;
    const scan = scanForSecrets(contentText);
    if (scan.action === "reject") {
      await appendOpLog("write.rejected", { runId, detail: { reason: "secret", pattern: scan.pattern } });
      this.emit?.({ type: "memory.write.rejected", reason: "secret", detail: scan.pattern });
      return { status: "rejected", reason: "secret" };
    }

    switch (event.type) {
      case "user_correction":
        return this.handleUserCorrection(event.text, { repo, runId, redactedText: scan.action === "redact" ? scan.text : undefined });

      case "task_failed": {
        // 失败轨迹 → 试用通道（不直接入库，§5.3）
        const lesson = (event.trajectory ?? event.goal ?? "").slice(0, 500);
        if (!lesson.trim()) return { status: "noop", reason: "empty_trajectory" };
        const trial = await addTrialLesson(lesson, event.runId);
        return { status: "trialed", trialId: trial.id };
      }

      case "task_succeeded": {
        // ── 第二道：验证门控 ──
        const verdict = event.verdict ?? { kind: "none" };
        if (verdict.kind === "test" || verdict.kind === "compile") {
          if (!verdict.passed) {
            // outcome=fail 转试用通道
            const lesson = (event.trajectory ?? event.goal ?? "").slice(0, 500);
            if (!lesson.trim()) return { status: "noop", reason: "empty_trajectory" };
            const trial = await addTrialLesson(lesson, event.runId);
            return { status: "trialed", trialId: trial.id };
          }
          return this.consolidate({ runId: event.runId, goal: event.goal ?? "", trajectory: event.trajectory ?? "", outcome: "success" }, { repo, runId });
        }
        if (verdict.kind === "user_accepted") {
          return this.consolidate({ runId: event.runId, goal: event.goal ?? "", trajectory: event.trajectory ?? "", outcome: "success" }, { repo, runId });
        }
        // 禁止盲改条款（§5.3）：无任何反馈信号不得固化
        await appendOpLog("write.rejected", { runId, detail: { reason: "unverified", eventType: event.type } });
        this.emit?.({ type: "memory.write.rejected", reason: "unverified", detail: "no feedback signal" });
        return { status: "rejected", reason: "unverified" };
      }

      case "session_finalize":
        // 兜底蒸馏，confidence ≤0.6（§5.3）
        return this.consolidate(
          { runId: event.runId ?? event.conversationId, goal: event.goal ?? "", trajectory: event.trajectory ?? "", outcome: "unknown" },
          { repo, runId, confidenceCap: 0.6 },
        );
    }
  }

  /**
   * 用户纠正直写（免门控免蒸馏，用户即真相；§5.1）。
   * 返回 memoryId + undoHint（可撤销确认）。
   */
  async handleUserCorrection(
    text: string,
    opts: { repo?: string; runId?: string; redactedText?: string } = {},
  ): Promise<ProcessResult> {
    const finalText = opts.redactedText ?? text;
    const nowIso = this.now().toISOString();
    const entry: SemanticFact = {
      id: "",
      kind: "semantic",
      repo: opts.repo ?? "",
      created: nowIso,
      tValid: nowIso,
      tInvalid: null,
      source: "user_statement",
      confidence: 1.0,
      evidence: opts.runId ? [`runs/${opts.runId}`] : [],
      freq: 0,
      utility: 0,
      fact: finalText,
      keywords: [],
      embeddingKey: finalText,
    };
    await this.engine.put(entry);
    const id = deriveEntryId(entry); // put 按内容哈希派生 id，确定性取回
    await appendOpLog("governed", { runId: opts.runId, entryIds: [id], detail: { op: "ADD", by: "user_correction" } });
    this.emit?.({ type: "memory.governed", op: "ADD", entryId: id });
    return { status: "corrected", memoryId: id, undoHint: `paw-ts memory forget ${id}` };
  }

  /** 固化通道：成本熔断 → 蒸馏（重试 1 次）→ 入库前密钥二道 → Governor → put */
  private async consolidate(
    input: DistillInput,
    opts: { repo: string; runId?: string; confidenceCap?: number },
  ): Promise<ProcessResult> {
    if (!input.trajectory.trim() && !input.goal.trim()) return { status: "noop", reason: "empty_trajectory" };

    // ── 成本熔断（§5.2）──
    const distillCallsToday = await this.countDistillCallsToday();
    if (distillCallsToday + 1 >= Math.floor(this.dailyBudget * 0.8) && distillCallsToday < this.dailyBudget) {
      await appendOpLog("write.budget_warn", { runId: opts.runId, detail: { used: distillCallsToday, budget: this.dailyBudget } });
    }
    const overBudget = distillCallsToday >= this.dailyBudget || !this.distiller;
    if (overBudget) {
      return this.storeDegraded(input, opts, !this.distiller ? "no_distiller" : "daily_budget_exceeded");
    }

    await appendOpLog("write.distill", { runId: opts.runId, detail: { estimatedTokens: estimateTokens(input.goal + input.trajectory) } });
    const result = await this.distiller!.distill(input);
    if (result.status === "degraded") {
      return this.storeDegraded(input, opts, "schema_validation_failed", result.errors);
    }
    if (result.candidates.length === 0) return { status: "noop", reason: "no_candidates" };

    // ── 阶段一：密钥二道 + 构造草稿 + 相似召回 ──
    const nowIso = this.now().toISOString();
    const drafts: { draft: SemanticFact; similar: MemoryEntry[] }[] = [];
    for (const candidate of result.candidates) {
      // 当前 MVP 固化通道只落 semantic（episodic 蒸馏契约属 v2；episodic 候选暂跳过）
      if (candidate.kind !== "semantic" || !candidate.fact) continue;

      // ── 密钥拦截二道：入库前 ──
      const pre = scanForSecrets(candidate.fact);
      if (pre.action === "reject") {
        await appendOpLog("write.rejected", { runId: opts.runId, detail: { reason: "secret", pattern: pre.pattern, stage: "pre-store" } });
        this.emit?.({ type: "memory.write.rejected", reason: "secret", detail: pre.pattern });
        continue;
      }
      const fact = pre.action === "redact" ? pre.text : candidate.fact;
      if (pre.action === "redact") {
        await appendOpLog("write.redacted", { runId: opts.runId, detail: { count: pre.count } });
      }

      const draft: SemanticFact = {
        id: "",
        kind: "semantic",
        repo: opts.repo,
        created: nowIso,
        // 候选可携带 tValid（迟到的旧事实）；缺省 = 写入时间。时序倒挂由 Governor 规则层判定（§7.4）
        tValid: candidate.tValid ?? nowIso,
        tInvalid: null,
        source: "agent_verified",
        confidence: Math.min(0.8, opts.confidenceCap ?? 1),
        evidence: candidate.evidence,
        freq: 0,
        utility: 0,
        fact,
        keywords: candidate.keywords ?? [],
        embeddingKey: `${fact} ${(candidate.keywords ?? []).join(" ")}`,
      };
      const similar = await this.engine.searchVector(draft.embeddingKey, 10)
        .then((hits) => Promise.all(hits.map((h) => this.engine.get(h.id))))
        .then((es) => es.filter((e): e is MemoryEntry => e !== null))
        .catch(() => [] as MemoryEntry[]);
      drafts.push({ draft, similar });
    }

    // ── 阶段二：Governor 裁决（§5.6 批量为默认路径）──
    type Decision = { op: "ADD" | "UPDATE" | "INVALIDATE" | "NOOP"; targetId?: string; reason?: string };
    let decisions: Decision[];
    if (!this.governor) {
      decisions = drafts.map(() => ({ op: "ADD" as const }));
    } else if (this.batchAdjudication && this.governor.adjudicateBatch) {
      decisions = await this.governor.adjudicateBatch(drafts.map((d) => ({ candidate: d.draft, similar: d.similar })));
    } else {
      decisions = [];
      for (const d of drafts) decisions.push(await this.governor.adjudicate(d.draft, d.similar));
    }

    // ── 阶段三：应用裁决 ──
    const memoryIds: string[] = [];
    for (let i = 0; i < drafts.length; i++) {
      const { draft } = drafts[i]!;
      const decision = decisions[i] ?? { op: "NOOP" as const, reason: "missing_decision" };

      if (decision.op === "NOOP") {
        await appendOpLog("governed", { runId: opts.runId, detail: { op: "NOOP", reason: decision.reason ?? "" } });
        this.emit?.({ type: "memory.governed", op: "NOOP", entryId: "" });
        continue;
      }
      if (decision.op === "INVALIDATE" && decision.targetId) {
        // 矛盾（§5.6 裁决表 / §5.8-4）：旧条目软失效（不物理删除），候选作为新条目 ADD
        await this.engine.invalidate(decision.targetId, nowIso);
        await appendOpLog("governed", { runId: opts.runId, entryIds: [decision.targetId], detail: { op: "INVALIDATE" } });
        this.emit?.({ type: "memory.governed", op: "INVALIDATE", entryId: decision.targetId });
        await this.engine.put(draft);
        const newId = deriveEntryId(draft);
        memoryIds.push(newId);
        await appendOpLog("governed", { runId: opts.runId, entryIds: [newId], detail: { op: "ADD", replaces: decision.targetId } });
        this.emit?.({ type: "memory.governed", op: "ADD", entryId: newId });
        continue;
      }
      if (decision.op === "UPDATE" && decision.targetId) {
        // UPDATE 版本链（§5.6）：旧值追加进 history[]；freq/utility/t_valid/created_at 由引擎 upsert 保留
        const old = await this.engine.get(decision.targetId);
        if (old?.kind === "semantic") {
          draft.history = [...(old.history ?? []), { fact: old.fact, tInvalid: nowIso }];
        }
        draft.id = decision.targetId;
      }
      await this.engine.put(draft);
      const id = draft.id || deriveEntryId(draft);
      memoryIds.push(id);
      await appendOpLog("governed", { runId: opts.runId, entryIds: [id], detail: { op: decision.op === "UPDATE" ? "UPDATE" : "ADD" } });
      this.emit?.({ type: "memory.governed", op: decision.op === "UPDATE" ? "UPDATE" : "ADD", entryId: id });
    }
    return memoryIds.length > 0 ? { status: "written", memoryIds } : { status: "noop", reason: "all_candidates_filtered" };
  }

  /** 降级 append-only（§5.7）：原文摘要 + confidence=0.3 + agent_inferred + degraded 标记（不参与自动注入） */
  private async storeDegraded(
    input: DistillInput,
    opts: { repo: string; runId?: string },
    reason: string,
    errors: string[] = [],
  ): Promise<ProcessResult> {
    const nowIso = this.now().toISOString();
    const summary = (input.trajectory || input.goal).slice(0, 500);
    const entry = {
      id: "",
      kind: "semantic",
      repo: opts.repo,
      created: nowIso,
      tValid: nowIso,
      tInvalid: null,
      source: "agent_inferred",
      confidence: 0.3,
      evidence: [`runs/${input.runId}`],
      freq: 0,
      utility: 0,
      fact: summary,
      keywords: [],
      embeddingKey: summary,
      degraded: true,
    } as SemanticFact;
    await this.engine.put(entry);
    const id = deriveEntryId(entry);
    await appendOpLog("write.rejected", { runId: opts.runId, entryIds: [id], detail: { reason: "schema", degraded: true, why: reason, errors: errors.slice(0, 5) } });
    this.emit?.({ type: "memory.write.rejected", reason: "schema", detail: reason });
    return { status: "degraded", memoryId: id };
  }

  /** 当日蒸馏 LLM 调用计数（op-log 持久化口径，跨进程一致） */
  private async countDistillCallsToday(): Promise<number> {
    const sql = getSql();
    const [row] = await sql`
      SELECT count(*)::int AS n FROM memory_op_log
      WHERE op = 'write.distill' AND ts >= date_trunc('day', now())
    `;
    return (row as { n: number }).n;
  }
}
