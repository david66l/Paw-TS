-- V022: Task Trace Events（任务执行轨迹）

CREATE TABLE task_trace_events (
  id              text PRIMARY KEY,
  task_id         text NOT NULL REFERENCES task_sessions(id) ON DELETE CASCADE,
  sequence        integer NOT NULL,
  event_type      text NOT NULL,
  actor           jsonb NOT NULL DEFAULT '{}',
  summary         text NOT NULL DEFAULT '',
  payload_ref     text,
  payload_hash    text,
  sensitivity     text NOT NULL DEFAULT 'internal',
  retention_policy_id text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_trace_task_seq ON task_trace_events (task_id, sequence);
CREATE INDEX idx_trace_type ON task_trace_events (task_id, event_type);
