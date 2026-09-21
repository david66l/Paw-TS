/**
 * M10 夹具 scope 清理（per-fixture 唯一 repository_id 隔离 + 完整回收）
 * ================================================================
 *
 * 【为什么】
 * 每个夹具用独立 repository_id（m10-<id>-<ts36>），seed + orchestrator 运行
 * 的全部写入都被隔离在该 scope。跑完（非 --keep）按 repo 物理删除：
 * - memory_items 删除级联 embeddings/versions/index_states/relations/usage_records
 * - task_sessions 删除级联 working_memories/entries/checkpoints/tool_results/
 *   attempts/trace_events/test_runs
 * - governance_decisions **无 FK 无级联**（V005：candidate_id/resulting_memory_id
 *   /target_memory_id 都是裸 text）→ 必须显式删，否则成为孤儿行（cutover 测试泄漏点）
 * - memory_op_log 是 longterm store 的表（online runtime 不写），防御性清理
 */

import { type getSql } from "@paw/memory/db";

/** 全局 sql pool 连接类型（eval 不直接依赖 postgres 包，复用 @paw/memory/db 导出） */
export type FixtureSql = ReturnType<typeof getSql>;

/** 按 repository_id 清理该 scope 的全部记忆数据（幂等，可重复调用） */
export async function cleanupFixtureRepo(sql: FixtureSql, repo: string): Promise<void> {
  await sql`
    DELETE FROM governance_decisions
    WHERE candidate_id IN (
      SELECT id FROM memory_candidates WHERE proposed_scope->>'repositoryId' = ${repo}
    )
    OR resulting_memory_id IN (
      SELECT id FROM memory_items WHERE scope->>'repositoryId' = ${repo}
    )
    OR target_memory_id IN (
      SELECT id FROM memory_items WHERE scope->>'repositoryId' = ${repo}
    )
  `;
  await sql`DELETE FROM memory_candidates WHERE proposed_scope->>'repositoryId' = ${repo}`;
  await sql`DELETE FROM memory_items WHERE scope->>'repositoryId' = ${repo}`;
  await sql`DELETE FROM task_sessions WHERE repository_id = ${repo}`;
  await sql`DELETE FROM memory_op_log WHERE run_id LIKE ${repo + "%"}`;
}
