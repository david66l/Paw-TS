-- V027: when_to_use 纳入全文索引（spec v2 §4.3 / 12 M2）
--
-- episodic 经验的检索主键 whenToUse 是 LLM 生成的场景条件句（可含中文），
-- V013 的 search_tsv 使用 'english' 配置且不覆盖该列。此处加独立的
-- generated tsvector 列，用 'simple' 配置（不做英语词干化，对中文/混合
-- 场景句更合理；substring 级匹配由 V026 的 pg_trgm 索引兜底）。
-- 幂等：IF NOT EXISTS，可重复执行。

ALTER TABLE memory_items
  ADD COLUMN IF NOT EXISTS when_to_use_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', coalesce(when_to_use, ''))) STORED;

CREATE INDEX IF NOT EXISTS idx_memory_items_when_to_use_tsv
  ON memory_items USING GIN (when_to_use_tsv);
