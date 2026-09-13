from __future__ import annotations

import json
import unittest
from urllib.request import Request

from sec_filing.client import SecClient


def columns(rows: list[tuple[str, str, str, str, str]]) -> dict[str, list[str]]:
    keys = ("form", "filingDate", "reportDate", "accessionNumber", "primaryDocument")
    return {key: [row[index] for row in rows] for index, key in enumerate(keys)}


class ArchiveTransport:
    def __init__(self) -> None:
        self.urls: list[str] = []

    def __call__(self, request: Request, timeout: float) -> bytes:
        self.urls.append(request.full_url)
        if request.full_url.endswith("CIK0001234567.json"):
            return json.dumps({"filings": {
                "recent": columns([
                    ("10-Q/A", "2026-08-02", "2026-06-30", "0001234567-26-000003", "amend.htm"),
                    ("10-Q", "2026-08-01", "2026-06-30", "0001234567-26-000002", "current.htm"),
                ]),
                "files": [{"name": "CIK0001234567-submissions-001.json"}],
            }}).encode()
        if request.full_url.endswith("CIK0001234567-submissions-001.json"):
            return json.dumps(columns([
                ("10-Q", "2025-08-01", "2025-06-30", "0001234567-25-000002", "prior.htm"),
            ])).encode()
        raise AssertionError(request.full_url)


class ArchivedSubmissionTests(unittest.TestCase):
    def test_latest_ignores_amendment_and_archive_is_loaded_only_when_needed(self) -> None:
        transport = ArchiveTransport()
        client = SecClient("FilingLens tests@example.com", min_request_interval=0, transport=transport)
        latest = client.latest_filing(1234567, form="10-Q")
        self.assertEqual(latest["accessionNumber"], "0001234567-26-000002")
        self.assertFalse(any("submissions-001" in url for url in transport.urls))
        prior = client.filing_by_accession(1234567, "0001234567-25-000002")
        self.assertEqual(prior["reportDate"], "2025-06-30")
        self.assertTrue(any("submissions-001" in url for url in transport.urls))

    def test_filer_capabilities_are_classified_without_guessing(self) -> None:
        from sec_filing.client import classify_filing_forms

        self.assertEqual(classify_filing_forms({"10-K", "10-Q"})[0], "supported")
        self.assertEqual(classify_filing_forms({"20-F", "6-K"})[0], "foreign_issuer")
        self.assertEqual(classify_filing_forms({"N-CSR", "N-PORT-P"})[0], "fund")
        self.assertEqual(classify_filing_forms(set())[0], "inactive")
        self.assertEqual(classify_filing_forms({"10-K"})[0], "insufficient_forms")


if __name__ == "__main__":
    unittest.main()
