-- V026: 长期记忆 v2 增量迁移（spec v2 §4.2 / 12 M1）
--
-- 在现有 memory_items 上追加 v2 生命周期与检索字段，并新建试用教训池。
-- 全部语句幂等（IF NOT EXISTS / 条件回填），可重复执行。

-- 双时戳：t_valid = 事实生效时间；t_invalid 非 NULL = 软失效（永不注入但可查）
ALTER TABLE memory_items ADD COLUMN IF NOT EXISTS t_valid      timestamptz;
ALTER TABLE memory_items ADD COLUMN IF NOT EXISTS t_invalid    timestamptz;

-- 检索键：episodic 经验的 whenToUse 场景条件句（embedding 主键，spec §4.2）
ALTER TABLE memory_items ADD COLUMN IF NOT EXISTS when_to_use  text;

-- 效用账本：freq = 被检索命中次数；utility = 命中后所在任务成功次数
ALTER TABLE memory_items ADD COLUMN IF NOT EXISTS freq         integer NOT NULL DEFAULT 0;
ALTER TABLE memory_items ADD COLUMN IF NOT EXISTS utility      integer NOT NULL DEFAULT 0;

-- UPDATE 版本链（Governor 裁决 UPDATE 时保留 old 值）
ALTER TABLE memory_items ADD COLUMN IF NOT EXISTS history      jsonb NOT NULL DEFAULT '[]';

-- 存量回填：spec §4.2 约定写入时 tValid = created；幂等（已回填的行跳过）
UPDATE memory_items SET t_valid = created_at WHERE t_valid IS NULL;

-- 软失效默认过滤的部分索引：检索/query 只扫活跃条目
CREATE INDEX IF NOT EXISTS idx_memory_items_valid
  ON memory_items (type, updated_at DESC) WHERE t_invalid IS NULL;

-- when_to_use 检索键的 trigram 索引（pg_trgm 已在 V000 启用；向量化属 M2）
CREATE INDEX IF NOT EXISTS idx_memory_items_when_to_use
  ON memory_items USING GIN (when_to_use gin_trgm_ops) WHERE when_to_use IS NOT NULL;

-- 试用教训池（spec §4.2 TrialLesson：Reflexion 式失败教训，试用制）
-- 独立命名空间，不进正式检索池；attemptsLeft 耗尽丢弃
CREATE TABLE IF NOT EXISTS memory_trial_lessons (
  id             text PRIMARY KEY,
  lesson         text NOT NULL,
  origin_task_id text NOT NULL,
  created        timestamptz NOT NULL DEFAULT now(),
  attempts_left  integer NOT NULL DEFAULT 3
);

CREATE INDEX IF NOT EXISTS idx_trial_lessons_task ON memory_trial_lessons (origin_task_id);
