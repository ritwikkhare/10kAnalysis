PRAGMA foreign_keys = ON;

CREATE TABLE ai_derived_values (
  evidence_id TEXT PRIMARY KEY REFERENCES evidence_links(evidence_id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  current_accession TEXT NOT NULL REFERENCES filings(accession_number) ON DELETE RESTRICT,
  previous_accession TEXT NOT NULL REFERENCES filings(accession_number) ON DELETE RESTRICT,
  derived_key TEXT NOT NULL,
  name TEXT NOT NULL,
  value_kind TEXT NOT NULL CHECK(value_kind IN ('absolute_change', 'percentage_change', 'percentage_point_change', 'ratio_change')),
  formula_key TEXT NOT NULL,
  formula TEXT NOT NULL,
  unrounded_value REAL NOT NULL,
  displayed_value TEXT NOT NULL,
  unit TEXT NOT NULL,
  input_evidence_ids_json TEXT NOT NULL,
  sec_links_json TEXT NOT NULL,
  calculated_at TEXT NOT NULL,
  UNIQUE(current_accession, previous_accession, derived_key, formula_key)
);

CREATE INDEX idx_ai_derived_values_company
  ON ai_derived_values(company_id, current_accession, previous_accession);
