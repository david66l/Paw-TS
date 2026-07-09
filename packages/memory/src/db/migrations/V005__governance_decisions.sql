-- V005: Governance Decision 表

CREATE TABLE governance_decisions (
  id                      text PRIMARY KEY,
  schema_version          integer NOT NULL DEFAULT 1,
  candidate_id            text NOT NULL,
  -- decision: APPROVE_CREATE | APPROVE_UPDATE | REJECT | ...
  decision                text NOT NULL,
  reasons                 jsonb NOT NULL DEFAULT '[]',
  -- 执行后关联的 memory_item
  resulting_memory_id     text,
  resulting_status        text,
  adjusted_type           text,
  adjusted_scope          jsonb,
  adjusted_confidence     real,
  adjusted_payload        jsonb,
  required_actions        jsonb NOT NULL DEFAULT '[]',
  policy_version          text NOT NULL DEFAULT '1.0',
  decided_by              jsonb NOT NULL DEFAULT '{}',
  -- 治理决策生命周期状态
  status                  text NOT NULL DEFAULT 'PROPOSED',
  -- 执行时的乐观锁字段
  target_memory_id        text,
  expected_version        integer,
  executed_at             timestamptz,
  decided_at              timestamptz NOT NULL DEFAULT now(),
  created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_gov_candidate   ON governance_decisions (candidate_id);
CREATE INDEX idx_gov_status      ON governance_decisions (status);
CREATE INDEX idx_gov_memory      ON governance_decisions (target_memory_id);
CREATE INDEX idx_gov_decided     ON governance_decisions (decided_at DESC);
