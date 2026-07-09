/**
 * Execution Recorder (8.21)
 *
 * 记录工具执行的不可变事实。区分 CLAIMED → EXECUTED → VERIFIED → USER_CONFIRMED。
 * MVP: 内嵌于 Task Session Manager，使用 tool_result_records 表。
 */

import { getSql, parseJson } from "../../connection.js";
import { generateId } from "../platform/idGen.js";

export interface ExecutionRecord {
  recordId: string;
  taskId: string;
  attemptId: string;
  toolCallId: string;
  toolName: string;
  toolType: string;
  executionStatus: "SUCCESS" | "FAILURE" | "TIMEOUT" | "PARTIAL";
  resultSummary: string;
  rawOutputRef?: string;
  exitCode?: number;
  durationMs: number;
  verificationLevel: "CLAIMED" | "EXECUTED" | "VERIFIED" | "USER_CONFIRMED";
  errors: { errorType?: string; message?: string; stackSummary?: string }[];
  createdAt: string;
}

export interface RecordExecutionInput {
  idempotencyKey: string;
  taskId: string;
  sessionId?: string;
  attemptId: string;
  toolCallId: string;
  toolName: string;
  toolType: string;
  inputSummary: string;
  executionStatus: ExecutionRecord["executionStatus"];
  resultSummary: string;
  rawOutputRef?: string;
  rawOutputSizeBytes?: number;
  exitCode?: number;
  durationMs: number;
  verificationLevel?: ExecutionRecord["verificationLevel"];
  errors?: ExecutionRecord["errors"];
  relatedPlanStepId?: string;
}

function rowToRecord(row: Record<string, unknown>): ExecutionRecord {
  return {
    recordId: row.id as string,
    taskId: row.task_id as string,
    attemptId: row.attempt_id as string,
    toolCallId: row.tool_call_id as string,
    toolName: row.tool_name as string,
    toolType: row.tool_type as string,
    executionStatus: row.execution_status as ExecutionRecord["executionStatus"],
    resultSummary: row.result_summary as string,
    rawOutputRef: row.raw_output_ref as string | undefined,
    exitCode: row.exit_code as number | undefined,
    durationMs: row.duration_ms as number,
    verificationLevel: (row.verification_level as ExecutionRecord["verificationLevel"]) ?? "EXECUTED",
    errors: parseJson(row.errors) as ExecutionRecord["errors"],
    createdAt: row.created_at as string,
  };
}

export const executionRecorder = {
  async record(input: RecordExecutionInput): Promise<ExecutionRecord> {
    const sql = getSql();
    const id = generateId("toolrec");
    const now = new Date().toISOString();

    const rows = await sql.unsafe(
      `INSERT INTO tool_result_records (
        id, request_id, idempotency_key, task_id, session_id, attempt_id,
        tool_call_id, tool_name, tool_type, input_summary, execution_status,
        result_summary, raw_output_ref, raw_output_size_bytes, exit_code,
        duration_ms, verification_level, errors, related_plan_step_id, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
      ON CONFLICT (idempotency_key) DO UPDATE SET
        -- 幂等：已存在则更新 verification_level（只能升级）
        verification_level = CASE
          WHEN tool_result_records.verification_level = 'EXECUTED' AND $17 = 'VERIFIED' THEN 'VERIFIED'
          WHEN tool_result_records.verification_level IN ('EXECUTED','VERIFIED') AND $17 = 'USER_CONFIRMED' THEN 'USER_CONFIRMED'
          ELSE tool_result_records.verification_level
        END,
        updated_at = NOW()
      RETURNING *`,
      [id, id, input.idempotencyKey, input.taskId, input.sessionId ?? null, input.attemptId,
        input.toolCallId, input.toolName, input.toolType, input.inputSummary,
        input.executionStatus, input.resultSummary, input.rawOutputRef ?? null,
        input.rawOutputSizeBytes ?? null, input.exitCode ?? null, input.durationMs,
        input.verificationLevel ?? "EXECUTED", JSON.stringify(input.errors ?? []),
        input.relatedPlanStepId ?? null, now],
    );
    return rowToRecord(rows[0] as Record<string, unknown>);
  },

  async queryByTask(taskId: string): Promise<ExecutionRecord[]> {
    const sql = getSql();
    const rows = await sql.unsafe(
      "SELECT * FROM tool_result_records WHERE task_id = $1 ORDER BY created_at ASC", [taskId],
    );
    return rows.map((r) => rowToRecord(r as Record<string, unknown>));
  },

  async getSummary(taskId: string): Promise<{
    totalToolCalls: number;
    byStatus: Record<string, number>;
    byVerification: Record<string, number>;
    failures: { toolCallId: string; toolName: string; errorSummary: string }[];
  }> {
    const sql = getSql();
    const rows = await sql.unsafe(
      "SELECT * FROM tool_result_records WHERE task_id = $1", [taskId],
    ) as Record<string, unknown>[];

    const byStatus: Record<string, number> = {};
    const byVerification: Record<string, number> = {};
    const failures: { toolCallId: string; toolName: string; errorSummary: string }[] = [];

    for (const r of rows) {
      const status = r.execution_status as string;
      byStatus[status] = (byStatus[status] ?? 0) + 1;

      const v = r.verification_level as string;
      byVerification[v] = (byVerification[v] ?? 0) + 1;

      if (status === "FAILURE" || status === "TIMEOUT") {
        const errors = parseJson(r.errors) as ExecutionRecord["errors"];
        failures.push({
          toolCallId: r.tool_call_id as string,
          toolName: r.tool_name as string,
          errorSummary: errors[0]?.message ?? r.result_summary as string,
        });
      }
    }

    return {
      totalToolCalls: rows.length,
      byStatus,
      byVerification,
      failures,
    };
  },
};
