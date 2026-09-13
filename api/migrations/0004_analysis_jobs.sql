PRAGMA foreign_keys = ON;

CREATE TABLE analysis_jobs (
  job_id TEXT PRIMARY KEY,
  ticker TEXT NOT NULL COLLATE NOCASE,
  cik TEXT NOT NULL CHECK(length(cik) = 10),
  company_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued', 'processing', 'completed', 'failed', 'unsupported')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK(max_attempts BETWEEN 1 AND 10),
  requested_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  public_message TEXT NOT NULL,
  error_code TEXT,
  failure_stage TEXT,
  CHECK((status IN ('completed', 'failed', 'unsupported') AND completed_at IS NOT NULL) OR
        (status IN ('queued', 'processing') AND completed_at IS NULL)),
  FOREIGN KEY(ticker) REFERENCES sec_company_directory(ticker) ON DELETE RESTRICT
);

-- At most one live request per company. Completed and failed attempts remain as
-- an audit trail without allowing duplicate background work.
CREATE UNIQUE INDEX idx_analysis_jobs_one_active_ticker
  ON analysis_jobs(ticker)
  WHERE status IN ('queued', 'processing');
CREATE INDEX idx_analysis_jobs_ticker_requested
  ON analysis_jobs(ticker, requested_at DESC);
CREATE INDEX idx_analysis_jobs_status_updated
  ON analysis_jobs(status, updated_at DESC);

CREATE TABLE analysis_job_failures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES analysis_jobs(job_id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  error_code TEXT NOT NULL,
  diagnostic_message TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);

CREATE INDEX idx_analysis_job_failures_job
  ON analysis_job_failures(job_id, occurred_at DESC);
