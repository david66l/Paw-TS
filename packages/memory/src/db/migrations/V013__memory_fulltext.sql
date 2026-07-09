-- V013: Memory Full-Text Search（PostgreSQL tsvector）

ALTER TABLE memory_items ADD COLUMN IF NOT EXISTS search_text text;
ALTER TABLE memory_items ADD COLUMN IF NOT EXISTS search_tsv tsvector;

-- 从已有数据生成 search_text
UPDATE memory_items SET search_text =
  COALESCE(title, '') || ' ' ||
  COALESCE(summary, '') || ' ' ||
  COALESCE(subject_key, '') || ' ' ||
  array_to_string(COALESCE(tags, '{}'), ' ');

-- 生成 tsvector
UPDATE memory_items SET search_tsv = to_tsvector('english', search_text);

-- 触发器：INSERT/UPDATE 时自动更新
CREATE OR REPLACE FUNCTION memory_search_trigger() RETURNS trigger AS $$
BEGIN
  NEW.search_text :=
    COALESCE(NEW.title, '') || ' ' ||
    COALESCE(NEW.summary, '') || ' ' ||
    COALESCE(NEW.subject_key, '') || ' ' ||
    array_to_string(COALESCE(NEW.tags, '{}'), ' ');
  NEW.search_tsv := to_tsvector('english', NEW.search_text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER memory_search_update
  BEFORE INSERT OR UPDATE OF title, summary, subject_key, tags
  ON memory_items
  FOR EACH ROW EXECUTE FUNCTION memory_search_trigger();

-- GIN 索引
CREATE INDEX IF NOT EXISTS idx_memory_tsv ON memory_items USING GIN (search_tsv);
