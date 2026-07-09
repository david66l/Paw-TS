/**
 * Task Session Manager (8.4)
 *
 * 管理一次 Coding Agent 任务的生命周期：创建、启动、完成、失败、暂停。
 * MVP 只实现 CREATED → RUNNING → COMPLETED/FAILED/CANCELLED。
 */

import { taskSessionDao } from "../../dao/taskSession.js";
import { workingMemoryDao } from "../../dao/workingMemory.js";
import type { TaskSession, WorkingMemory } from "../../types.js";
import { generateId } from "../platform/idGen.js";
import { PolicyEngine, type EffectivePolicy } from "../platform/policyEngine.js";

export interface CreateTaskInput {
  userId?: string;
  workspaceId?: string;
  repositoryId?: string;
  initialUserRequest: string;
  title?: string;
  branch?: string;
  baseCommit?: string;
}

export class TaskSessionManager {
  private policyEngine?: PolicyEngine;

  constructor(policyEngine?: PolicyEngine) {
    this.policyEngine = policyEngine;
  }

  /** 获取当前 Task Session 使用的 EffectivePolicy */
  async getEffectivePolicy(input: CreateTaskInput): Promise<EffectivePolicy> {
    if (this.policyEngine) {
      return this.policyEngine.resolve({ repositoryId: input.repositoryId, userId: input.userId });
    }
    return new PolicyEngine().getDefaults();
  }

  /**
   * 创建 TaskSession + 初始化 WorkingMemory + 绑定 PolicySnapshot。
   * 返回 { task, wm } 或抛出错误。
   */
  async createTask(input: CreateTaskInput): Promise<{ task: TaskSession; wm: WorkingMemory }> {
    const now = new Date().toISOString();
    const taskId = generateId("tsk");
    const wmId = generateId("wm");

    const task: TaskSession = {
      id: taskId,
      schemaVersion: 1,
      userId: input.userId,
      workspaceId: input.workspaceId,
      repositoryId: input.repositoryId,
      rootTaskId: taskId,
      initialUserRequest: input.initialUserRequest,
      title: input.title,
      status: "pending",
      branch: input.branch,
      baseCommit: input.baseCommit,
      currentWorkingMemoryId: wmId,
      createdAt: now,
      updatedAt: now,
      revision: 1,
    };

    const wm: WorkingMemory = {
      id: wmId,
      taskId,
      revision: 1,
      goal: "",
      constraints: [],
      plan: [],
      todos: [],
      completedSteps: [],
      readFiles: [],
      modifiedFiles: [],
      executedTools: [],
      testRunIds: [],
      activeHypotheses: [],
      rejectedHypotheses: [],
      openQuestions: [],
      contextPointers: [],
      createdAt: now,
      updatedAt: now,
    };

    await taskSessionDao.create(task);
    await workingMemoryDao.create(wm);

    // 绑定 PolicySnapshot
    if (this.policyEngine) {
      await this.policyEngine.createSnapshot(taskId, { repositoryId: input.repositoryId, userId: input.userId });
    }

    return { task, wm };
  }

  /** 启动任务：CREATED → RUNNING */
  async startTask(id: string, expectedRevision: number): Promise<TaskSession> {
    const result = await taskSessionDao.updateStatus(id, expectedRevision, "running", {
      startedAt: new Date().toISOString(),
    });
    if (!result) throw new RevisionConflictError("taskSession", id, expectedRevision);
    return result;
  }

  /** 完成任务：RUNNING → COMPLETED */
  async completeTask(id: string, expectedRevision: number): Promise<TaskSession> {
    const result = await taskSessionDao.updateStatus(id, expectedRevision, "completed", {
      completedAt: new Date().toISOString(),
    });
    if (!result) throw new RevisionConflictError("taskSession", id, expectedRevision);
    return result;
  }

  /** 标记失败：RUNNING → FAILED */
  async failTask(id: string, expectedRevision: number): Promise<TaskSession> {
    const result = await taskSessionDao.updateStatus(id, expectedRevision, "failed", {
      completedAt: new Date().toISOString(),
    });
    if (!result) throw new RevisionConflictError("taskSession", id, expectedRevision);
    return result;
  }

  /** 取消任务 */
  async cancelTask(id: string, expectedRevision: number): Promise<TaskSession> {
    const result = await taskSessionDao.updateStatus(id, expectedRevision, "cancelled", {
      completedAt: new Date().toISOString(),
    });
    if (!result) throw new RevisionConflictError("taskSession", id, expectedRevision);
    return result;
  }

  async getTask(id: string): Promise<TaskSession | null> {
    return taskSessionDao.findById(id);
  }
}

export class RevisionConflictError extends Error {
  constructor(
    public entity: string,
    public id: string,
    public expectedRevision: number,
  ) {
    super(`Revision conflict: ${entity}#${id} expected revision ${expectedRevision}`);
    this.name = "RevisionConflictError";
  }
}
