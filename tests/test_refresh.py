from __future__ import annotations

import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

from scripts.refresh_filings import (
    execute_refresh,
    read_known_accessions,
    render_import_sql,
    render_refresh_status_sql,
)


class FakeDiscoveryClient:
    filings = {
        (1, "10-K"): {
            "accessionNumber": "0000000001-26-000001",
            "filingDate": "2026-02-01",
        },
        (1, "10-Q"): {
            "accessionNumber": "0000000001-26-000002",
            "filingDate": "2026-05-01",
        },
    }

    def resolve_ticker(self, ticker: str) -> tuple[int, str]:
        if ticker == "FAIL":
            raise RuntimeError("Ticker discovery failed")
        return 1, "Test Corporation"

    def latest_filing(self, cik: int, *, form: str = "10-K") -> dict[str, str]:
        return self.filings[(cik, form)]


class RefreshTests(unittest.TestCase):
    @staticmethod
    def _write_metadata(output: Path, *, accession: str, form: str) -> None:
        official_url = "https://www.sec.gov/Archives/edgar/data/1/test.htm"
        document = {
            "schema_version": "1.0.0",
            "record_type": "filing_metadata",
            "company": {"cik": "0000000001", "ticker": "AAPL", "name": "Apple Inc."},
            "filings": [
                {
                    "accession_number": accession,
                    "form": form,
                    "filing_date": "2026-05-01",
                    "report_date": "2026-03-31",
                    "official_url": official_url,
                    "filing_index_url": "https://www.sec.gov/Archives/edgar/data/1/test-index.htm",
                    "role": "primary",
                }
            ],
            "evidence": [
                {
                    "evidence_id": "AAPL-filing",
                    "evidence_type": "filing_document",
                    "label": f"{form} filing",
                    "accession_number": accession,
                    "source_url": official_url,
                    "source_evidence_ids": [],
                }
            ],
            "company_name": "Apple Inc.",
            "ticker": "AAPL",
            "cik": "0000000001",
            "form": form,
            "filing_date": "2026-05-01",
            "report_date": "2026-03-31",
            "accession_number": accession,
            "official_url": official_url,
            "filing_index_url": "https://www.sec.gov/Archives/edgar/data/1/test-index.htm",
        }
        folder = output / "AAPL" / accession
        folder.mkdir(parents=True)
        (folder / "metadata.json").write_text(json.dumps(document), encoding="utf-8")

    def test_reads_wranger_accession_output(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "known.json"
            path.write_text(
                json.dumps([{"results": [{"accession_number": "0000000001-26-000001"}]}]),
                encoding="utf-8",
            )
            self.assertEqual(read_known_accessions(path), {"0000000001-26-000001"})

    def test_processes_only_new_accessions(self) -> None:
        calls: list[tuple[str, str]] = []

        def runner(ticker: str, form: str, output: Path, user_agent: str) -> int:
            calls.append((ticker, form))
            return 0

        with tempfile.TemporaryDirectory() as temporary:
            # Document validation is deliberately reached after the runner. Returning
            # no documents makes the new target fail safely instead of publishing it.
            run = execute_refresh(
                FakeDiscoveryClient(),
                tickers=("AAPL",),
                forms=("10-K", "10-Q"),
                known_accessions={"0000000001-26-000001"},
                output_dir=Path(temporary),
                user_agent="FilingLens test@example.com",
                pipeline_runner=runner,
                run_id="run-1",
                now=lambda: "2026-08-31T12:00:00+00:00",
            )
        self.assertEqual(calls, [("AAPL", "10-Q")])
        self.assertEqual(run.results[0].status, "up_to_date")
        self.assertEqual(run.results[1].status, "failed")
        self.assertEqual(run.status, "partial_failure")

    def test_failure_sql_preserves_existing_data_and_records_diagnostics(self) -> None:
        run = execute_refresh(
            FakeDiscoveryClient(),
            tickers=("FAIL",),
            forms=("10-K",),
            known_accessions=set(),
            output_dir=Path("unused"),
            user_agent="FilingLens test@example.com",
            run_id="run-2",
            now=lambda: "2026-08-31T12:00:00+00:00",
        )
        sql = render_refresh_status_sql(run)
        self.assertEqual(run.status, "failed")
        self.assertIn("INSERT INTO refresh_failures", sql)
        self.assertIn("existing data was preserved", sql)
        self.assertIn("ON CONFLICT(company_id) DO UPDATE", sql)

    def test_status_sql_executes_against_the_migrated_schema(self) -> None:
        run = execute_refresh(
            FakeDiscoveryClient(),
            tickers=("AAPL",),
            forms=("10-K",),
            known_accessions={"0000000001-26-000001"},
            output_dir=Path("unused"),
            user_agent="FilingLens test@example.com",
            run_id="run-3",
            now=lambda: "2026-08-31T12:00:00+00:00",
        )
        connection = sqlite3.connect(":memory:")
        project = Path(__file__).resolve().parents[1]
        connection.executescript((project / "api/migrations/0001_initial.sql").read_text())
        connection.executescript((project / "api/migrations/0002_refresh_status.sql").read_text())
        connection.execute(
            "INSERT INTO companies (schema_version, cik, ticker, name) VALUES ('1.0.0', '0000000001', 'AAPL', 'Apple Inc.')"
        )
        connection.execute(
            "INSERT INTO filings (accession_number, company_id, schema_version, form, filing_date, report_date, official_url, filing_index_url) VALUES (?, 1, '1.0.0', '10-K', '2026-02-01', '2025-12-31', 'https://www.sec.gov/current.htm', 'https://www.sec.gov/current-index.htm')",
            ("0000000001-26-000001",),
        )
        status_sql = render_refresh_status_sql(run)
        connection.executescript(status_sql)
        connection.executescript(status_sql)
        self.assertEqual(
            connection.execute("SELECT status FROM refresh_runs").fetchone()[0],
            "succeeded",
        )
        self.assertEqual(
            connection.execute("SELECT status FROM company_refresh_status").fetchone()[0],
            "up_to_date",
        )
        self.assertEqual(connection.execute("SELECT COUNT(*) FROM refresh_runs").fetchone()[0], 1)

    def test_validated_new_filing_import_is_end_to_end_idempotent(self) -> None:
        def runner(ticker: str, form: str, output: Path, user_agent: str) -> int:
            self._write_metadata(
                output,
                accession="0000000001-26-000002",
                form=form,
            )
            return 0

        with tempfile.TemporaryDirectory() as temporary:
            run = execute_refresh(
                FakeDiscoveryClient(),
                tickers=("AAPL",),
                forms=("10-Q",),
                known_accessions=set(),
                output_dir=Path(temporary),
                user_agent="FilingLens test@example.com",
                pipeline_runner=runner,
                run_id="run-4",
                now=lambda: "2026-08-31T12:00:00+00:00",
            )
            sql = render_import_sql(run)

        connection = sqlite3.connect(":memory:")
        project = Path(__file__).resolve().parents[1]
        connection.executescript((project / "api/migrations/0001_initial.sql").read_text())
        connection.executescript((project / "api/migrations/0002_refresh_status.sql").read_text())
        connection.executescript(sql)
        connection.executescript(sql)

        self.assertEqual(run.status, "succeeded")
        self.assertEqual(run.filings_imported, 1)
        self.assertEqual(connection.execute("SELECT COUNT(*) FROM filings").fetchone()[0], 1)
        self.assertEqual(connection.execute("SELECT COUNT(*) FROM refresh_runs").fetchone()[0], 1)
        self.assertEqual(
            connection.execute("SELECT status FROM company_refresh_status").fetchone()[0],
            "imported",
        )


if __name__ == "__main__":
    unittest.main()
