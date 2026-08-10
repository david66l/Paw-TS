/**
 * MemoryRuntime 对外稳定 DTO。
 * Agent / harness 只依赖这些类型，不直接依赖 db 内部实体。
 */

import type { RunEvent } from "@paw/core";

/** completeTask 可选 enricher 产出的候选草稿（仍须经 Governance） */
export type MemoryCandidateEnrichmentDraft = {
  readonly title: string;
  readonly summary: string;
  readonly type:
    | "user_preference"
    | "decision"
    | "failure"
    | "project_knowledge"
    | "rule"
    | "skill"
    | "task_summary";
  readonly confidence?: number;
};

export type MemoryCandidateEnricher = (input: {
  readonly taskId: string;
  readonly goal: string;
  readonly workingMemoryGoal: string;
}) => Promise<readonly MemoryCandidateEnrichmentDraft[]>;

/** v2 LLM 适配器（可选）。缺失时优雅降级：无蒸馏 → append-only；无裁决 → 直 ADD；无精排 → 召回直取 */
export interface MemoryRuntimeLlm {
  /** 蒸馏（DistillerLlm.complete）——通常用 agent 模型 */
  readonly distill?: (prompt: string) => Promise<string>;
  /** 裁决（GovernorLlm.complete）——spec A10：裁决用强模型 */
  readonly govern?: (prompt: string) => Promise<string>;
  /** 精排 / T1 query 改写（RerankerLlm.complete）——通常用快模型 */
  readonly rerank?: (prompt: string) => Promise<string>;
  /** 用户纠正确认器（CorrectionConfirmer.confirm） */
  readonly confirm?: (text: string) => Promise<boolean>;
}

export interface MemoryRuntimeOptions {
  readonly workspaceRoot: string;
  readonly userId?: string;
  readonly repositoryId?: string;
  readonly workspaceId?: string;
  /**
   * 可选：completeTask 时追加候选（默认不传 = noop）。
   * 抛错不影响主 complete 路径。
   */
  readonly candidateEnricher?: MemoryCandidateEnricher;
  /**
   * v2 运行时 LLM 适配器（可选；缺失走降级路径）。
   * null = off 模式：禁用全部 LLM（含 settings 解析）。
   */
  readonly llm?: MemoryRuntimeLlm | null;
  /**
   * v2 每日蒸馏 LLM 调用预算（默认 50，spec §5.2 成本熔断）。
   * 注意：计数按全库当日 op-log（跨 repo 共享），共享测试库需抬高避免误熔断。
   */
  readonly dailyBudget?: number;
  /** v2 写入/检索 RunEvent 发射（memory.write.* / memory.governed / memory.trigger / memory.inject） */
  readonly emit?: (event: RunEvent) => void;
  /** 运行时选择：v2（默认）/ v1（回滚）。亦可用 PAW_MEMORY_RUNTIME 环境变量 */
  readonly runtime?: "v1" | "v2";
}

export interface BeginTaskInput {
  readonly runId: string;
  readonly goal: string;
  readonly title?: string;
  readonly branch?: string;
  readonly baseCommit?: string;
  /** 恢复已有 TaskSession（可选） */
  readonly resumeTaskId?: string;
}

export interface BeginTaskResult {
  readonly taskId: string;
  readonly resumed: boolean;
}

export interface BuildContextInput {
  readonly taskId: string;
  readonly query: string;
  readonly tokenBudget: number;
  readonly currentUserRequest: string;
  readonly limit?: number;
}

export interface ContextSectionItem {
  readonly id: string;
  readonly title: string;
  readonly score: number;
  readonly type?: string;
  /** 摘要（供 UI / 事件，可截断） */
  readonly summary?: string;
  readonly relatedFiles?: readonly string[];
}

export interface BuildContextResult {
  readonly promptSection: string;
  readonly items: readonly ContextSectionItem[];
  readonly degraded: boolean;
  readonly tokens: number;
  readonly warnings: readonly string[];
}

export interface OnToolResultInput {
  readonly taskId: string;
  readonly toolName: string;
  readonly args: unknown;
  readonly ok: boolean;
  readonly summary: string;
  readonly rawPayload?: unknown;
  readonly idempotencyKey: string;
  readonly durationMs?: number;
  readonly exitCode?: number;
}

export interface WorkingMemoryPatch {
  readonly goal?: string;
  readonly plan?: readonly string[];
  readonly constraints?: readonly string[];
  readonly nextStep?: string;
  readonly currentHypothesis?: string;
  readonly rejectedHypotheses?: readonly string[];
  readonly pinnedFacts?: readonly string[];
  readonly knownNonGoals?: readonly string[];
}

export interface PatchWorkingMemoryInput {
  readonly taskId: string;
  readonly patch: WorkingMemoryPatch;
}

export interface CompleteTaskInput {
  readonly taskId: string;
  readonly finalMessage?: string;
  readonly status: "completed" | "failed" | "cancelled";
}

export interface CompleteTaskResult {
  readonly candidates: number;
  readonly approved: number;
  readonly rejected: number;
  readonly pendingReview: number;
  readonly writtenMemoryIds: readonly string[];
}

export interface MemoryListItem {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly type: string;
  readonly status: string;
  readonly confidence: number;
  readonly subjectKey?: string;
  readonly relatedFiles?: readonly string[];
  readonly updatedAt?: string;
}

export interface SaveMemoryInput {
  readonly title: string;
  readonly summary: string;
  readonly type?: string;
  readonly content?: string;
  readonly relatedFiles?: readonly string[];
  /** 关联任务（可选） */
  readonly taskId?: string;
}

export interface SaveMemoryResult {
  readonly candidateId: string;
  readonly decision: string;
  readonly decisionStatus: string;
  readonly memoryId?: string;
}

/**
 * 记忆运行时门面（Agent 唯一推荐入口）。
 * v1（memory-runtime.ts）与 v2（memory-runtime-v2.ts）共享此接口。
 */
export interface MemoryRuntime {
  ping(): Promise<boolean>;
  beginTask(input: BeginTaskInput): Promise<BeginTaskResult>;
  buildContextSection(input: BuildContextInput): Promise<BuildContextResult>;
  /**
   * 工具结果处理。
   * v2 在工具失败且检索命中时返回 { injected }（T2 action_failed 注入段，
   * 调用方追加为用户消息）；v1 恒返回 undefined。
   */
  onToolResult(
    input: OnToolResultInput,
  ): Promise<{ injected?: string } | undefined>;
  /**
   * v2：T3 post_compact 检索（上下文压缩后触发）。
   * 命中时返回注入段（调用方追加为用户消息）；v1 无此方法。
   */
  retrievePostCompact?(input: {
    readonly taskId: string;
    readonly summaryHead: string;
    readonly goal: string;
    readonly existingContextHints?: readonly string[];
  }): Promise<{ injected?: string } | undefined>;
  patchWorkingMemory(input: PatchWorkingMemoryInput): Promise<void>;
  completeTask(input: CompleteTaskInput): Promise<CompleteTaskResult>;
  listMemories(query?: {
    limit?: number;
    type?: string;
  }): Promise<MemoryListItem[]>;
  readMemory(idOrSubject: string): Promise<MemoryListItem | null>;
  saveMemory(input: SaveMemoryInput): Promise<SaveMemoryResult>;
  shutdown(): Promise<void>;
  /** 当前 scope（调试 / 事件用） */
  readonly scope: {
    readonly userId: string;
    readonly repositoryId: string;
    readonly workspaceId: string;
    readonly workspaceRoot: string;
  };
}
