-- V034: plugin-owned dynamic topics and immutable trajectory snapshots.
-- Runtime and agent-loop do not depend on these tables.

CREATE TABLE memory_topics (
  id                text PRIMARY KEY,
  schema_version    text NOT NULL,
  scope             jsonb NOT NULL,
  family            text NOT NULL,
  canonical_name    text NOT NULL,
  normalized_name   text NOT NULL,
  status            text NOT NULL DEFAULT 'active',
  revision          integer NOT NULL DEFAULT 1,
  projection_hash   text NOT NULL,
  created_at        timestamptz NOT NULL,
  updated_at        timestamptz NOT NULL,
  CONSTRAINT memory_topics_scope_complete CHECK (
    scope ?& ARRAY['tenantId', 'userId', 'workspaceId', 'repositoryId']
    AND length(scope->>'tenantId') > 0
    AND length(scope->>'userId') > 0
    AND length(scope->>'workspaceId') > 0
    AND length(scope->>'repositoryId') > 0
  ),
  CONSTRAINT memory_topics_family_valid CHECK (
    family IN ('semantic', 'episodic', 'profile', 'instruction', 'mixed')
  ),
  CONSTRAINT memory_topics_status_valid CHECK (
    status IN ('active', 'archived')
  )
);

CREATE UNIQUE INDEX idx_memory_topics_scope_name
  ON memory_topics (
    (scope->>'tenantId'), (scope->>'userId'),
    (scope->>'workspaceId'), (scope->>'repositoryId'),
    family, normalized_name
  );

CREATE INDEX idx_memory_topics_scope_updated
  ON memory_topics (
    (scope->>'tenantId'), (scope->>'userId'),
    (scope->>'workspaceId'), (scope->>'repositoryId'), updated_at DESC
  );

CREATE TABLE memory_topic_memberships (
  topic_id          text NOT NULL REFERENCES memory_topics(id) ON DELETE CASCADE,
  memory_id         text NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  role              text NOT NULL,
  confidence        real NOT NULL,
  basis             text NOT NULL,
  status            text NOT NULL DEFAULT 'active',
  evidence_refs     jsonb NOT NULL DEFAULT '[]',
  created_at        timestamptz NOT NULL,
  updated_at        timestamptz NOT NULL,
  PRIMARY KEY (topic_id, memory_id),
  CONSTRAINT memory_topic_membership_role_valid CHECK (
    role IN ('primary', 'supporting')
  ),
  CONSTRAINT memory_topic_membership_basis_valid CHECK (
    basis IN ('model_proposed', 'explicit_relation', 'user_asserted')
  ),
  CONSTRAINT memory_topic_membership_status_valid CHECK (
    status IN ('active', 'retracted')
  ),
  CONSTRAINT memory_topic_membership_confidence_valid CHECK (
    confidence >= 0 AND confidence <= 1
  )
);

CREATE INDEX idx_memory_topic_memberships_memory
  ON memory_topic_memberships (memory_id, status);

CREATE TABLE memory_trajectory_snapshots (
  id                text PRIMARY KEY,
  schema_version    text NOT NULL,
  topic_id          text NOT NULL REFERENCES memory_topics(id) ON DELETE CASCADE,
  projection_hash   text NOT NULL,
  graph_revision    text NOT NULL,
  payload           jsonb NOT NULL,
  created_at        timestamptz NOT NULL,
  UNIQUE (topic_id, projection_hash)
);

CREATE INDEX idx_memory_trajectory_snapshots_topic_created
  ON memory_trajectory_snapshots (topic_id, created_at DESC);
