-- V015: Memory Versions（不可变历史版本）

CREATE TABLE memory_versions (
  id                     text PRIMARY KEY,
  memory_id              text NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  version                integer NOT NULL,
  snapshot               jsonb NOT NULL,
  change_type            text NOT NULL,
  change_reason          text NOT NULL DEFAULT '',
  governance_decision_id text,
  created_by             jsonb NOT NULL DEFAULT '{}',
  created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_memory_versions_memory ON memory_versions (memory_id, version DESC);
CREATE UNIQUE INDEX idx_memory_versions_uniq ON memory_versions (memory_id, version);
