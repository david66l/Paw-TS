-- V003: Memory Item 表

CREATE TABLE memory_items (
  id                      text PRIMARY KEY,
  schema_version          integer NOT NULL DEFAULT 1,
  type                    text NOT NULL,
  -- subjectKey 用于去重和幂等
  subject_key             text NOT NULL,
  subject_key_version     integer NOT NULL DEFAULT 1,
  title                   text NOT NULL,
  summary                 text NOT NULL DEFAULT '',
  status                  text NOT NULL DEFAULT 'active',
  -- scope 存 JSONB（repositoryId, userId, workspaceId, pathPatterns...）
  scope                   jsonb NOT NULL DEFAULT '{}',
  confidence              real NOT NULL DEFAULT 0.5,
  verification_status     text NOT NULL DEFAULT 'unverified',
  -- typed payload（RulePayload, ProjectKnowledgePayload, ...）
  payload                 jsonb NOT NULL DEFAULT '{}',
  tags                    text[] NOT NULL DEFAULT '{}',
  related_files           text[] NOT NULL DEFAULT '{}',
  related_symbols         text[] NOT NULL DEFAULT '{}',
  related_test_run_ids    text[] NOT NULL DEFAULT '{}',
  sensitivity             text NOT NULL DEFAULT 'internal',
  version                 integer NOT NULL DEFAULT 1,
  created_by              jsonb NOT NULL DEFAULT '{}',
  updated_by              jsonb NOT NULL DEFAULT '{}',
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

-- 结构化过滤最常用的索引
CREATE INDEX idx_memory_type_status     ON memory_items (type, status);
CREATE INDEX idx_memory_subject         ON memory_items (subject_key, status);
CREATE INDEX idx_memory_scope_repo      ON memory_items ((scope->>'repositoryId'), type, status);
CREATE INDEX idx_memory_scope_user      ON memory_items ((scope->>'userId'), type, status);
CREATE INDEX idx_memory_confidence      ON memory_items (confidence);
CREATE INDEX idx_memory_updated         ON memory_items (updated_at DESC);
CREATE INDEX idx_memory_tags            ON memory_items USING GIN (tags);
