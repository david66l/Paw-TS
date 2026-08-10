-- V028: 记忆操作日志（spec v2 §10.1 / 12 M3）
--
-- file 后端的 .paw/memory/_meta/op-log.jsonl 在 db 后端的等价物。
-- 每次记忆操作一行：read.trigger/read.inject/read.adopted/write.enqueued/
-- write.rejected/governed/lifecycle.purge/error…
-- 幂等：IF NOT EXISTS，可重复执行。

CREATE TABLE IF NOT EXISTS memory_op_log (
  id          text PRIMARY KEY,
  ts          timestamptz NOT NULL DEFAULT now(),
  op          text NOT NULL,
  -- 关联任务/运行
  run_id      text,
  -- 涉及的条目 id 列表
  entry_ids   text[] NOT NULL DEFAULT '{}',
  -- 操作细节（trigger/totalTokens/degraded/reason…）
  detail      jsonb NOT NULL DEFAULT '{}'
);

-- 按时间扫描（diff/stats）与按 run 回放（"当时注入了什么"）
CREATE INDEX IF NOT EXISTS idx_op_log_ts    ON memory_op_log (ts DESC);
CREATE INDEX IF NOT EXISTS idx_op_log_run   ON memory_op_log (run_id) WHERE run_id IS NOT NULL;
-- 按条目溯源（"这条记忆被注入过几次"）
CREATE INDEX IF NOT EXISTS idx_op_log_entry ON memory_op_log USING GIN (entry_ids);
