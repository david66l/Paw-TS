-- Scheduling is separate from parent-run authority. Workers must reopen the
-- exact journal with its fenced execution lease before processing this locator.
CREATE TABLE IF NOT EXISTS desktop_memory_jobs (
  id text PRIMARY KEY,
  host_id text NOT NULL,
  locator jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','dead')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_token text,
  lease_until timestamptz,
  reason_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS desktop_memory_jobs_due ON desktop_memory_jobs(host_id, status, available_at);
