PRAGMA foreign_keys = ON;

CREATE TABLE ai_responses (
  response_id TEXT PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  data_fingerprint TEXT NOT NULL,
  response_type TEXT NOT NULL CHECK(response_type IN ('analysis', 'qa')),
  question TEXT,
  question_hash TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  sentiment TEXT CHECK(sentiment IS NULL OR sentiment IN ('bullish', 'neutral', 'bearish')),
  confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
  refused INTEGER NOT NULL CHECK(refused IN (0, 1)),
  refusal_reason TEXT,
  validation_status TEXT NOT NULL CHECK(validation_status = 'passed'),
  validation_details_json TEXT NOT NULL,
  UNIQUE(company_id, response_type, data_fingerprint, question_hash, prompt_version, model),
  CHECK((refused = 0 AND refusal_reason IS NULL) OR (refused = 1 AND refusal_reason IS NOT NULL))
);

CREATE TABLE ai_claims (
  claim_id TEXT PRIMARY KEY,
  response_id TEXT NOT NULL REFERENCES ai_responses(response_id) ON DELETE CASCADE,
  claim_order INTEGER NOT NULL CHECK(claim_order >= 0),
  claim_kind TEXT NOT NULL CHECK(claim_kind IN ('summary', 'supporting', 'opposing', 'uncertainty', 'answer')),
  text TEXT NOT NULL CHECK(length(text) BETWEEN 1 AND 600),
  UNIQUE(response_id, claim_order)
);

CREATE TABLE ai_claim_evidence (
  claim_id TEXT NOT NULL REFERENCES ai_claims(claim_id) ON DELETE CASCADE,
  evidence_id TEXT NOT NULL REFERENCES evidence_links(evidence_id) ON DELETE RESTRICT,
  PRIMARY KEY(claim_id, evidence_id)
);

CREATE INDEX idx_ai_responses_company_generated
  ON ai_responses(company_id, generated_at DESC);
CREATE INDEX idx_ai_claims_response
  ON ai_claims(response_id, claim_order);
CREATE INDEX idx_ai_claim_evidence_evidence
  ON ai_claim_evidence(evidence_id);
