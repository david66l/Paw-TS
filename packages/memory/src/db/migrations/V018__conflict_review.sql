-- V018: Conflict Records + Review Requests

CREATE TABLE conflict_records (
  id                      text PRIMARY KEY,
  conflict_type           text NOT NULL,
  severity                text NOT NULL DEFAULT 'medium',
  candidate_id            text,
  memory_id_a             text NOT NULL,
  memory_id_b             text,
  conflicting_fields      text[] NOT NULL DEFAULT '{}',
  description             text NOT NULL DEFAULT '',
  evidence_ref_ids        text[] NOT NULL DEFAULT '{}',
  resolution_status       text NOT NULL DEFAULT 'unresolved',
  governance_decision_id  text,
  detected_by             jsonb NOT NULL DEFAULT '{}',
  detected_at             timestamptz NOT NULL DEFAULT now(),
  resolved_at             timestamptz
);

CREATE INDEX idx_conflict_memory ON conflict_records (memory_id_a);
CREATE INDEX idx_conflict_status ON conflict_records (resolution_status);

CREATE TABLE review_requests (
  id              text PRIMARY KEY,
  candidate_id    text NOT NULL,
  decision_id     text,
  reason          text NOT NULL DEFAULT '',
  priority        text NOT NULL DEFAULT 'medium',
  reviewer_type   text NOT NULL DEFAULT 'human',
  status          text NOT NULL DEFAULT 'pending',
  deadline        timestamptz,
  reviewed_by     text,
  review_comment  text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  reviewed_at     timestamptz
);

CREATE INDEX idx_review_status ON review_requests (status);
CREATE INDEX idx_review_candidate ON review_requests (candidate_id);
