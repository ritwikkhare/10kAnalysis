PRAGMA foreign_keys = ON;

CREATE TABLE companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  schema_version TEXT NOT NULL,
  cik TEXT NOT NULL UNIQUE CHECK(length(cik) = 10),
  ticker TEXT NOT NULL COLLATE NOCASE UNIQUE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE filings (
  accession_number TEXT PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  schema_version TEXT NOT NULL,
  form TEXT NOT NULL CHECK(form IN ('10-K', '10-Q')),
  filing_date TEXT NOT NULL,
  report_date TEXT NOT NULL,
  primary_document TEXT,
  official_url TEXT NOT NULL,
  filing_index_url TEXT NOT NULL,
  downloaded_at TEXT,
  UNIQUE(company_id, form, report_date)
);

CREATE TABLE evidence_links (
  evidence_id TEXT PRIMARY KEY,
  schema_version TEXT NOT NULL,
  evidence_type TEXT NOT NULL,
  label TEXT NOT NULL,
  filing_accession TEXT NOT NULL REFERENCES filings(accession_number) ON DELETE RESTRICT,
  source_url TEXT,
  CHECK(source_url IS NULL OR source_url LIKE 'https://www.sec.gov/%' OR source_url LIKE 'https://data.sec.gov/%')
);

CREATE TABLE evidence_sources (
  evidence_id TEXT NOT NULL REFERENCES evidence_links(evidence_id) ON DELETE CASCADE,
  source_evidence_id TEXT NOT NULL REFERENCES evidence_links(evidence_id) ON DELETE RESTRICT,
  PRIMARY KEY(evidence_id, source_evidence_id),
  CHECK(evidence_id <> source_evidence_id)
);

CREATE TABLE financial_facts (
  evidence_id TEXT PRIMARY KEY REFERENCES evidence_links(evidence_id) ON DELETE CASCADE,
  filing_accession TEXT NOT NULL REFERENCES filings(accession_number) ON DELETE RESTRICT,
  fact_key TEXT NOT NULL,
  name TEXT NOT NULL,
  value REAL NOT NULL,
  formatted_value TEXT NOT NULL,
  unit TEXT NOT NULL,
  taxonomy TEXT NOT NULL,
  concept TEXT NOT NULL,
  sec_label TEXT NOT NULL,
  period_type TEXT NOT NULL CHECK(period_type IN ('instant', 'duration')),
  period_start TEXT,
  period_end TEXT NOT NULL,
  fiscal_year INTEGER,
  fiscal_period TEXT,
  filed TEXT NOT NULL,
  sec_concept_url TEXT NOT NULL,
  UNIQUE(filing_accession, fact_key)
);

CREATE TABLE ratios (
  evidence_id TEXT PRIMARY KEY REFERENCES evidence_links(evidence_id) ON DELETE CASCADE,
  filing_accession TEXT NOT NULL REFERENCES filings(accession_number) ON DELETE RESTRICT,
  ratio_key TEXT NOT NULL,
  name TEXT NOT NULL,
  value REAL NOT NULL,
  percentage REAL NOT NULL,
  formatted_value TEXT NOT NULL,
  formula TEXT NOT NULL,
  calculation TEXT NOT NULL,
  numerator_evidence_id TEXT NOT NULL REFERENCES financial_facts(evidence_id) ON DELETE RESTRICT,
  denominator_evidence_id TEXT NOT NULL REFERENCES financial_facts(evidence_id) ON DELETE RESTRICT,
  UNIQUE(filing_accession, ratio_key)
);

CREATE TABLE filing_comparisons (
  comparison_id TEXT PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  schema_version TEXT NOT NULL,
  current_accession TEXT NOT NULL REFERENCES filings(accession_number) ON DELETE RESTRICT,
  previous_accession TEXT NOT NULL REFERENCES filings(accession_number) ON DELETE RESTRICT,
  form TEXT NOT NULL CHECK(form IN ('10-K', '10-Q')),
  comparison_basis TEXT NOT NULL,
  fiscal_period TEXT,
  calculated_at TEXT NOT NULL,
  warnings_json TEXT NOT NULL DEFAULT '[]',
  UNIQUE(current_accession, previous_accession)
);

CREATE TABLE comparison_changes (
  evidence_id TEXT PRIMARY KEY REFERENCES evidence_links(evidence_id) ON DELETE CASCADE,
  comparison_id TEXT NOT NULL REFERENCES filing_comparisons(comparison_id) ON DELETE CASCADE,
  change_key TEXT NOT NULL,
  name TEXT NOT NULL,
  comparison_type TEXT NOT NULL,
  direction TEXT NOT NULL,
  change_value REAL NOT NULL,
  formatted_change TEXT NOT NULL,
  formula TEXT NOT NULL,
  current_evidence_id TEXT NOT NULL REFERENCES evidence_links(evidence_id) ON DELETE RESTRICT,
  previous_evidence_id TEXT NOT NULL REFERENCES evidence_links(evidence_id) ON DELETE RESTRICT,
  UNIQUE(comparison_id, change_key)
);

CREATE TABLE risk_passages (
  evidence_id TEXT PRIMARY KEY REFERENCES evidence_links(evidence_id) ON DELETE CASCADE,
  filing_accession TEXT NOT NULL REFERENCES filings(accession_number) ON DELETE RESTRICT,
  passage_number INTEGER NOT NULL,
  section TEXT NOT NULL,
  text TEXT NOT NULL,
  report_date TEXT NOT NULL,
  anchor TEXT,
  source_url TEXT NOT NULL,
  UNIQUE(filing_accession, passage_number)
);

CREATE TABLE risk_comparisons (
  comparison_id TEXT PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  schema_version TEXT NOT NULL,
  current_accession TEXT NOT NULL REFERENCES filings(accession_number) ON DELETE RESTRICT,
  previous_accession TEXT NOT NULL REFERENCES filings(accession_number) ON DELETE RESTRICT,
  compared_at TEXT NOT NULL,
  methodology TEXT NOT NULL,
  added_count INTEGER NOT NULL,
  removed_count INTEGER NOT NULL,
  materially_changed_count INTEGER NOT NULL,
  UNIQUE(current_accession, previous_accession)
);

CREATE TABLE risk_changes (
  evidence_id TEXT PRIMARY KEY REFERENCES evidence_links(evidence_id) ON DELETE CASCADE,
  comparison_id TEXT NOT NULL REFERENCES risk_comparisons(comparison_id) ON DELETE CASCADE,
  change_type TEXT NOT NULL CHECK(change_type IN ('added', 'removed', 'materially_changed')),
  similarity REAL,
  current_passage_id TEXT REFERENCES risk_passages(evidence_id) ON DELETE RESTRICT,
  previous_passage_id TEXT REFERENCES risk_passages(evidence_id) ON DELETE RESTRICT,
  CHECK(current_passage_id IS NOT NULL OR previous_passage_id IS NOT NULL)
);

CREATE INDEX idx_companies_name ON companies(name);
CREATE INDEX idx_filings_company_date ON filings(company_id, filing_date DESC);
CREATE INDEX idx_filings_company_form ON filings(company_id, form, filing_date DESC);
CREATE INDEX idx_facts_filing ON financial_facts(filing_accession, fact_key);
CREATE INDEX idx_ratios_filing ON ratios(filing_accession, ratio_key);
CREATE INDEX idx_comparisons_current ON filing_comparisons(current_accession);
CREATE INDEX idx_risk_passages_filing ON risk_passages(filing_accession, passage_number);
CREATE INDEX idx_risk_comparisons_current ON risk_comparisons(current_accession);
CREATE INDEX idx_evidence_filing ON evidence_links(filing_accession);
