from __future__ import annotations

import json
from pathlib import Path
import shutil
import tempfile
import unittest

from sec_filing.client import FilingMetadata
from sec_filing.financials import extract_financials, find_prior_year_filing


FIXTURES = Path(__file__).parent / "fixtures"


class InlineXbrlFallbackTests(unittest.TestCase):
    def test_combined_filer_uses_only_consolidated_matching_inline_facts(self) -> None:
        company_facts = json.loads(
            (FIXTURES / "combined_filer_companyfacts.json").read_text(encoding="utf-8")
        )
        submissions = json.loads(
            (FIXTURES / "combined_filer_submissions.json").read_text(encoding="utf-8")
        )
        metadata = FilingMetadata(
            company_name="Duke Energy Corp",
            ticker="DUK",
            cik="0001326160",
            form="10-Q",
            filing_date="2026-08-04",
            report_date="2026-06-30",
            accession_number="0001326160-26-000040",
            primary_document="duk-20260630.htm",
            official_url="https://www.sec.gov/Archives/edgar/data/1326160/000132616026000040/duk-20260630.htm",
            filing_index_url="https://www.sec.gov/Archives/edgar/data/1326160/000132616026000040/0001326160-26-000040-index.html",
            downloaded_at="2026-09-13T00:00:00+00:00",
        )
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary)
            shutil.copyfile(
                FIXTURES / "combined_filer_inline_xbrl.html",
                destination / "filing.html",
            )
            result, output = extract_financials(
                lambda _url: company_facts, metadata, destination
            )
        self.assertEqual(output.name, "financials.json")
        self.assertEqual(len(result.facts), 5)
        revenue = next(item for item in result.facts if item.key == "revenue")
        self.assertEqual(revenue.value, 15_500_000_000)
        self.assertEqual(revenue.fiscal_period, "Q2")
        self.assertEqual(revenue.period_start, "2026-01-01")
        self.assertEqual(revenue.sec_concept_url, f"{metadata.official_url}#fact-revenue")
        self.assertTrue(all("inline XBRL fallback" in item for item in result.warnings))

        match = find_prior_year_filing(
            lambda url: submissions if "submissions" in url else company_facts,
            result,
        )
        self.assertEqual(match.accession_number, "0001326160-25-000168")
        self.assertEqual(match.fiscal_period, "Q2")
        self.assertEqual(match.supporting_metrics, ("validated_report_date_fallback",))


if __name__ == "__main__":
    unittest.main()
