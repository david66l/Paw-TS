-- V036: plugin-owned, content-addressed L2 topic dossiers.
-- Runtime and agent-loop remain unaware of this projection table.

CREATE TABLE memory_topic_dossiers (
  id                text PRIMARY KEY,
  schema_version    text NOT NULL,
  topic_id          text NOT NULL REFERENCES memory_topics(id) ON DELETE CASCADE,
  scope_fingerprint text NOT NULL,
  projection_hash   text NOT NULL,
  graph_revision    text NOT NULL,
  policy_version    text NOT NULL,
  extractor_version text NOT NULL,
  proposal_hash     text NOT NULL,
  payload           jsonb NOT NULL,
  created_at        timestamptz NOT NULL,
  UNIQUE (topic_id, projection_hash, policy_version, extractor_version)
);

CREATE INDEX idx_memory_topic_dossiers_current
  ON memory_topic_dossiers (topic_id, projection_hash, created_at DESC);
