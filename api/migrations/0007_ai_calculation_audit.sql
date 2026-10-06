PRAGMA foreign_keys = ON;

ALTER TABLE ai_derived_values ADD COLUMN calculation_version TEXT NOT NULL DEFAULT 'legacy-v1';
ALTER TABLE ai_derived_values ADD COLUMN display_precision INTEGER NOT NULL DEFAULT 2;
ALTER TABLE ai_derived_values ADD COLUMN exact_inputs_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE ai_derived_values ADD COLUMN dependency_path_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE ai_derived_values ADD COLUMN reproduction_status TEXT NOT NULL DEFAULT 'unverified';
ALTER TABLE ai_derived_values ADD COLUMN reproduction_details_json TEXT NOT NULL DEFAULT '{}';

CREATE TABLE ai_response_invalidations (
  response_id TEXT PRIMARY KEY REFERENCES ai_responses(response_id) ON DELETE CASCADE,
  reason_code TEXT NOT NULL,
  detail TEXT NOT NULL,
  invalidated_at TEXT NOT NULL,
  invalidated_by TEXT NOT NULL
);

CREATE TABLE ai_numeric_audits (
  response_id TEXT NOT NULL REFERENCES ai_responses(response_id) ON DELETE CASCADE,
  claim_id TEXT NOT NULL REFERENCES ai_claims(claim_id) ON DELETE CASCADE,
  audit_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('reproduced', 'no_financial_numbers')),
  audit_json TEXT NOT NULL,
  audited_at TEXT NOT NULL,
  PRIMARY KEY(response_id, claim_id)
);

CREATE INDEX idx_ai_derived_values_calculation_version
  ON ai_derived_values(calculation_version, company_id, current_accession);
