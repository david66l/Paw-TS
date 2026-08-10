-- V031: outbox sequence 发号起点对齐（修复批次 A #3）
--
-- enqueue 改用 outbox_sequence_gen（nextval 并发安全）后，
-- 需把序列推进到现有 (aggregate_id='memory-write-queue') 最大 sequence 之上，
-- 避免与 max+1 时代写入的行冲突。
-- 幂等：setval 可重复执行。

SELECT setval(
  'outbox_sequence_gen',
  GREATEST((SELECT COALESCE(MAX(sequence), 0) FROM outbox_events), 1000)
);
