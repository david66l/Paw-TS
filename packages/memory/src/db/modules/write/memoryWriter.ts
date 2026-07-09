/**
 * Memory Writer (8.10)
 *
 * 从任务结束快照 + 执行记录中生成 MemoryCandidate。
 * MVP: 只从 Task Final Snapshot 生成，不支持流式增量。
 *
 * 铁律: MemoryWriter 只写 memory_candidates 表，不直接创建 memory_items。
 */

import { memoryCandidateDao } from "../../dao/memoryCandidate.js";
import { executionRecorder } from "../task/executionRecorder.js";
import type { MemoryCandidate, WorkingMemory, MemoryType, ActorRef, ScopeDescriptor } from "../../types.js";
import { generateId } from "../platform/idGen.js";
import { PolicyEngine, type WritePolicy } from "../platform/policyEngine.js";

export interface WriteInput {
  taskId: string;
  workingMemory: WorkingMemory;
  repositoryId?: string;
  userId?: string;
  actor?: ActorRef;
}

export class MemoryWriter {
  private policy: WritePolicy;

  constructor(policyEngine?: PolicyEngine) {
    this.policy = policyEngine?.getDefaults().write ?? new PolicyEngine().getDefaults().write;
  }
  /**
   * 从任务结束状态生成候选记忆。
   * 返回生成的候选列表（可能为空）。
   */
  async writeFromFinalSnapshot(input: WriteInput): Promise<MemoryCandidate[]> {
    const candidates: MemoryCandidate[] = [];
    const now = new Date().toISOString();
    const scope = this.buildScope(input);

    // 1. Task Summary Candidate
    const summary = this.buildTaskSummary(input);
    if (summary) candidates.push(summary);

    // 2. Decision Candidates（从 completedSteps 提取关键决策）
    const decisions = this.buildDecisionCandidates(input, scope, now);
    candidates.push(...decisions);

    // 3. Failure Candidates（从执行记录提取失败工具调用）
    const failures = await this.buildFailureCandidates(input, scope, now);
    candidates.push(...failures);

    // 4. Project Knowledge Candidates（从 diff/文件变更提取项目事实）
    const knowledge = this.buildProjectKnowledgeCandidates(input, scope, now);
    candidates.push(...knowledge);

    // 5. User Preference Candidates（从 workingMemory 中明确的用户反馈提取）
    const prefs = this.buildPreferenceCandidates(input, scope, now);
    candidates.push(...prefs);

    // 策略过滤：禁用自动生成 → 直接返回空
    if (!this.policy.autoGenerationEnabled) return [];

    const filtered = candidates
      .filter((c) => c.proposedConfidence >= this.policy.minConfidence)
      .slice(0, this.policy.maxCandidatesPerTask);

    const results: MemoryCandidate[] = [];
    for (const c of filtered) {
      const created = await memoryCandidateDao.create(c);
      results.push(created);
    }
    return results;
  }

  // ── Private builders ──

  private buildTaskSummary(input: WriteInput): MemoryCandidate | null {
    const { taskId, workingMemory: wm, actor } = input;
    const now = new Date().toISOString();
    const summaryLines: string[] = [];

    if (wm.goal) summaryLines.push(`Goal: ${wm.goal}`);
    summaryLines.push(`Steps completed: ${wm.completedSteps.length}`);
    for (const step of wm.completedSteps) {
      summaryLines.push(`- ${step.summary}`);
    }
    if (wm.diffSummary) {
      summaryLines.push(`Files changed: ${wm.diffSummary.filesChanged}, +${wm.diffSummary.insertions} -${wm.diffSummary.deletions}`);
    }

    if (summaryLines.length === 0) return null;

    return {
      id: generateId("cand"),
      schemaVersion: 1,
      status: "draft",
      proposedType: "task_summary",
      proposedSubjectKey: `task_summary:${input.repositoryId ?? "unknown"}:${taskId}`,
      subjectKeyVersion: 1,
      proposedTitle: wm.goal || `Task ${taskId}`,
      proposedSummary: summaryLines.join("\n"),
      proposedPayload: {
        taskId,
        goal: wm.goal,
        outcome: "success",
        summary: summaryLines.join("\n"),
        modifiedFiles: wm.modifiedFiles.map((f) => f.filePath),
        createdFiles: [],
        deletedFiles: [],
        toolCallIds: wm.executedTools.map((t) => t.toolCallId),
        testRunIds: wm.testRunIds,
        keyActions: wm.completedSteps.map((s) => s.summary),
        decisionMemoryIds: [],
        unresolvedQuestions: wm.openQuestions.map((q) => q.question),
        unresolvedRisks: [],
      },
      proposedScope: this.buildScope(input),
      proposedConfidence: 0.7,
      sourceTaskIds: [taskId],
      sourceRefs: [{ sourceType: "task_trace", taskId, capturedAt: now }],
      evidenceRefs: [],
      possibleDuplicateIds: [],
      possibleConflictIds: [],
      riskLevel: "low",
      reviewRequired: false,
      generatedBy: actor ?? { actorType: "system", actorId: "memory-writer" },
      generationReason: "task_completion",
      sensitivity: "internal",
      createdAt: now,
      updatedAt: now,
    };
  }

  private buildDecisionCandidates(input: WriteInput, scope: ScopeDescriptor, now: string): MemoryCandidate[] {
    const decisions: MemoryCandidate[] = [];
    // 从 completedSteps 提取带有明显决策标记的步骤
    const decisionSteps = input.workingMemory.completedSteps.filter((s) =>
      s.summary.toLowerCase().includes("decided") ||
      s.summary.toLowerCase().includes("chose") ||
      s.summary.toLowerCase().includes("opted")
    );

    for (const step of decisionSteps) {
      decisions.push({
        id: generateId("cand"),
        schemaVersion: 1,
        status: "draft",
        proposedType: "decision",
        proposedSubjectKey: `decision:${input.repositoryId ?? "unknown"}:${step.id}`,
        subjectKeyVersion: 1,
        proposedTitle: `Decision: ${step.summary.slice(0, 80)}`,
        proposedSummary: step.summary,
        proposedPayload: {
          decision: step.summary,
          context: input.workingMemory.goal,
          constraints: [],
          alternatives: [],
          rationale: [step.summary],
          consequences: [],
          risks: [],
          decisionStatus: "accepted",
        },
        proposedScope: scope,
        proposedConfidence: 0.6,
        sourceTaskIds: [input.taskId],
        sourceRefs: [{ sourceType: "task_trace", taskId: input.taskId, capturedAt: now }],
        evidenceRefs: step.toolCallIds.map((_tcid) => ({
          evidenceType: "tool_result",
          capturedAt: now,
          strength: "supporting",
        })),
        possibleDuplicateIds: [],
        possibleConflictIds: [],
        riskLevel: "low",
        reviewRequired: false,
        generatedBy: input.actor ?? { actorType: "system", actorId: "memory-writer" },
        generationReason: "decision_extraction",
        sensitivity: "internal",
        createdAt: now,
        updatedAt: now,
      });
    }
    return decisions;
  }

  private async buildFailureCandidates(input: WriteInput, scope: ScopeDescriptor, now: string): Promise<MemoryCandidate[]> {
    const candidates: MemoryCandidate[] = [];
    const summary = await executionRecorder.getSummary(input.taskId);

    for (const failure of summary.failures) {
      candidates.push({
        id: generateId("cand"),
        schemaVersion: 1,
        status: "draft",
        proposedType: "failure",
        proposedSubjectKey: `failure:${input.repositoryId ?? "unknown"}:${failure.toolName}`,
        subjectKeyVersion: 1,
        proposedTitle: `Failure: ${failure.toolName}`,
        proposedSummary: failure.errorSummary,
        proposedPayload: {
          errorPattern: failure.errorSummary,
          symptoms: [failure.errorSummary],
          triggeringConditions: [],
          ineffectiveAttempts: [],
          failureStatus: "observed",
        },
        proposedScope: scope,
        proposedConfidence: 0.5,
        sourceTaskIds: [input.taskId],
        sourceRefs: [{ sourceType: "tool_result", taskId: input.taskId, capturedAt: now }],
        evidenceRefs: [{
          evidenceType: "tool_result",
          capturedAt: now,
          strength: "supporting",
        }],
        possibleDuplicateIds: [],
        possibleConflictIds: [],
        riskLevel: "medium",
        reviewRequired: true, // 失败经验需要 review
        generatedBy: input.actor ?? { actorType: "system", actorId: "memory-writer" },
        generationReason: "failure_extraction",
        sensitivity: "internal",
        createdAt: now,
        updatedAt: now,
      });
    }
    return candidates;
  }

  private buildProjectKnowledgeCandidates(input: WriteInput, scope: ScopeDescriptor, now: string): MemoryCandidate[] {
    const { workingMemory: wm } = input;
    if (!wm.diffSummary || wm.diffSummary.filesChanged === 0) return [];

    // 从文件变更中提取项目知识
    const files = [...new Set(wm.modifiedFiles.map((f) => f.filePath))];
    if (files.length === 0) return [];

    return [{
      id: generateId("cand"),
      schemaVersion: 1,
      status: "draft",
      proposedType: "project_knowledge",
      proposedSubjectKey: `project_knowledge:${input.repositoryId ?? "unknown"}:files_modified_${Date.now()}`,
      subjectKeyVersion: 1,
      proposedTitle: `Modified files in ${input.repositoryId ?? "unknown"}`,
      proposedSummary: `Modified ${files.length} files: ${files.slice(0, 5).join(", ")}${files.length > 5 ? "..." : ""}`,
      proposedPayload: {
        assertion: `Task ${input.taskId} modified ${files.length} files`,
        knowledgeKind: "repository_structure",
        stability: "inferred",
      },
      proposedScope: scope,
      proposedConfidence: 0.5,
      sourceTaskIds: [input.taskId],
      sourceRefs: [{ sourceType: "task_trace", taskId: input.taskId, capturedAt: now }],
      evidenceRefs: files.slice(0, 3).map((fp) => ({
        evidenceType: "file",
        filePath: fp,
        capturedAt: now,
        strength: "weak",
      })),
      possibleDuplicateIds: [],
      possibleConflictIds: [],
      riskLevel: "low",
      reviewRequired: false,
      generatedBy: input.actor ?? { actorType: "system", actorId: "memory-writer" },
      generationReason: "knowledge_extraction",
      sensitivity: "internal",
      createdAt: now,
      updatedAt: now,
    }];
  }

  private buildPreferenceCandidates(input: WriteInput, scope: ScopeDescriptor, now: string): MemoryCandidate[] {
    // 从 WorkingMemory 的 user_feedback 约束中提取偏好
    const feedbackConstraints = input.workingMemory.constraints.filter(
      (c) => c.source === "user_followup" && !c.temporary
    );

    return feedbackConstraints.map((c) => ({
      id: generateId("cand"),
      schemaVersion: 1,
      status: "draft",
      proposedType: "user_preference" as MemoryType,
      proposedSubjectKey: `preference:user:${input.userId ?? "unknown"}:${c.id}`,
      subjectKeyVersion: 1,
      proposedTitle: `User preference: ${c.text.slice(0, 80)}`,
      proposedSummary: c.text,
      proposedPayload: {
        preferenceKey: c.id,
        value: c.text,
        origin: "explicit" as const,
        strength: c.temporary ? "soft" as const : "default" as const,
        appliesTo: "coding_style" as const,
        observationCount: 1,
        firstObservedAt: c.createdAt,
        lastObservedAt: c.createdAt,
        overridePolicy: "ask_on_conflict" as const,
      },
      proposedScope: { ...scope, userId: input.userId },
      proposedConfidence: c.confirmed ? 0.85 : 0.5,
      sourceTaskIds: [input.taskId],
      sourceRefs: [{ sourceType: "user_explicit", taskId: input.taskId, capturedAt: now }],
      evidenceRefs: [{
        evidenceType: "user_message",
        capturedAt: now,
        strength: "strong",
      }],
      possibleDuplicateIds: [],
      possibleConflictIds: [],
      riskLevel: c.temporary ? "low" : "medium",
      reviewRequired: !c.confirmed,
      generatedBy: input.actor ?? { actorType: "system", actorId: "memory-writer" },
      generationReason: "preference_extraction",
      sensitivity: "confidential",
      createdAt: now,
      updatedAt: now,
    }));
  }

  private buildScope(input: WriteInput): ScopeDescriptor {
    return {
      lifecycleScope: "persistent",
      repositoryId: input.repositoryId,
      userId: input.userId,
    };
  }
}
