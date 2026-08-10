-- V029: 生命周期批处理支撑表（spec v2 §7.2 / §7.3 / 12 M7）
--
-- memory_lifecycle_review：灰度期人工复核队列——前 deleteReviewFirstN(200) 条
--   效用删除候选不自动执行，进队列人工 approve/reject；rejected 不再进队列。
-- memory_gc_archive：memory gc 物理清理前的归档快照（db 后端决议落 db 表，
--   对应 file 后端的 _meta/archive-YYYYMM.jsonl；--export 可再导出 JSONL）。
-- 幂等：IF NOT EXISTS，可重复执行。

CREATE TABLE IF NOT EXISTS memory_lifecycle_review (
  id          text PRIMARY KEY,
  entry_id    text NOT NULL,
  -- 删除原因（效用衰减/容量超限…）
  reason      text NOT NULL,
  -- 判定快照：freq/utility/adoptionRate 等
  snapshot    jsonb NOT NULL DEFAULT '{}',
  status      text NOT NULL DEFAULT 'pending',   -- pending | approved | rejected
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_lifecycle_review_status ON memory_lifecycle_review (status);
CREATE INDEX IF NOT EXISTS idx_lifecycle_review_entry  ON memory_lifecycle_review (entry_id);

CREATE TABLE IF NOT EXISTS memory_gc_archive (
  id           text PRIMARY KEY,
  entry_id     text NOT NULL,
  archived_at  timestamptz NOT NULL DEFAULT now(),
  -- 完整条目快照（含 payload/账本/双时戳）
  entry        jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_gc_archive_entry ON memory_gc_archive (entry_id);
