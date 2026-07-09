/**
 * Working Memory Manager (8.5)
 *
 * 维护当前任务的短期工作状态。revision 乐观锁，冲突时拒绝覆盖。
 */

import { workingMemoryDao } from "../../dao/workingMemory.js";
import type { WorkingMemory, WorkingMemorySnapshot, ActorRef } from "../../types.js";
import { generateId } from "../platform/idGen.js";
import { RevisionConflictError } from "./taskSessionManager.js";

export class WorkingMemoryManager {
  async getByTaskId(taskId: string): Promise<WorkingMemory | null> {
    return workingMemoryDao.findByTaskId(taskId);
  }

  /**
   * 更新 WorkingMemory。必须提供 expectedRevision，不匹配时抛出 RevisionConflictError。
   * 返回更新后的 WorkingMemory（含新 revision）。
   */
  async update(taskId: string, expectedRevision: number, patch: Partial<WorkingMemory>): Promise<WorkingMemory> {
    const current = await workingMemoryDao.findByTaskId(taskId);
    if (!current) throw new Error(`WorkingMemory not found for task ${taskId}`);

    if (current.revision !== expectedRevision) {
      throw new RevisionConflictError("workingMemory", taskId, expectedRevision);
    }

    // 合并 patch 到 current
    const updated: WorkingMemory = {
      ...current,
      ...patch,
      id: current.id,
      taskId: current.taskId,
      revision: current.revision, // DAO 会递增
      updatedAt: new Date().toISOString(),
    };

    const result = await workingMemoryDao.update(current.id, expectedRevision, updated);
    if (!result) throw new RevisionConflictError("workingMemory", taskId, expectedRevision);
    return result;
  }

  /**
   * 创建 WorkingMemory 快照。用于任务暂停、恢复、完成时保存状态。
   */
  async createSnapshot(
    taskId: string,
    reason: WorkingMemorySnapshot["reason"],
    actor: ActorRef = { actorType: "system", actorId: "wm-manager" },
  ): Promise<WorkingMemorySnapshot> {
    const wm = await workingMemoryDao.findByTaskId(taskId);
    if (!wm) throw new Error(`WorkingMemory not found for task ${taskId}`);

    const snap: WorkingMemorySnapshot = {
      id: generateId("wmsnap"),
      taskId,
      workingMemoryId: wm.id,
      workingMemoryRevision: wm.revision,
      reason,
      snapshot: structuredClone(wm),
      createdBy: actor,
      createdAt: new Date().toISOString(),
    };

    return workingMemoryDao.createSnapshot(snap);
  }

  /** 列出任务的所有快照 */
  async listSnapshots(taskId: string): Promise<WorkingMemorySnapshot[]> {
    return workingMemoryDao.listSnapshots(taskId);
  }
}
