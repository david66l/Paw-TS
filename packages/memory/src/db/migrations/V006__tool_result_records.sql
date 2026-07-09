-- V006: Tool Result Records（Execution Recorder 用）

CREATE TABLE tool_result_records (
  id                      text PRIMARY KEY,
  request_id              text NOT NULL,
  idempotency_key         text NOT NULL,
  task_id                 text NOT NULL REFERENCES task_sessions(id) ON DELETE CASCADE,
  session_id              text,
  attempt_id              text,
  tool_call_id            text NOT NULL,
  tool_name               text NOT NULL,
  tool_type               text NOT NULL,
  input_summary           text NOT NULL DEFAULT '',
  execution_status        text NOT NULL,
  result_summary          text NOT NULL DEFAULT '',
  raw_output_ref          text,
  raw_output_size_bytes   bigint,
  exit_code               integer,
  duration_ms             integer NOT NULL DEFAULT 0,
  verification_level      text NOT NULL DEFAULT 'EXECUTED',
  errors                  jsonb NOT NULL DEFAULT '[]',
  related_plan_step_id    text,
  updated_at              timestamptz NOT NULL DEFAULT now(),
  created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_tool_result_idem ON tool_result_records (idempotency_key);
CREATE INDEX idx_tool_result_task ON tool_result_records (task_id);
CREATE INDEX idx_tool_result_type ON tool_result_records (task_id, tool_type);
