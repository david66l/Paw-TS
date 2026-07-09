-- V020: Working Memory Checkpoints（结构化恢复点）

CREATE TABLE working_memory_checkpoints (
  id                      text PRIMARY KEY,
  working_memory_id       text NOT NULL,
  task_id                 text NOT NULL REFERENCES task_sessions(id) ON DELETE CASCADE,
  revision                integer NOT NULL,
  reason                  text NOT NULL DEFAULT 'manual',
  snapshot                jsonb NOT NULL,
  task_phase              text,
  created_by              jsonb NOT NULL DEFAULT '{}',
  created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_wm_checkpoints_task ON working_memory_checkpoints (task_id);
CREATE INDEX idx_wm_checkpoints_wm ON working_memory_checkpoints (working_memory_id, revision DESC);
