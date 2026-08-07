-- V030: outbox worker 并发安全（修复批次 A #3）
--
-- processing_at：worker 领取任务时打戳，崩溃遗留的 processing 行
-- 超 5 分钟由后续 worker 回收为 pending。
-- （aggregate_id, sequence）唯一约束 V007 已有（idx_outbox_sequence），无需重复建。
-- 幂等：IF NOT EXISTS，可重复执行。

ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS processing_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_outbox_processing
  ON outbox_events (status, processing_at) WHERE status = 'processing';
