-- V004: Memory Candidate 表

CREATE TABLE memory_candidates (
  id                      text PRIMARY KEY,
  schema_version          integer NOT NULL DEFAULT 1,
  status                  text NOT NULL DEFAULT 'draft',
  -- 提议的最终记忆类型
  proposed_type           text NOT NULL,
  proposed_subject_key    text,
  subject_key_version     integer NOT NULL DEFAULT 1,
  proposed_title          text NOT NULL,
  proposed_summary        text NOT NULL DEFAULT '',
  -- proposedPayload: 候选记忆的结构化内容（jsonb）
  proposed_payload        jsonb NOT NULL DEFAULT '{}',
  proposed_scope          jsonb NOT NULL DEFAULT '{}',
  proposed_confidence     real NOT NULL DEFAULT 0.5,
  -- source: 哪些 task 产生了这个候选
  source_task_ids         text[] NOT NULL DEFAULT '{}',
  source_refs             jsonb NOT NULL DEFAULT '[]',
  evidence_refs           jsonb NOT NULL DEFAULT '[]',
  possible_duplicate_ids  text[] NOT NULL DEFAULT '{}',
  possible_conflict_ids   text[] NOT NULL DEFAULT '{}',
  risk_level              text NOT NULL DEFAULT 'medium',
  review_required         boolean NOT NULL DEFAULT false,
  generated_by            jsonb NOT NULL DEFAULT '{}',
  generation_reason       text NOT NULL DEFAULT '',
  sensitivity             text NOT NULL DEFAULT 'internal',
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  expires_at              timestamptz
);

CREATE INDEX idx_candidate_status   ON memory_candidates (status, proposed_type);
CREATE INDEX idx_candidate_risk     ON memory_candidates (risk_level, review_required);
CREATE INDEX idx_candidate_tasks    ON memory_candidates USING GIN (source_task_ids);
CREATE INDEX idx_candidate_created  ON memory_candidates (created_at DESC);
