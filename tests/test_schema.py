from __future__ import annotations

import copy
import unittest

from sec_filing.schema import (
    CompanyReference,
    EvidenceReference,
    FilingReference,
    SCHEMA_VERSION,
    SchemaValidationError,
    build_document,
    validate_document,
)


class SchemaTests(unittest.TestCase):
    def setUp(self) -> None:
        self.company = CompanyReference(
            cik="0000320193",
            ticker="AAPL",
            name="Apple Inc.",
        )
        self.filing = FilingReference(
            accession_number="0000320193-25-000079",
            form="10-K",
            filing_date="2025-10-31",
            report_date="2025-09-27",
            official_url="https://www.sec.gov/Archives/aapl.htm",
            filing_index_url="https://www.sec.gov/Archives/aapl-index.html",
        )

    def _valid_document(self):
        fact_id = "AAPL-0000320193-25-000079-revenue"
        return build_document(
            record_type="financial_ratios",
            company=self.company,
            filings=(self.filing,),
            evidence=(
                EvidenceReference(
                    evidence_id=fact_id,
                    evidence_type="xbrl_fact",
                    label="Revenue",
                    accession_number=self.filing.accession_number,
                    source_url="https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json",
                ),
                EvidenceReference(
                    evidence_id="AAPL-0000320193-25-000079-demo-ratio",
                    evidence_type="derived_ratio",
                    label="Demo ratio",
                    accession_number=self.filing.accession_number,
                    source_url=None,
                    source_evidence_ids=(fact_id,),
                ),
            ),
            payload={"ratios": []},
        )

    def test_builds_a_versioned_reusable_envelope(self) -> None:
        document = self._valid_document()
        self.assertEqual(document["schema_version"], SCHEMA_VERSION)
        self.assertEqual(document["record_type"], "financial_ratios")
        self.assertEqual(document["company"]["ticker"], "AAPL")
        self.assertEqual(document["filings"][0]["role"], "primary")
        validate_document(document, expected_record_type="financial_ratios")

    def test_rejects_non_sec_evidence_urls(self) -> None:
        document = self._valid_document()
        document["evidence"][0]["source_url"] = "https://example.com/claim"
        with self.assertRaisesRegex(SchemaValidationError, "official SEC"):
            validate_document(document)

    def test_rejects_a_conclusion_with_missing_input_evidence(self) -> None:
        document = copy.deepcopy(self._valid_document())
        document["evidence"][1]["source_evidence_ids"] = ["missing-fact"]
        with self.assertRaisesRegex(SchemaValidationError, "missing input"):
            validate_document(document)


if __name__ == "__main__":
    unittest.main()
