/**
 * MemoryRuntime — agent 接入新记忆系统的唯一门面。
 *
 * 封装 TaskSession / WorkingMemory / Retriever / ContextBuilder /
 * Writer → Governance → Executor 全链路。
 *
 * 铁律：
 * - 正式记忆写入必经 Governance
 * - 进 prompt 只经 ContextBuilder
 * - DB 不可用时不回退 FileProvider
 */

import { governanceDecisionDao } from "../db/dao/governanceDecision.js";
import { memoryCandidateDao } from "../db/dao/memoryCandidate.js";
import { memoryItemDao } from "../db/dao/memoryItem.js";
import { closeSql, ping as dbPing } from "../db/connection.js";
import { generateId } from "../db/modules/platform/idGen.js";
import {
  ContextBuilder,
  GovernanceExecutor,
  MemoryGovernance,
  MemoryRetriever,
  MemoryWriter,
  RevisionConflictError,
  TaskSessionManager,
  ToolResultProcessor,
  WorkingMemoryManager,
  executionRecorder,
} from "../db/modules/index.js";
import type {
  FileActivity,
  MemoryCandidate,
  MemoryType,
  PlanStep,
  ToolExecutionSummary,
  WorkingConstraint,
  WorkingMemory,
} from "../db/types.js";
import { resolveScope, type ResolvedScope } from "./scope.js";
import type {
  BeginTaskInput,
  BeginTaskResult,
  BuildContextInput,
  BuildContextResult,
  CompleteTaskInput,
  CompleteTaskResult,
  MemoryListItem,
  MemoryRuntime,
  MemoryRuntimeOptions,
  OnToolResultInput,
  PatchWorkingMemoryInput,
  SaveMemoryInput,
  SaveMemoryResult,
} from "./types.js";

const MAX_WM_RETRIES = 3;
const DEFAULT_CONTEXT_BUDGET = 4000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringArg(args: unknown, key: string): string | undefined {
  if (!isRecord(args)) return undefined;
  const v = args[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function toListItem(item: {
  id: string;
  title: string;
  summary: string;
  type: string;
  status: string;
  confidence: number;
  subjectKey?: string;
  relatedFiles?: string[];
  updatedAt?: string;
}): MemoryListItem {
  return {
    id: item.id,
    title: item.title,
    summary: item.summary,
    type: item.type,
    status: item.status,
    confidence: item.confidence,
    subjectKey: item.subjectKey,
    relatedFiles: item.relatedFiles,
    updatedAt: item.updatedAt,
  };
}

function estimateTokens(text: string): number {
  const ascii = (text.match(/[\x00-\x7F]/g) ?? []).length;
  const nonAscii = text.length - ascii;
  return Math.ceil(ascii / 4 + nonAscii / 1.5);
}

export class MemoryRuntimeImpl implements MemoryRuntime {
  readonly scope: ResolvedScope;

  private readonly taskMgr = new TaskSessionManager();
  private readonly wmMgr = new WorkingMemoryManager();
  private readonly writer = new MemoryWriter();
  private readonly governance = new MemoryGovernance();
  private readonly executor = new GovernanceExecutor();
  private readonly retriever = new MemoryRetriever();
  private readonly ctxBuilder = new ContextBuilder();
  private readonly toolProcessor = new ToolResultProcessor();

  /** runId → taskId（同进程多 run） */
  private readonly runTaskMap = new Map<string, string>();

  constructor(opts: MemoryRuntimeOptions) {
    this.scope = resolveScope(opts);
  }

  async ping(): Promise<boolean> {
    return dbPing();
  }

  async beginTask(input: BeginTaskInput): Promise<BeginTaskResult> {
    if (input.resumeTaskId) {
      const existing = await this.taskMgr.getTask(input.resumeTaskId);
      if (!existing) {
        throw new Error(`TaskSession not found: ${input.resumeTaskId}`);
      }
      if (existing.status === "pending") {
        await this.taskMgr.startTask(existing.id, existing.revision);
      }
      this.runTaskMap.set(input.runId, existing.id);
      return { taskId: existing.id, resumed: true };
    }

    const { task, wm } = await this.taskMgr.createTask({
      userId: this.scope.userId,
      repositoryId: this.scope.repositoryId,
      workspaceId: this.scope.workspaceId,
      initialUserRequest: input.goal,
      title: input.title ?? input.goal.slice(0, 120),
      branch: input.branch,
      baseCommit: input.baseCommit,
    });

    // 写入初始 goal
    if (input.goal) {
      await this.wmMgr.update(task.id, wm.revision, { goal: input.goal });
    }

    const started = await this.taskMgr.startTask(task.id, task.revision);
    this.runTaskMap.set(input.runId, started.id);
    return { taskId: started.id, resumed: false };
  }

  async buildContextSection(
    input: BuildContextInput,
  ): Promise<BuildContextResult> {
    const wm = await this.requireWm(input.taskId);

    let degraded = false;
    let retrievalResult: Awaited<ReturnType<MemoryRetriever["retrieve"]>> | undefined;
    try {
      retrievalResult = await this.retriever.retrieve({
        taskId: input.taskId,
        repositoryId: this.scope.repositoryId,
        userId: this.scope.userId,
        query: input.query,
        limit: input.limit ?? 8,
      });
      degraded = retrievalResult.degraded;
    } catch {
      degraded = true;
      retrievalResult = {
        items: [],
        degraded: true,
        retrievalMode: "memory_only",
      };
    }

    const built = this.ctxBuilder.build({
      workingMemory: wm,
      retrievalResult,
      currentUserRequest: input.currentUserRequest,
      tokenBudget: input.tokenBudget > 0 ? input.tokenBudget : DEFAULT_CONTEXT_BUDGET,
    });

    const items = (retrievalResult?.items ?? []).map((r) => ({
      id: r.memory.id,
      title: r.memory.title,
      score: r.score,
      type: r.memory.type,
    }));

    return {
      promptSection: built.renderedPrompt,
      items,
      degraded,
      tokens: estimateTokens(built.renderedPrompt),
      warnings: built.warnings,
    };
  }

  async onToolResult(input: OnToolResultInput): Promise<void> {
    const rawOutput =
      typeof input.rawPayload === "string"
        ? input.rawPayload
        : input.rawPayload !== undefined
          ? JSON.stringify(input.rawPayload).slice(0, 16_000)
          : input.summary;

    const processed = this.toolProcessor.process({
      toolCallId: input.idempotencyKey,
      toolName: input.toolName,
      toolType: classifyToolType(input.toolName),
      status: input.ok ? "SUCCESS" : "FAILURE",
      rawOutput,
      exitCode: input.exitCode,
      durationMs: input.durationMs ?? 0,
    });

    await executionRecorder.record({
      idempotencyKey: input.idempotencyKey,
      taskId: input.taskId,
      attemptId: input.taskId,
      toolCallId: input.idempotencyKey,
      toolName: input.toolName,
      toolType: classifyToolType(input.toolName),
      inputSummary: summarizeArgs(input.args),
      executionStatus: input.ok ? "SUCCESS" : "FAILURE",
      resultSummary: processed.summary.slice(0, 500),
      exitCode: input.exitCode,
      durationMs: input.durationMs ?? 0,
      verificationLevel: "EXECUTED",
      errors: processed.errors.map((e) => ({
        errorType: e.errorType,
        message: e.message,
      })),
    });

    await this.withWmRetry(input.taskId, async (wm) => {
      const now = new Date().toISOString();
      const toolStatus: ToolExecutionSummary["status"] = input.ok
        ? "success"
        : "failure";
      const executedTools: ToolExecutionSummary[] = [
        ...wm.executedTools,
        {
          toolCallId: input.idempotencyKey,
          toolName: input.toolName,
          status: toolStatus,
          summary: processed.summary.slice(0, 300),
          executedAt: now,
        },
      ].slice(-50);

      let readFiles = [...wm.readFiles];
      let modifiedFiles = [...wm.modifiedFiles];

      const filePath =
        stringArg(input.args, "path") ?? stringArg(input.args, "file");
      if (filePath && input.ok) {
        if (
          input.toolName.includes("read") ||
          input.toolName.endsWith("read_file")
        ) {
          const activity: FileActivity = {
            filePath,
            action: "read",
            timestamp: now,
          };
          readFiles = upsertFile(readFiles, activity).slice(-40);
        }
        if (
          input.toolName.includes("write") ||
          input.toolName.includes("edit") ||
          input.toolName.includes("apply_patch")
        ) {
          const activity: FileActivity = {
            filePath,
            action: input.toolName.includes("write") ? "created" : "modified",
            timestamp: now,
          };
          modifiedFiles = upsertFile(modifiedFiles, activity).slice(-40);
        }
      }

      // 失败测试启发式
      let currentTestSummary = wm.currentTestSummary;
      if (
        !input.ok &&
        /test|vitest|jest|pytest|bun test/i.test(
          `${input.toolName} ${input.summary}`,
        )
      ) {
        currentTestSummary = {
          total: 1,
          passed: 0,
          failed: 1,
          skipped: 0,
          failures: [
            {
              testName: input.toolName,
              message: processed.summary.slice(0, 200),
            },
          ],
        };
      }

      return {
        executedTools,
        readFiles,
        modifiedFiles,
        currentTestSummary,
      };
    });
  }

  async patchWorkingMemory(input: PatchWorkingMemoryInput): Promise<void> {
    const { patch } = input;
    await this.withWmRetry(input.taskId, async (wm) => {
      const next: Partial<WorkingMemory> = {};

      if (patch.goal !== undefined) next.goal = patch.goal;

      if (patch.plan !== undefined) {
        const now = new Date().toISOString();
        const plan: PlanStep[] = patch.plan.map((description, i) => {
          const existing = wm.plan[i];
          return (
            existing ?? {
              id: `plan_${i + 1}`,
              order: i,
              description,
              status: "pending" as const,
              dependsOn: [],
              createdAt: now,
              updatedAt: now,
            }
          );
        });
        // 更新 description（若复用 id）
        for (let i = 0; i < plan.length; i++) {
          const desc = patch.plan[i]!;
          if (plan[i]!.description !== desc) {
            plan[i] = {
              ...plan[i]!,
              description: desc,
              updatedAt: now,
            };
          }
        }
        next.plan = plan;
      }

      if (patch.constraints !== undefined) {
        const now = new Date().toISOString();
        const constraints: WorkingConstraint[] = patch.constraints.map(
          (text, i) =>
            wm.constraints.find((c) => c.text === text) ?? {
              id: `cst_${i + 1}_${generateId("x").slice(-6)}`,
              text,
              source: "user_followup" as const,
              priority: 10,
              confirmed: true,
              temporary: false,
              createdAt: now,
            },
        );
        next.constraints = constraints;
      }

      if (patch.nextStep !== undefined) {
        next.nextAction = patch.nextStep
          ? { description: patch.nextStep, reason: "agent_plan" }
          : undefined;
      }

      if (patch.currentHypothesis !== undefined) {
        const now = new Date().toISOString();
        next.activeHypotheses = patch.currentHypothesis
          ? [
              {
                id: wm.activeHypotheses[0]?.id ?? generateId("hyp"),
                statement: patch.currentHypothesis,
                status: "proposed" as const,
                evidenceFor: [],
                evidenceAgainst: [],
                relatedFiles: [],
                relatedSymbols: [],
                createdAt: now,
                updatedAt: now,
              },
            ]
          : [];
      }

      if (patch.rejectedHypotheses !== undefined) {
        const now = new Date().toISOString();
        next.rejectedHypotheses = patch.rejectedHypotheses.map((text, i) => ({
          id: `rej_${i}`,
          statement: text,
          status: "rejected" as const,
          evidenceFor: [],
          evidenceAgainst: [],
          relatedFiles: [],
          relatedSymbols: [],
          createdAt: now,
          updatedAt: now,
        }));
      }

      if (patch.pinnedFacts !== undefined) {
        const now = new Date().toISOString();
        const pinned: WorkingConstraint[] = patch.pinnedFacts.map((text, i) => ({
          id: `pin_${i}`,
          text,
          source: "runtime" as const,
          priority: 20,
          confirmed: true,
          temporary: false,
          createdAt: now,
        }));
        const nonPinned = (next.constraints ?? wm.constraints).filter(
          (c) => !c.id.startsWith("pin_"),
        );
        next.constraints = [...nonPinned, ...pinned];
      }

      if (patch.knownNonGoals !== undefined) {
        const now = new Date().toISOString();
        const nonGoals: WorkingConstraint[] = patch.knownNonGoals.map(
          (text, i) => ({
            id: `nongoal_${i}`,
            text: `Non-goal: ${text}`,
            source: "runtime" as const,
            priority: 5,
            confirmed: true,
            temporary: true,
            createdAt: now,
          }),
        );
        const base = (next.constraints ?? wm.constraints).filter(
          (c) => !c.id.startsWith("nongoal_"),
        );
        next.constraints = [...base, ...nonGoals];
      }

      return next;
    });
  }

  async completeTask(input: CompleteTaskInput): Promise<CompleteTaskResult> {
    const task = await this.taskMgr.getTask(input.taskId);
    if (!task) throw new Error(`TaskSession not found: ${input.taskId}`);

    // 可选最终消息 → completedSteps
    if (input.finalMessage?.trim()) {
      await this.withWmRetry(input.taskId, async (wm) => {
        const step = {
          id: generateId("done"),
          summary: input.finalMessage!.slice(0, 500),
          toolCallIds: [] as string[],
          completedAt: new Date().toISOString(),
        };
        return {
          completedSteps: [...wm.completedSteps, step].slice(-30),
        };
      });
    }

    // 快照 + 状态迁移
    try {
      await this.wmMgr.createSnapshot(input.taskId, "task_complete", {
        actorType: "system",
        actorId: "memory-runtime",
      });
    } catch {
      /* best-effort */
    }

    const fresh = await this.taskMgr.getTask(input.taskId);
    if (!fresh) throw new Error(`TaskSession not found: ${input.taskId}`);

    if (fresh.status === "running" || fresh.status === "pending") {
      if (input.status === "completed") {
        await this.taskMgr.completeTask(fresh.id, fresh.revision);
      } else if (input.status === "failed") {
        await this.taskMgr.failTask(fresh.id, fresh.revision);
      } else {
        await this.taskMgr.cancelTask(fresh.id, fresh.revision);
      }
    }

    // cancelled：不自动写长期记忆
    if (input.status === "cancelled") {
      return {
        candidates: 0,
        approved: 0,
        rejected: 0,
        pendingReview: 0,
        writtenMemoryIds: [],
      };
    }

    const wm = await this.requireWm(input.taskId);
    const candidates = await this.writer.writeFromFinalSnapshot({
      taskId: input.taskId,
      workingMemory: wm,
      repositoryId: this.scope.repositoryId,
      userId: this.scope.userId,
      actor: { actorType: "system", actorId: "memory-runtime" },
    });

    return this.promoteCandidates(candidates);
  }

  async listMemories(query?: {
    limit?: number;
    type?: string;
  }): Promise<MemoryListItem[]> {
    const items = await memoryItemDao.query({
      type: query?.type as MemoryType | undefined,
      status: "active",
      scopeRepoId: this.scope.repositoryId,
      scopeUserId: this.scope.userId,
      limit: query?.limit ?? 20,
    });
    return items.map((m) =>
      toListItem({
        id: m.id,
        title: m.title,
        summary: m.summary,
        type: m.type,
        status: m.status,
        confidence: m.confidence,
        subjectKey: m.subjectKey,
        relatedFiles: m.relatedFiles,
        updatedAt: m.updatedAt,
      }),
    );
  }

  async readMemory(idOrSubject: string): Promise<MemoryListItem | null> {
    const byId = await memoryItemDao.findById(idOrSubject);
    if (byId) {
      return toListItem({
        id: byId.id,
        title: byId.title,
        summary: byId.summary,
        type: byId.type,
        status: byId.status,
        confidence: byId.confidence,
        subjectKey: byId.subjectKey,
        relatedFiles: byId.relatedFiles,
        updatedAt: byId.updatedAt,
      });
    }
    const bySubject = await memoryItemDao.findBySubjectKey(
      idOrSubject,
      "active",
    );
    const hit = bySubject[0];
    if (!hit) return null;
    return toListItem({
      id: hit.id,
      title: hit.title,
      summary: hit.summary,
      type: hit.type,
      status: hit.status,
      confidence: hit.confidence,
      subjectKey: hit.subjectKey,
      relatedFiles: hit.relatedFiles,
      updatedAt: hit.updatedAt,
    });
  }

  async saveMemory(input: SaveMemoryInput): Promise<SaveMemoryResult> {
    const now = new Date().toISOString();
    const type = normalizeMemoryType(input.type);
    const subjectKey = `manual:${this.scope.repositoryId}:${shaShort(
      `${input.title}\n${input.summary}`,
    )}`;

    const candidate: MemoryCandidate = {
      id: generateId("cand"),
      schemaVersion: 1,
      status: "draft",
      proposedType: type,
      proposedSubjectKey: subjectKey,
      subjectKeyVersion: 1,
      proposedTitle: input.title.slice(0, 200),
      proposedSummary: input.summary.slice(0, 4000),
      proposedPayload: {
        content: input.content ?? input.summary,
        relatedFiles: input.relatedFiles ?? [],
      },
      proposedScope: {
        repositoryId: this.scope.repositoryId,
        userId: this.scope.userId,
        workspaceId: this.scope.workspaceId,
      },
      // 用户显式保存：高置信、低风险，便于自动批准
      proposedConfidence: 0.9,
      sourceTaskIds: input.taskId ? [input.taskId] : [],
      sourceRefs: [
        {
          sourceType: "user_explicit_save",
          capturedAt: now,
          taskId: input.taskId,
        },
      ],
      evidenceRefs: [],
      possibleDuplicateIds: [],
      possibleConflictIds: [],
      riskLevel: "low",
      reviewRequired: false,
      generatedBy: { actorType: "user", actorId: this.scope.userId },
      generationReason: "User explicit memory.save",
      sensitivity: "internal",
      createdAt: now,
      updatedAt: now,
    };

    const created = await memoryCandidateDao.create(candidate);
    const promoted = await this.promoteCandidates([created]);
    return {
      candidateId: created.id,
      decision:
        promoted.writtenMemoryIds.length > 0
          ? "APPROVE_CREATE"
          : promoted.pendingReview > 0
            ? "REQUEST_REVIEW"
            : "REJECT",
      decisionStatus:
        promoted.writtenMemoryIds.length > 0
          ? "EXECUTED"
          : promoted.pendingReview > 0
            ? "PENDING_REVIEW"
            : "REJECTED",
      memoryId: promoted.writtenMemoryIds[0],
    };
  }

  async shutdown(): Promise<void> {
    this.runTaskMap.clear();
    await closeSql();
  }

  // ── internals ──

  private async requireWm(taskId: string): Promise<WorkingMemory> {
    const wm = await this.wmMgr.getByTaskId(taskId);
    if (!wm) throw new Error(`WorkingMemory not found for task ${taskId}`);
    return wm;
  }

  private async withWmRetry(
    taskId: string,
    buildPatch: (wm: WorkingMemory) => Promise<Partial<WorkingMemory>> | Partial<WorkingMemory>,
  ): Promise<WorkingMemory> {
    let lastErr: unknown;
    for (let i = 0; i < MAX_WM_RETRIES; i++) {
      const wm = await this.requireWm(taskId);
      const patch = await buildPatch(wm);
      try {
        return await this.wmMgr.update(taskId, wm.revision, patch);
      } catch (e) {
        lastErr = e;
        if (!(e instanceof RevisionConflictError)) throw e;
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error(`WorkingMemory update failed after ${MAX_WM_RETRIES} retries`);
  }

  /**
   * 对候选批量：evaluate → persist decision → execute APPROVED。
   * APPROVE_MERGE 时补全 targetMemoryId。
   */
  private async promoteCandidates(
    candidates: MemoryCandidate[],
  ): Promise<CompleteTaskResult> {
    let approved = 0;
    let rejected = 0;
    let pendingReview = 0;
    const writtenMemoryIds: string[] = [];

    for (const c of candidates) {
      try {
        const result = await this.governance.evaluate({ candidateId: c.id });
        let decision = result.decision;

        // 补全 MERGE 目标
        if (
          decision.decision === "APPROVE_MERGE" &&
          !decision.targetMemoryId &&
          result.duplicateOf
        ) {
          decision = { ...decision, targetMemoryId: result.duplicateOf };
        }

        await governanceDecisionDao.create(decision);

        if (decision.status === "APPROVED") {
          approved++;
          const exec = await this.executor.execute(decision);
          if (exec.success && exec.memoryId) {
            writtenMemoryIds.push(exec.memoryId);
          }
        } else if (decision.status === "PENDING_REVIEW") {
          pendingReview++;
        } else {
          rejected++;
        }
      } catch {
        rejected++;
      }
    }

    return {
      candidates: candidates.length,
      approved,
      rejected,
      pendingReview,
      writtenMemoryIds,
    };
  }
}

// ── helpers ──

function classifyToolType(toolName: string): string {
  if (toolName.includes("shell") || toolName.includes("bash")) return "shell";
  if (toolName.includes("read")) return "read";
  if (toolName.includes("write") || toolName.includes("edit")) return "write";
  if (toolName.includes("search") || toolName.includes("grep")) return "search";
  if (toolName.startsWith("memory.")) return "memory";
  if (toolName.startsWith("mcp:")) return "mcp";
  return "other";
}

function summarizeArgs(args: unknown): string {
  if (args === undefined) return "";
  try {
    return JSON.stringify(args).slice(0, 400);
  } catch {
    return String(args).slice(0, 400);
  }
}

function upsertFile(
  list: FileActivity[],
  activity: FileActivity,
): FileActivity[] {
  const idx = list.findIndex((f) => f.filePath === activity.filePath);
  if (idx === -1) return [...list, activity];
  const next = [...list];
  next[idx] = activity;
  return next;
}

function normalizeMemoryType(raw?: string): MemoryType {
  const allowed: MemoryType[] = [
    "rule",
    "project_knowledge",
    "task_summary",
    "decision",
    "user_preference",
    "skill",
    "failure",
  ];
  if (raw && (allowed as string[]).includes(raw)) return raw as MemoryType;
  // 旧 type 映射
  if (raw === "user" || raw === "feedback") return "user_preference";
  if (raw === "project" || raw === "reference") return "project_knowledge";
  return "project_knowledge";
}

function shaShort(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

/** 工厂：创建 MemoryRuntime */
export async function createMemoryRuntime(
  opts: MemoryRuntimeOptions,
): Promise<MemoryRuntime> {
  return new MemoryRuntimeImpl(opts);
}
