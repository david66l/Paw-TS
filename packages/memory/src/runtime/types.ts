/**
 * MemoryRuntime 对外稳定 DTO。
 * Agent / harness 只依赖这些类型，不直接依赖 db 内部实体。
 */

export interface MemoryRuntimeOptions {
  readonly workspaceRoot: string;
  readonly userId?: string;
  readonly repositoryId?: string;
  readonly workspaceId?: string;
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

export interface MemoryRuntime {
  ping(): Promise<boolean>;
  beginTask(input: BeginTaskInput): Promise<BeginTaskResult>;
  buildContextSection(input: BuildContextInput): Promise<BuildContextResult>;
  onToolResult(input: OnToolResultInput): Promise<void>;
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
