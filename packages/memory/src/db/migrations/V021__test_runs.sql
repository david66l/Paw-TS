-- V021: Test Runs + Test Case Results

CREATE TABLE test_runs (
  id                      text PRIMARY KEY,
  task_id                 text NOT NULL REFERENCES task_sessions(id) ON DELETE CASCADE,
  repository_id           text,
  branch                  text,
  commit_sha              text,
  command                 text NOT NULL DEFAULT '',
  status                  text NOT NULL DEFAULT 'running',
  passed_count            integer DEFAULT 0,
  failed_count            integer DEFAULT 0,
  skipped_count           integer DEFAULT 0,
  output_ref              text,
  output_hash             text,
  trace_event_id          text,
  sensitivity             text NOT NULL DEFAULT 'internal',
  started_at              timestamptz NOT NULL DEFAULT now(),
  completed_at            timestamptz
);

CREATE INDEX idx_test_runs_task ON test_runs (task_id);

CREATE TABLE test_case_results (
  id              text PRIMARY KEY,
  test_run_id     text NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
  test_name       text NOT NULL,
  file_path       text,
  status          text NOT NULL DEFAULT 'pending',
  duration_ms     integer,
  failure_summary text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_test_cases_run ON test_case_results (test_run_id);
CREATE INDEX idx_test_cases_name ON test_case_results (test_name);
