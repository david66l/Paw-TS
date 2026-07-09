-- V024: Memory Usage Records（记忆使用追踪）

CREATE TABLE memory_usage_records (
  id                    text PRIMARY KEY,
  task_id               text NOT NULL,
  context_build_id      text,
  memory_id             text NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  memory_version        integer NOT NULL DEFAULT 1,
  placement             text NOT NULL DEFAULT 'warm',
  retrieval_rank        integer,
  model_usage           text NOT NULL DEFAULT 'unknown',
  outcome               text NOT NULL DEFAULT 'unknown',
  outcome_evidence_refs text[] NOT NULL DEFAULT '{}',
  user_feedback         text NOT NULL DEFAULT 'none',
  caused_conflict       boolean NOT NULL DEFAULT false,
  caused_rework         boolean NOT NULL DEFAULT false,
  recorded_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_usage_memory ON memory_usage_records (memory_id);
CREATE INDEX idx_usage_task ON memory_usage_records (task_id);
