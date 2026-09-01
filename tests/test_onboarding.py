from __future__ import annotations

import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

from scripts.onboard_company import build_onboarding_import, job_update_sql


JOB_ID = "11111111-1111-4111-8111-111111111111"


class FakeClient:
    def resolve_ticker(self, ticker: str) -> tuple[int, str]:
        return 1234567, "Example Corporation"

    def latest_filing(self, cik: int, *, form: str = "10-K") -> dict[str, str]:
        suffix = "000001" if form == "10-K" else "000002"
        return {"accessionNumber": f"0001234567-26-{suffix}", "filingDate": "2026-08-01"}


class UnsupportedClient(FakeClient):
    def latest_filing(self, cik: int, *, form: str = "10-K") -> dict[str, str]:
        raise ValueError(f"No {form} filing")


class OnboardingTests(unittest.TestCase):
    @staticmethod
    def _valid_runner(ticker: str, form: str, root: Path, user_agent: str) -> int:
        accession = "0001234567-26-000001" if form == "10-K" else "0001234567-26-000002"
        report_date = "2025-12-31" if form == "10-K" else "2026-06-30"
        official_url = f"https://www.sec.gov/Archives/edgar/data/1234567/{accession.replace('-', '')}/example.htm"
        document = {
            "schema_version": "1.0.0",
            "record_type": "filing_metadata",
            "company": {"cik": "0001234567", "ticker": ticker, "name": "Example Corporation"},
            "filings": [{
                "accession_number": accession, "form": form, "filing_date": "2026-08-01",
                "report_date": report_date, "official_url": official_url,
                "filing_index_url": official_url.replace("example.htm", "example-index.htm"), "role": "primary",
            }],
            "evidence": [{
                "evidence_id": f"{ticker}-{accession}-filing", "evidence_type": "filing_document",
                "label": f"{form} filing", "accession_number": accession,
                "source_url": official_url, "source_evidence_ids": [],
            }],
            "company_name": "Example Corporation", "ticker": ticker, "cik": "0001234567",
            "form": form, "filing_date": "2026-08-01", "report_date": report_date,
            "accession_number": accession, "official_url": official_url,
            "filing_index_url": official_url.replace("example.htm", "example-index.htm"),
        }
        folder = root / ticker / accession
        folder.mkdir(parents=True)
        (folder / "metadata.json").write_text(json.dumps(document), encoding="utf-8")
        return 0

    def test_failure_sql_is_safe_and_scoped_to_processing_job(self) -> None:
        sql = job_update_sql(
            JOB_ID,
            status="failed",
            message="No data published.",
            error_code="PIPELINE_FAILED",
            failure_stage="validation",
            diagnostic="bad ' evidence",
            timestamp="2026-08-31T12:00:00+00:00",
        )
        self.assertIn("analysis_job_failures", sql)
        self.assertIn("bad '' evidence", sql)
        self.assertIn("WHERE job_id", sql)
        self.assertIn("AND status = 'processing'", sql)

    def test_unsupported_forms_publish_no_company_or_filing_rows(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            manifest, sql, success = build_onboarding_import(
                job_id=JOB_ID,
                ticker="EXMPL",
                expected_cik="0001234567",
                known_accessions=set(),
                output_dir=Path(directory),
                user_agent="student@example.com",
                client=UnsupportedClient(),
                pipeline_runner=lambda *_: 0,
            )
        self.assertFalse(success)
        self.assertEqual(manifest["status"], "unsupported")
        self.assertNotIn("INSERT OR IGNORE INTO filings", sql)
        self.assertIn("status = 'unsupported'", sql)

    def test_identity_mismatch_fails_before_pipeline(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            manifest, sql, success = build_onboarding_import(
                job_id=JOB_ID,
                ticker="EXMPL",
                expected_cik="9999999999",
                known_accessions=set(),
                output_dir=Path(directory),
                user_agent="student@example.com",
                client=FakeClient(),
                pipeline_runner=lambda *_: self.fail("pipeline must not run"),
            )
        self.assertFalse(success)
        self.assertEqual(manifest["status"], "failed")
        self.assertIn("CIK_MISMATCH", sql)

    def test_invalid_generated_json_blocks_all_publication(self) -> None:
        def invalid_pipeline(ticker: str, form: str, root: Path, user_agent: str) -> int:
            destination = root / ticker / form.replace("-", "")
            destination.mkdir(parents=True, exist_ok=True)
            (destination / "financials.json").write_text(json.dumps({"not": "a schema document"}), encoding="utf-8")
            return 0

        with tempfile.TemporaryDirectory() as directory:
            manifest, sql, success = build_onboarding_import(
                job_id=JOB_ID,
                ticker="EXMPL",
                expected_cik="0001234567",
                known_accessions=set(),
                output_dir=Path(directory),
                user_agent="student@example.com",
                client=FakeClient(),
                pipeline_runner=invalid_pipeline,
            )
        self.assertFalse(success)
        self.assertEqual(manifest["status"], "failed")
        self.assertNotIn("INSERT OR IGNORE INTO companies", sql)
        self.assertIn("PIPELINE_FAILED", sql)

    def test_complete_two_form_result_imports_idempotently_and_completes_job(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            manifest, sql, success = build_onboarding_import(
                job_id=JOB_ID,
                ticker="EXMPL",
                expected_cik="0001234567",
                known_accessions=set(),
                output_dir=Path(directory),
                user_agent="student@example.com",
                client=FakeClient(),
                pipeline_runner=self._valid_runner,
            )
        self.assertTrue(success)
        self.assertEqual(manifest["status"], "completed")

        project = Path(__file__).resolve().parents[1]
        connection = sqlite3.connect(":memory:")
        connection.executescript((project / "api/migrations/0001_initial.sql").read_text())
        connection.executescript((project / "api/migrations/0003_sec_company_directory.sql").read_text())
        connection.executescript((project / "api/migrations/0004_analysis_jobs.sql").read_text())
        connection.execute(
            "INSERT INTO sec_company_directory (ticker, cik, name, source_url, source_fetched_at) VALUES (?, ?, ?, ?, ?)",
            ("EXMPL", "0001234567", "Example Corporation", "https://www.sec.gov/files/company_tickers.json", "2026-08-31T12:00:00Z"),
        )
        connection.execute(
            "INSERT INTO analysis_jobs (job_id, ticker, cik, company_name, status, requested_at, started_at, updated_at, public_message) VALUES (?, ?, ?, ?, 'processing', ?, ?, ?, ?)",
            (JOB_ID, "EXMPL", "0001234567", "Example Corporation", "2026-08-31T12:00:00Z", "2026-08-31T12:01:00Z", "2026-08-31T12:01:00Z", "Processing."),
        )
        connection.executescript(sql)
        connection.executescript(sql)
        self.assertEqual(connection.execute("SELECT COUNT(*) FROM filings").fetchone()[0], 2)
        self.assertEqual(connection.execute("SELECT status FROM analysis_jobs").fetchone()[0], "completed")


if __name__ == "__main__":
    unittest.main()
