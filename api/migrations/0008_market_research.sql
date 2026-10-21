PRAGMA foreign_keys = ON;

-- Short-lived snapshots of live upstream data (SEC submissions, SEC XBRL
-- frames, press headlines). Rows are refreshed in place when they expire and
-- served stale only if the upstream refresh fails.
CREATE TABLE market_cache (
  cache_key TEXT PRIMARY KEY,
  fetched_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

-- Validated AI briefs over news and industry data. Sources are snapshotted so a
-- brief stays renderable after the underlying headlines roll out of the cache.
CREATE TABLE market_briefs (
  brief_id TEXT PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  brief_type TEXT NOT NULL CHECK(brief_type IN ('news', 'industry')),
  data_fingerprint TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  sentiment TEXT NOT NULL CHECK(sentiment IN ('bullish', 'neutral', 'bearish')),
  confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
  claims_json TEXT NOT NULL,
  sources_json TEXT NOT NULL,
  validation_json TEXT NOT NULL,
  UNIQUE(company_id, brief_type, data_fingerprint, prompt_version, model)
);

CREATE INDEX idx_market_briefs_latest
  ON market_briefs(company_id, brief_type, prompt_version, model, generated_at DESC);
