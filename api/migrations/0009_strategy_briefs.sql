PRAGMA foreign_keys = ON;

-- Validated industry overview, Porter's Five Forces, and PEST analyses. The
-- analysis is stored as structured JSON, and every claim inside it passed the same
-- per-claim citation and numeric validation as the other AI briefs, and the
-- cited sources are snapshotted alongside it.
CREATE TABLE strategy_briefs (
  brief_id TEXT PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  data_fingerprint TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  analysis_json TEXT NOT NULL,
  sources_json TEXT NOT NULL,
  validation_json TEXT NOT NULL,
  UNIQUE(company_id, data_fingerprint, prompt_version, model)
);

CREATE INDEX idx_strategy_briefs_latest
  ON strategy_briefs(company_id, prompt_version, model, generated_at DESC);
