-- V016: Memory Relations（记忆间关系）

CREATE TABLE memory_relations (
  id              text PRIMARY KEY,
  from_memory_id  text NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  to_memory_id    text NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  relation_type   text NOT NULL,
  status          text NOT NULL DEFAULT 'active',
  source_refs     jsonb NOT NULL DEFAULT '[]',
  evidence_refs   jsonb NOT NULL DEFAULT '[]',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_mr_from ON memory_relations (from_memory_id, relation_type);
CREATE INDEX idx_mr_to ON memory_relations (to_memory_id, relation_type);
