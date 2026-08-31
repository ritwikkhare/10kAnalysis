from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

from scripts.build_d1_seed import collect, read_documents, render_sql, sec_url, sql_value


class D1SeedTests(unittest.TestCase):
    def test_minimum_four_company_pilot_builds_valid_sql(self) -> None:
        companies = (
            ("AAPL", "0000320193", "Apple Inc."),
            ("MSFT", "0000789019", "Microsoft Corporation"),
            ("NVDA", "0001045810", "NVIDIA Corporation"),
            ("TSLA", "0001318605", "Tesla, Inc."),
        )
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for index, (ticker, cik, name) in enumerate(companies, start=1):
                accession = f"{int(cik):010d}-26-{index:06d}"
                official_url = f"https://www.sec.gov/Archives/{ticker.lower()}.htm"
                document = {
                    "schema_version": "1.0.0",
                    "record_type": "filing_metadata",
                    "company": {"cik": cik, "ticker": ticker, "name": name},
                    "filings": [
                        {
                            "accession_number": accession,
                            "form": "10-K",
                            "filing_date": "2026-02-01",
                            "report_date": "2025-12-31",
                            "official_url": official_url,
                            "filing_index_url": f"https://www.sec.gov/Archives/{ticker.lower()}-index.html",
                            "role": "primary",
                        }
                    ],
                    "evidence": [
                        {
                            "evidence_id": f"{ticker}-filing",
                            "evidence_type": "filing_document",
                            "label": "10-K filing",
                            "accession_number": accession,
                            "source_url": official_url,
                            "source_evidence_ids": [],
                        }
                    ],
                    "company_name": name,
                    "ticker": ticker,
                    "cik": cik,
                    "form": "10-K",
                    "filing_date": "2026-02-01",
                    "report_date": "2025-12-31",
                    "accession_number": accession,
                    "official_url": official_url,
                    "filing_index_url": f"https://www.sec.gov/Archives/{ticker.lower()}-index.html",
                }
                folder = root / ticker / accession
                folder.mkdir(parents=True)
                (folder / "metadata.json").write_text(json.dumps(document), encoding="utf-8")

            data = collect(read_documents([root]))
            sql = render_sql(data)
            self.assertEqual(set(data.companies), {"AAPL", "MSFT", "NVDA", "TSLA"})
            self.assertEqual(len(data.filings), 4)
            self.assertIn("INSERT OR IGNORE INTO companies", sql)
            self.assertIn("INSERT OR IGNORE INTO evidence_links", sql)

    def test_only_official_sec_https_urls_are_accepted(self) -> None:
        self.assertEqual(sec_url("https://data.sec.gov/example"), "https://data.sec.gov/example")
        with self.assertRaises(ValueError):
            sec_url("https://example.com/not-sec")

    def test_sql_strings_escape_quotes(self) -> None:
        self.assertEqual(sql_value("Tesla's filing"), "'Tesla''s filing'")


if __name__ == "__main__":
    unittest.main()
