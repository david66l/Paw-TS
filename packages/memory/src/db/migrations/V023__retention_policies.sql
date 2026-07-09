-- V023: Retention Policies（数据保留生命周期）

CREATE TABLE retention_policies (
  id                      text PRIMARY KEY,
  entity_type             text NOT NULL,
  active_retention_days   integer,
  archive_after_days      integer,
  delete_after_days       integer,
  delete_mode             text NOT NULL DEFAULT 'logical',
  legal_hold_allowed      boolean NOT NULL DEFAULT false,
  preserve_hashes_after_delete boolean NOT NULL DEFAULT true,
  configurable            boolean NOT NULL DEFAULT true,
  description             text NOT NULL DEFAULT '',
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

INSERT INTO retention_policies (id, entity_type, active_retention_days, archive_after_days, delete_after_days, description) VALUES
('rp-task-trace', 'task_trace', 30, 90, 365, 'Task trace events'),
('rp-audit', 'audit', 90, 365, 730, 'Audit records'),
('rp-candidate', 'candidate', 14, 30, 90, 'Failed/rejected candidates'),
('rp-archived-memory', 'archived_memory', null, 365, 730, 'Archived memories'),
('rp-context-build', 'context_build', 7, 30, 90, 'Context build results');
