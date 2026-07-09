-- V012: Policy Snapshots（Task Session 绑定的不可变策略快照）

CREATE TABLE policy_snapshots (
  id              text PRIMARY KEY,
  task_session_id text NOT NULL,
  effective_policy jsonb NOT NULL DEFAULT '{}',
  source_versions jsonb NOT NULL DEFAULT '{}',
  checksum        text NOT NULL DEFAULT '',
  status          text NOT NULL DEFAULT 'active',
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz
);

CREATE UNIQUE INDEX idx_policy_snap_task ON policy_snapshots (task_session_id);
