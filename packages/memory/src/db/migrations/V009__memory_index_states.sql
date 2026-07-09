-- V009: Memory Index States（索引状态追踪）

CREATE TABLE memory_index_states (
  id                      text PRIMARY KEY,
  memory_id               text NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  memory_version_id       text NOT NULL,
  index_type              text NOT NULL,
  index_state             text NOT NULL DEFAULT 'INDEX_PENDING',
  index_revision          integer NOT NULL DEFAULT 1,
  event_sequence          bigint NOT NULL DEFAULT 0,
  embedding_model_version text,
  failure_code            text,
  checked_at              timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_index_state_memory ON memory_index_states (memory_id, index_type);
CREATE INDEX idx_index_state_status ON memory_index_states (index_state);
