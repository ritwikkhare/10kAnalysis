from __future__ import annotations

from argparse import Namespace
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from scripts.sync_sec_tickers import (
    DirectoryError,
    FetchResult,
    SOURCE_URL,
    normalize_directory,
    render_sql,
    synchronize,
    validate_user_agent,
)


SAMPLE = {
    "0": {"cik_str": 320193, "ticker": "AAPL", "title": "Apple Inc."},
    "1": {"cik_str": 1652044, "ticker": "GOOG", "title": "Alphabet Inc."},
}


class SecDirectoryTests(unittest.TestCase):
    def test_normalizes_ciks_and_rejects_untrusted_rows(self) -> None:
        companies = normalize_directory(SAMPLE, minimum_entries=2)
        self.assertEqual(companies[0].cik, "0000320193")
        self.assertEqual(companies[1].ticker, "GOOG")

        invalid = {"0": {"cik_str": 1, "ticker": "BAD ticker", "title": "Bad"}}
        with self.assertRaises(DirectoryError):
            normalize_directory(invalid)
        with self.assertRaises(ValueError):
            validate_user_agent("anonymous-client")

    def test_rendered_sql_replaces_the_directory_idempotently(self) -> None:
        companies = normalize_directory(SAMPLE, minimum_entries=2)
        sql = render_sql(
            companies,
            fetched_at="2026-09-01T00:00:00+00:00",
            sha256="a" * 64,
            etag='"sample"',
            last_modified="Mon, 01 Sep 2026 00:00:00 GMT",
        )
        connection = sqlite3.connect(":memory:")
        migration = Path("api/migrations/0003_sec_company_directory.sql").read_text()
        connection.executescript(migration)
        connection.executescript(sql)
        connection.executescript(sql)
        self.assertEqual(
            connection.execute("SELECT COUNT(*) FROM sec_company_directory").fetchone()[0],
            2,
        )
        self.assertEqual(
            connection.execute(
                "SELECT row_count, source_url FROM sec_directory_sync WHERE singleton_id = 1"
            ).fetchone(),
            (2, SOURCE_URL),
        )

    def test_conditional_download_reuses_a_validated_cache(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            args = Namespace(
                user_agent="FilingLens tests@example.com",
                cache_file=root / "company_tickers.json",
                metadata_file=root / "company_tickers.metadata.json",
                sql_output=root / "import.sql",
                minimum_entries=2,
                timeout=1.0,
                force=False,
            )
            body = json.dumps(SAMPLE).encode()
            with patch(
                "scripts.sync_sec_tickers.fetch_directory",
                side_effect=[
                    FetchResult(200, body, '"sample"', "Mon, 01 Sep 2026 00:00:00 GMT"),
                    FetchResult(304, None, '"sample"', "Mon, 01 Sep 2026 00:00:00 GMT"),
                ],
            ):
                first = synchronize(args)
                second = synchronize(args)

            self.assertEqual(first["status"], "downloaded")
            self.assertEqual(second["status"], "not_modified")
            self.assertEqual(second["row_count"], 2)
            self.assertTrue(args.sql_output.exists())


if __name__ == "__main__":
    unittest.main()
