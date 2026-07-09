-- V019: Task Execution Attempts（任务重试/恢复）

CREATE TABLE task_execution_attempts (
  id                      text PRIMARY KEY,
  task_id                 text NOT NULL REFERENCES task_sessions(id) ON DELETE CASCADE,
  attempt_number          integer NOT NULL,
  attempt_reason          text NOT NULL DEFAULT 'initial',
  status                  text NOT NULL DEFAULT 'created',
  execution_environment_id text,
  agent_runtime_version   text,
  resume_from_checkpoint_id text,
  failure_category        text,
  failure_reason          text,
  started_at              timestamptz,
  ended_at                timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_attempts_task ON task_execution_attempts (task_id, attempt_number);
CREATE UNIQUE INDEX idx_attempts_uniq ON task_execution_attempts (task_id, attempt_number);
