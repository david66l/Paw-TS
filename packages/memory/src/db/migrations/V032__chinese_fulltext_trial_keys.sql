-- V032: 中文全文兜底 + trial 池结构化（修复批次 B #7/#12/#21）
--
-- 1. search_tsv_simple：'simple' 配置的全文列（title+summary+when_to_use）。
--    主路 search_tsv 是 'english' 配置（V013），对中文场景句区分度差；
--    'simple' 不做英语词干化，保留 CJK 原文 token。searchText 取两路 GREATEST。
-- 2. memory_trial_lessons 增加 when_to_use/keywords/distilled 列：
--    trial 教训改为 LLM 蒸馏产出（§5.4 契约扩展），带检索键供随行注入匹配；
--    distilled=false 表示超预算降级的原文切片（标注用途）。
-- 幂等：IF NOT EXISTS，可重复执行。

ALTER TABLE memory_items
  ADD COLUMN IF NOT EXISTS search_tsv_simple tsvector
  GENERATED ALWAYS AS (
    to_tsvector('simple',
      coalesce(title, '') || ' ' || coalesce(summary, '') || ' ' || coalesce(when_to_use, ''))
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_memory_items_tsv_simple
  ON memory_items USING GIN (search_tsv_simple);

ALTER TABLE memory_trial_lessons ADD COLUMN IF NOT EXISTS when_to_use text;
ALTER TABLE memory_trial_lessons ADD COLUMN IF NOT EXISTS keywords text[] NOT NULL DEFAULT '{}';
ALTER TABLE memory_trial_lessons ADD COLUMN IF NOT EXISTS distilled boolean NOT NULL DEFAULT false;
