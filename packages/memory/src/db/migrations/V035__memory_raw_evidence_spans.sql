-- V035: plugin-owned L0 source archive for bounded evidence hydration.
-- Runtime and agent-loop remain unaware of memory source storage.

CREATE TABLE memory_raw_evidence_spans (
  id                text PRIMARY KEY,
  schema_version    text NOT NULL,
  scope             jsonb NOT NULL,
  evidence_ref      text NOT NULL,
  source_kind       text NOT NULL,
  source_seq        integer NOT NULL,
  content           text NOT NULL,
  content_hash      text NOT NULL,
  created_at        timestamptz NOT NULL,
  CONSTRAINT memory_raw_evidence_scope_complete CHECK (
    scope ?& ARRAY['tenantId', 'userId', 'workspaceId', 'repositoryId']
    AND length(scope->>'tenantId') > 0
    AND length(scope->>'userId') > 0
    AND length(scope->>'workspaceId') > 0
    AND length(scope->>'repositoryId') > 0
  ),
  CONSTRAINT memory_raw_evidence_kind_valid CHECK (
    source_kind IN ('user_input', 'tool_observation', 'verification', 'outcome', 'source_document')
  ),
  CONSTRAINT memory_raw_evidence_content_nonempty CHECK (
    length(content) > 0 AND length(content) <= 8192
  )
);

CREATE UNIQUE INDEX idx_memory_raw_evidence_scope_ref
  ON memory_raw_evidence_spans (
    (scope->>'tenantId'), (scope->>'userId'),
    (scope->>'workspaceId'), (scope->>'repositoryId'), evidence_ref
  );

CREATE INDEX idx_memory_raw_evidence_scope_created
  ON memory_raw_evidence_spans (
    (scope->>'tenantId'), (scope->>'userId'),
    (scope->>'workspaceId'), (scope->>'repositoryId'), created_at DESC
  );
