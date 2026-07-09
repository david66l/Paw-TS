-- V011: Suppression Rules（用户抑制规则）

CREATE TABLE suppression_rules (
  id              text PRIMARY KEY,
  rule_type       text NOT NULL,
  subject_key     text,
  subject_pattern text,
  content_pattern text,
  scope           jsonb NOT NULL DEFAULT '{}',
  reason          text NOT NULL DEFAULT '',
  created_by      jsonb NOT NULL DEFAULT '{}',
  status          text NOT NULL DEFAULT 'active',
  valid_from      timestamptz NOT NULL DEFAULT now(),
  valid_until     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_suppress_scope ON suppression_rules USING GIN (scope);
CREATE INDEX idx_suppress_status ON suppression_rules (status);
