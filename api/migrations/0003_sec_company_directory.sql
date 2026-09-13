PRAGMA foreign_keys = ON;

CREATE TABLE sec_company_directory (
  ticker TEXT PRIMARY KEY COLLATE NOCASE,
  cik TEXT NOT NULL CHECK(length(cik) = 10),
  name TEXT NOT NULL,
  source_url TEXT NOT NULL CHECK(source_url = 'https://www.sec.gov/files/company_tickers.json'),
  source_fetched_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE sec_directory_sync (
  singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
  source_url TEXT NOT NULL CHECK(source_url = 'https://www.sec.gov/files/company_tickers.json'),
  etag TEXT,
  last_modified TEXT,
  fetched_at TEXT NOT NULL,
  row_count INTEGER NOT NULL CHECK(row_count > 0),
  sha256 TEXT NOT NULL CHECK(length(sha256) = 64)
);

-- D1 imports cannot create temporary tables. This table is emptied before and
-- after each atomic directory refresh and is never queried by the public API.
CREATE TABLE sec_company_directory_import (
  ticker TEXT PRIMARY KEY COLLATE NOCASE,
  cik TEXT NOT NULL CHECK(length(cik) = 10),
  name TEXT NOT NULL
);

CREATE INDEX idx_sec_directory_name ON sec_company_directory(name COLLATE NOCASE);
CREATE INDEX idx_sec_directory_cik ON sec_company_directory(cik);
