-- V038: bounded source-local lookup after global source fusion.
-- The expression matches evidenceSourceIdV1/split_part(..., '#', 1).

CREATE INDEX idx_memory_raw_evidence_source_local_lookup
  ON memory_raw_evidence_spans (
    (scope->>'tenantId'), (scope->>'userId'),
    (scope->>'workspaceId'), (scope->>'repositoryId'),
    (split_part(evidence_ref, '#', 1)), source_kind, created_at DESC
  );
