-- V025: Evolution System（自进化闭环）

CREATE TABLE evolution_batches (
  id                  text PRIMARY KEY,
  status              text NOT NULL DEFAULT 'created',
  trigger_reason      text NOT NULL DEFAULT 'scheduled',
  scope               jsonb NOT NULL DEFAULT '{}',
  sampled_memory_count integer NOT NULL DEFAULT 0,
  result_candidate_count integer NOT NULL DEFAULT 0,
  started_at          timestamptz,
  completed_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE evolution_candidates (
  id                      text PRIMARY KEY,
  batch_id                text REFERENCES evolution_batches(id),
  evolution_type          text NOT NULL,
  target_memory_ids       text[] NOT NULL DEFAULT '{}',
  proposed_title          text NOT NULL DEFAULT '',
  proposed_summary        text NOT NULL DEFAULT '',
  proposed_payload        jsonb NOT NULL DEFAULT '{}',
  proposed_confidence     real NOT NULL DEFAULT 0.5,
  risk_level              text NOT NULL DEFAULT 'medium',
  evidence                jsonb NOT NULL DEFAULT '{}',
  status                  text NOT NULL DEFAULT 'generated',
  governance_decision_id  text,
  generated_by            jsonb NOT NULL DEFAULT '{}',
  created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_evolution_batch ON evolution_candidates (batch_id);
CREATE INDEX idx_evolution_status ON evolution_candidates (status);
CREATE INDEX idx_evolution_type ON evolution_candidates (evolution_type);
