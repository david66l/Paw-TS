-- V017: Working Memory Entries（从 JSONB 拆出的独立条目表）

CREATE TABLE working_memory_entries (
  id                  text PRIMARY KEY,
  working_memory_id   text NOT NULL REFERENCES working_memories(id) ON DELETE CASCADE,
  task_id             text NOT NULL,
  entry_type          text NOT NULL,
  status              text NOT NULL DEFAULT 'active',
  content             jsonb NOT NULL DEFAULT '{}',
  sort_order          integer NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_wme_wm ON working_memory_entries (working_memory_id, status);
CREATE INDEX idx_wme_type ON working_memory_entries (working_memory_id, entry_type);
CREATE INDEX idx_wme_task ON working_memory_entries (task_id);
