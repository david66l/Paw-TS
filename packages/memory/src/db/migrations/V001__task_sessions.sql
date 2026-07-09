-- V001: Task Session 表

CREATE TABLE task_sessions (
  id                      text PRIMARY KEY,
  schema_version          integer NOT NULL DEFAULT 1,
  organization_id         text,
  user_id                 text,
  workspace_id            text,
  repository_id           text,
  parent_task_id          text,
  root_task_id            text NOT NULL,
  title                   text,
  initial_user_request    text NOT NULL,
  status                  text NOT NULL DEFAULT 'pending',
  branch                  text,
  base_commit             text,
  head_commit             text,
  current_working_memory_id text,
  latest_checkpoint_id    text,
  started_at              timestamptz,
  completed_at            timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  revision                integer NOT NULL DEFAULT 1
);

CREATE INDEX idx_task_sessions_status ON task_sessions (status);
CREATE INDEX idx_task_sessions_repo  ON task_sessions (repository_id, status);
CREATE INDEX idx_task_sessions_user  ON task_sessions (user_id);
