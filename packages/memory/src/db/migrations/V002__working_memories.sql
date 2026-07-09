-- V002: Working Memory 表

CREATE TABLE working_memories (
  id                      text PRIMARY KEY,
  task_id                 text NOT NULL REFERENCES task_sessions(id) ON DELETE CASCADE,
  revision                integer NOT NULL DEFAULT 1,
  -- 核心字段提取为列，便于查询和约束
  goal                    text NOT NULL DEFAULT '',
  -- 完整状态存为 JSONB（含 constraints, plan, todos, hypotheses 等）
  state                   jsonb NOT NULL DEFAULT '{}',
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_wm_task ON working_memories (task_id);

-- Working Memory 快照
CREATE TABLE working_memory_snapshots (
  id                      text PRIMARY KEY,
  task_id                 text NOT NULL REFERENCES task_sessions(id) ON DELETE CASCADE,
  working_memory_id       text NOT NULL,
  working_memory_revision integer NOT NULL,
  reason                  text NOT NULL DEFAULT 'manual',
  snapshot                jsonb NOT NULL,
  created_by              jsonb NOT NULL DEFAULT '{}',
  created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_wm_snapshots_task ON working_memory_snapshots (task_id);
CREATE INDEX idx_wm_snapshots_wm   ON working_memory_snapshots (working_memory_id);
