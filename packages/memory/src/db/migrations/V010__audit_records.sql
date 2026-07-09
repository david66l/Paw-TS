-- V010: Audit Records（不可变审计日志）

CREATE TABLE audit_records (
  id                    text PRIMARY KEY,
  event_type            text NOT NULL,
  actor                 jsonb NOT NULL DEFAULT '{}',
  entity_type           text NOT NULL,
  entity_id             text NOT NULL,
  previous_version      integer,
  new_version           integer,
  change_summary        jsonb DEFAULT '{}',
  reason                text,
  governance_decision_id text,
  transaction_id        text,
  idempotency_key       text,
  policy_version        text,
  task_id               text,
  sensitivity           text NOT NULL DEFAULT 'internal',
  retention_policy_id   text,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_entity ON audit_records (entity_type, entity_id);
CREATE INDEX idx_audit_task ON audit_records (task_id);
CREATE INDEX idx_audit_event ON audit_records (event_type, created_at DESC);
CREATE INDEX idx_audit_gov ON audit_records (governance_decision_id);
