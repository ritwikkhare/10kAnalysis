PRAGMA foreign_keys = ON;

CREATE TABLE refresh_runs (
  run_id TEXT PRIMARY KEY,
  trigger_type TEXT NOT NULL CHECK(trigger_type IN ('manual', 'scheduled', 'test')),
  status TEXT NOT NULL CHECK(status IN ('running', 'succeeded', 'partial_failure', 'failed')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  companies_checked INTEGER NOT NULL DEFAULT 0 CHECK(companies_checked >= 0),
  filings_discovered INTEGER NOT NULL DEFAULT 0 CHECK(filings_discovered >= 0),
  filings_imported INTEGER NOT NULL DEFAULT 0 CHECK(filings_imported >= 0),
  error_count INTEGER NOT NULL DEFAULT 0 CHECK(error_count >= 0),
  error_summary TEXT
);

CREATE TABLE company_refresh_status (
  company_id INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES refresh_runs(run_id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK(status IN ('up_to_date', 'imported', 'failed')),
  last_checked_at TEXT NOT NULL,
  last_success_at TEXT,
  latest_accession TEXT REFERENCES filings(accession_number) ON DELETE SET NULL,
  message TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE refresh_failures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES refresh_runs(run_id) ON DELETE CASCADE,
  ticker TEXT NOT NULL COLLATE NOCASE,
  form TEXT NOT NULL CHECK(form IN ('10-K', '10-Q')),
  stage TEXT NOT NULL,
  error_code TEXT NOT NULL,
  message TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);

CREATE INDEX idx_refresh_runs_started ON refresh_runs(started_at DESC);
CREATE INDEX idx_refresh_runs_status ON refresh_runs(status, started_at DESC);
CREATE INDEX idx_refresh_failures_run ON refresh_failures(run_id, ticker, form);
