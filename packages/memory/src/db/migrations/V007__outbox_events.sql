-- V007: Outbox Events（事务性索引更新）

CREATE TABLE outbox_events (
  id              text PRIMARY KEY,
  event_type      text NOT NULL,
  aggregate_type  text NOT NULL,
  aggregate_id    text NOT NULL,
  memory_id       text,
  memory_version  integer,
  payload         jsonb NOT NULL DEFAULT '{}',
  sequence        bigint NOT NULL,
  transaction_id  text NOT NULL,
  status          text NOT NULL DEFAULT 'pending',
  retry_count     integer NOT NULL DEFAULT 0,
  max_retries     integer NOT NULL DEFAULT 3,
  last_error      text,
  next_retry_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  published_at    timestamptz
);

CREATE UNIQUE INDEX idx_outbox_sequence ON outbox_events (aggregate_id, sequence);
CREATE INDEX idx_outbox_status ON outbox_events (status, next_retry_at);
CREATE INDEX idx_outbox_memory ON outbox_events (memory_id);

-- 序列生成器（每个 aggregate 独立递增）
CREATE SEQUENCE IF NOT EXISTS outbox_sequence_gen;
