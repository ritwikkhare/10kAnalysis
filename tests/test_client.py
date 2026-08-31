from __future__ import annotations

import json
import copy
from pathlib import Path
import tempfile
import unittest
from urllib.request import Request

from sec_filing.client import SecClient, SecError
from sec_filing.cli import build_parser
from sec_filing.comparison import compare_years
from sec_filing.financials import extract_financials, find_prior_year_quarter
from sec_filing.ratios import calculate_ratios
from sec_filing.report import build_html_report, build_html_report_from_files
from sec_filing.risks import compare_risk_sections, extract_risk_section
from sec_filing.schema import SCHEMA_VERSION, validate_document


TICKERS = {
    "0": {"cik_str": 320193, "ticker": "AAPL", "title": "Apple Inc."},
    "1": {"cik_str": 789019, "ticker": "MSFT", "title": "Microsoft Corp"},
    "2": {"cik_str": 1045810, "ticker": "NVDA", "title": "NVIDIA CORP"},
    "3": {"cik_str": 1318605, "ticker": "TSLA", "title": "Tesla, Inc."},
}

SUBMISSION = {
    "filings": {
        "recent": {
            "form": ["10-Q", "10-Q", "10-Q", "10-K", "10-K"],
            "filingDate": [
                "2026-08-01",
                "2026-05-01",
                "2025-08-01",
                "2025-10-31",
                "2024-11-01",
            ],
            "reportDate": [
                "2026-06-27",
                "2026-03-28",
                "2025-06-28",
                "2025-09-27",
                "2024-09-28",
            ],
            "accessionNumber": [
                "0000320193-26-000001",
                "0000320193-26-000000",
                "0000320193-25-000050",
                "0000320193-25-000079",
                "0000320193-24-000123",
            ],
            "primaryDocument": [
                "aapl-20260627.htm",
                "aapl-20260328.htm",
                "aapl-20250628.htm",
                "aapl-20250927.htm",
                "aapl-20240928.htm",
            ],
        }
    }
}

MICROSOFT_SUBMISSION = {
    "filings": {
        "recent": {
            "form": ["10-Q", "10-K"],
            "filingDate": ["2026-07-30", "2026-07-29"],
            "reportDate": ["2026-06-30", "2026-06-30"],
            "accessionNumber": [
                "0000950170-26-000002",
                "0000950170-26-000001",
            ],
            "primaryDocument": ["msft-20260630q.htm", "msft-20260630.htm"],
        }
    }
}

NVIDIA_SUBMISSION = {
    "filings": {
        "recent": {
            "form": ["10-Q", "10-K"],
            "filingDate": ["2026-05-20", "2026-02-25"],
            "reportDate": ["2026-04-26", "2026-01-25"],
            "accessionNumber": [
                "0001045810-26-000100",
                "0001045810-26-000021",
            ],
            "primaryDocument": ["nvda-20260426.htm", "nvda-20260125.htm"],
        }
    }
}

TESLA_SUBMISSION = {
    "filings": {
        "recent": {
            "form": ["10-Q", "10-K"],
            "filingDate": ["2026-04-23", "2026-01-29"],
            "reportDate": ["2026-03-31", "2025-12-31"],
            "accessionNumber": [
                "0001318605-26-000020",
                "0001318605-26-000010",
            ],
            "primaryDocument": ["tsla-20260331.htm", "tsla-20251231.htm"],
        }
    }
}

TARGET_ACCESSION = "0000320193-25-000079"
QUARTERLY_ACCESSION = "0000320193-26-000001"
PRIOR_YEAR_QUARTERLY_ACCESSION = "0000320193-25-000050"


def fact(value, *, start=None):
    result = {
        "end": "2025-09-27",
        "val": value,
        "accn": TARGET_ACCESSION,
        "fy": 2025,
        "fp": "FY",
        "form": "10-K",
        "filed": "2025-10-31",
    }
    if start:
        result["start"] = start
    return result


def previous_fact(value, *, start=None):
    result = {
        "end": "2024-09-28",
        "val": value,
        "accn": "0000320193-24-000123",
        "fy": 2024,
        "fp": "FY",
        "form": "10-K",
        "filed": "2024-11-01",
    }
    if start:
        result["start"] = start
    return result


def quarterly_fact(value, *, start=None):
    result = {
        "end": "2026-06-27",
        "val": value,
        "accn": QUARTERLY_ACCESSION,
        "fy": 2026,
        "fp": "Q3",
        "form": "10-Q",
        "filed": "2026-08-01",
    }
    if start:
        result["start"] = start
    return result


def prior_year_quarterly_fact(value, *, start=None):
    result = {
        "end": "2025-06-28",
        "val": value,
        "accn": PRIOR_YEAR_QUARTERLY_ACCESSION,
        "fy": 2025,
        "fp": "Q3",
        "form": "10-Q",
        "filed": "2025-08-01",
    }
    if start:
        result["start"] = start
    return result


COMPANY_FACTS = {
    "facts": {
        "us-gaap": {
            "RevenueFromContractWithCustomerExcludingAssessedTax": {
                "label": "Revenue",
                "units": {
                    "USD": [
                        quarterly_fact(98_000_000_000, start="2026-03-29"),
                        quarterly_fact(310_000_000_000, start="2025-09-28"),
                        prior_year_quarterly_fact(
                            285_000_000_000, start="2024-09-29"
                        ),
                        fact(102_000_000_000, start="2025-06-29"),
                        fact(416_161_000_000, start="2024-09-29"),
                        previous_fact(391_035_000_000, start="2023-10-01"),
                    ]
                },
            },
            "NetIncomeLoss": {
                "label": "Net Income (Loss)",
                "units": {
                    "USD": [
                        quarterly_fact(75_000_000_000, start="2025-09-28"),
                        prior_year_quarterly_fact(
                            68_000_000_000, start="2024-09-29"
                        ),
                        fact(112_010_000_000, start="2024-09-29"),
                        previous_fact(93_736_000_000, start="2023-10-01"),
                    ]
                },
            },
            "Assets": {
                "label": "Assets",
                "units": {
                    "USD": [
                        quarterly_fact(370_000_000_000),
                        prior_year_quarterly_fact(350_000_000_000),
                        fact(359_241_000_000),
                        previous_fact(364_980_000_000),
                    ]
                },
            },
            "Liabilities": {
                "label": "Liabilities",
                "units": {
                    "USD": [
                        quarterly_fact(290_000_000_000),
                        prior_year_quarterly_fact(280_000_000_000),
                        fact(285_508_000_000),
                        previous_fact(308_030_000_000),
                    ]
                },
            },
            "NetCashProvidedByUsedInOperatingActivities": {
                "label": "Net Cash Provided by Operating Activities",
                "units": {
                    "USD": [
                        quarterly_fact(82_000_000_000, start="2025-09-28"),
                        prior_year_quarterly_fact(
                            76_000_000_000, start="2024-09-29"
                        ),
                        fact(111_482_000_000, start="2024-09-29"),
                        previous_fact(118_254_000_000, start="2023-10-01"),
                    ]
                },
            },
        }
    }
}


def pilot_company_facts(
    accession: str,
    report_date: str,
    filing_date: str,
    fiscal_year: int,
    *,
    revenue_concept: str = "RevenueFromContractWithCustomerExcludingAssessedTax",
):
    def entry(value, *, start=None):
        item = {
            "end": report_date,
            "val": value,
            "accn": accession,
            "fy": fiscal_year,
            "fp": "FY",
            "form": "10-K",
            "filed": filing_date,
        }
        if start:
            item["start"] = start
        return item

    period_start = f"{fiscal_year - 1}-01-01"
    concepts = {
        revenue_concept: {
            "label": "Revenue",
            "units": {"USD": [entry(100_000_000_000, start=period_start)]},
        },
        "NetIncomeLoss": {
            "label": "Net income",
            "units": {"USD": [entry(20_000_000_000, start=period_start)]},
        },
        "Assets": {"label": "Assets", "units": {"USD": [entry(150_000_000_000)]}},
        "Liabilities": {
            "label": "Liabilities",
            "units": {"USD": [entry(60_000_000_000)]},
        },
        "NetCashProvidedByUsedInOperatingActivities": {
            "label": "Operating cash flow",
            "units": {"USD": [entry(25_000_000_000, start=period_start)]},
        },
    }
    return {"facts": {"us-gaap": concepts}}


PILOT_COMPANY_FACTS = {
    789019: pilot_company_facts(
        "0000950170-26-000001", "2026-06-30", "2026-07-29", 2026
    ),
    1045810: pilot_company_facts(
        "0001045810-26-000021",
        "2026-01-25",
        "2026-02-25",
        2026,
        revenue_concept="Revenues",
    ),
    1318605: pilot_company_facts(
        "0001318605-26-000010", "2025-12-31", "2026-01-29", 2025
    ),
}


class FakeTransport:
    def __init__(self) -> None:
        self.requests: list[Request] = []

    def __call__(self, request: Request, timeout: float) -> bytes:
        self.requests.append(request)
        if request.full_url.endswith("company_tickers.json"):
            return json.dumps(TICKERS).encode()
        if "/submissions/CIK0000320193.json" in request.full_url:
            return json.dumps(SUBMISSION).encode()
        if "/submissions/CIK0000789019.json" in request.full_url:
            return json.dumps(MICROSOFT_SUBMISSION).encode()
        if "/submissions/CIK0001045810.json" in request.full_url:
            return json.dumps(NVIDIA_SUBMISSION).encode()
        if "/submissions/CIK0001318605.json" in request.full_url:
            return json.dumps(TESLA_SUBMISSION).encode()
        if "/api/xbrl/companyfacts/CIK0000320193.json" in request.full_url:
            return json.dumps(COMPANY_FACTS).encode()
        for cik, facts in PILOT_COMPANY_FACTS.items():
            if f"/api/xbrl/companyfacts/CIK{cik:010d}.json" in request.full_url:
                return json.dumps(facts).encode()
        if request.full_url.endswith("aapl-20250927.htm"):
            return b"<html><body>Apple 10-K</body></html>"
        if request.full_url.endswith("aapl-20240928.htm"):
            return b"<html><body>Apple previous 10-K</body></html>"
        if request.full_url.endswith("aapl-20260627.htm"):
            return b"<html><body>Apple 10-Q</body></html>"
        if request.full_url.endswith("aapl-20250628.htm"):
            return b"<html><body>Apple prior-year 10-Q</body></html>"
        if request.full_url.endswith("msft-20260630.htm"):
            return b"<html><body>Microsoft 10-K</body></html>"
        if request.full_url.endswith("msft-20260630q.htm"):
            return b"<html><body>Microsoft 10-Q</body></html>"
        if request.full_url.endswith("nvda-20260125.htm"):
            return b"<html><body>NVIDIA 10-K</body></html>"
        if request.full_url.endswith("nvda-20260426.htm"):
            return b"<html><body>NVIDIA 10-Q</body></html>"
        if request.full_url.endswith("tsla-20251231.htm"):
            return b"<html><body>Tesla 10-K</body></html>"
        if request.full_url.endswith("tsla-20260331.htm"):
            return b"<html><body>Tesla 10-Q</body></html>"
        raise AssertionError(f"Unexpected URL: {request.full_url}")


class SecClientTests(unittest.TestCase):
    def setUp(self) -> None:
        self.transport = FakeTransport()
        self.client = SecClient(
            "SEC Filing Intelligence test@example.com",
            min_request_interval=0,
            transport=self.transport,
        )

    def test_user_agent_requires_contact_email(self) -> None:
        with self.assertRaises(ValueError):
            SecClient("anonymous script")

    def test_resolves_ticker_case_insensitively(self) -> None:
        self.assertEqual(self.client.resolve_ticker("aapl"), (320193, "Apple Inc."))

    def test_unknown_ticker_has_clear_error(self) -> None:
        with self.assertRaisesRegex(SecError, "was not found"):
            self.client.resolve_ticker("NOPE")

    def test_rejects_unsupported_filing_form(self) -> None:
        with self.assertRaisesRegex(ValueError, "Unsupported filing form"):
            self.client.recent_filings(320193, form="8-K", limit=1)

    def test_cli_accepts_ticker_and_quarterly_form(self) -> None:
        args = build_parser().parse_args(["msft", "--form", "10-q"])
        self.assertEqual(args.ticker, "msft")
        self.assertEqual(args.form, "10-Q")

    def test_downloads_latest_10q_and_records_its_form(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            metadata, html_path = self.client.download_latest_filing(
                "aapl", Path(temporary), form="10-Q"
            )

            self.assertEqual(metadata.ticker, "AAPL")
            self.assertEqual(metadata.form, "10-Q")
            self.assertEqual(metadata.accession_number, "0000320193-26-000001")
            self.assertEqual(html_path.read_bytes(), b"<html><body>Apple 10-Q</body></html>")

    def test_extracts_quarterly_financials_and_ratios_with_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            metadata, html_path = self.client.download_latest_filing(
                "AAPL", Path(temporary), form="10-Q"
            )
            financials, _ = extract_financials(
                self.client.fetch_json, metadata, html_path.parent
            )
            ratios, _ = calculate_ratios(financials, html_path.parent)

            self.assertEqual(financials.form, "10-Q")
            self.assertEqual(len(financials.facts), 5)
            self.assertTrue(all(fact.form == "10-Q" for fact in financials.facts))
            self.assertTrue(
                all(fact.accession_number == QUARTERLY_ACCESSION for fact in financials.facts)
            )
            revenue = next(fact for fact in financials.facts if fact.key == "revenue")
            self.assertEqual(revenue.value, 310_000_000_000)
            self.assertEqual(revenue.period_start, "2025-09-28")
            self.assertEqual(ratios.form, "10-Q")
            self.assertEqual(len(ratios.ratios), 3)

    def test_downloads_a_second_company_without_code_changes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            metadata, html_path = self.client.download_latest_filing(
                "MSFT", Path(temporary), form="10-K"
            )

            self.assertEqual(metadata.company_name, "Microsoft Corp")
            self.assertEqual(metadata.ticker, "MSFT")
            self.assertEqual(metadata.cik, "0000789019")
            self.assertEqual(metadata.form, "10-K")
            self.assertEqual(html_path.parent.parent.name, "MSFT")
            self.assertIn("/789019/", metadata.official_url)
            self.assertEqual(
                html_path.read_bytes(), b"<html><body>Microsoft 10-K</body></html>"
            )

    def test_four_company_pilot_downloads_both_filing_forms(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for ticker in ("AAPL", "MSFT", "NVDA", "TSLA"):
                with self.subTest(ticker=ticker, form="10-K"):
                    annual, annual_html = self.client.download_latest_filing(
                        ticker, root, form="10-K"
                    )
                    self.assertEqual(annual.ticker, ticker)
                    self.assertEqual(annual.form, "10-K")
                    self.assertTrue(annual_html.exists())
                with self.subTest(ticker=ticker, form="10-Q"):
                    quarterly, quarterly_html = self.client.download_latest_filing(
                        ticker, root, form="10-Q"
                    )
                    self.assertEqual(quarterly.ticker, ticker)
                    self.assertEqual(quarterly.form, "10-Q")
                    self.assertTrue(quarterly_html.exists())

    def test_four_company_pilot_extracts_annual_facts_and_ratios(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for ticker in ("AAPL", "MSFT", "NVDA", "TSLA"):
                with self.subTest(ticker=ticker):
                    metadata, html_path = self.client.download_latest_filing(
                        ticker, root, form="10-K"
                    )
                    financials, _ = extract_financials(
                        self.client.fetch_json, metadata, html_path.parent
                    )
                    ratios, _ = calculate_ratios(financials, html_path.parent)
                    self.assertEqual(len(financials.facts), 5)
                    self.assertEqual(financials.missing_metrics, ())
                    self.assertEqual(len(ratios.ratios), 3)
                    self.assertEqual(ratios.warnings, ())
                    revenue = next(
                        fact for fact in financials.facts if fact.key == "revenue"
                    )
                    expected_concept = "Revenues" if ticker == "NVDA" else (
                        "RevenueFromContractWithCustomerExcludingAssessedTax"
                    )
                    self.assertEqual(revenue.concept, expected_concept)

    def test_matches_same_fiscal_quarter_from_prior_year(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            current_metadata, current_html = self.client.download_latest_filing(
                "AAPL", root, form="10-Q"
            )
            current_financials, _ = extract_financials(
                self.client.fetch_json, current_metadata, current_html.parent
            )
            match = find_prior_year_quarter(
                self.client.fetch_json, current_financials
            )

            self.assertEqual(match.fiscal_period, "Q3")
            self.assertEqual(match.current_fiscal_year, 2026)
            self.assertEqual(match.previous_fiscal_year, 2025)
            self.assertEqual(
                match.accession_number, PRIOR_YEAR_QUARTERLY_ACCESSION
            )
            self.assertNotEqual(match.accession_number, "0000320193-26-000000")

            previous_metadata, previous_html = self.client.download_filing_by_accession(
                "AAPL", match.accession_number, root
            )
            previous_financials, _ = extract_financials(
                self.client.fetch_json, previous_metadata, previous_html.parent
            )
            current_ratios, _ = calculate_ratios(
                current_financials, current_html.parent
            )
            previous_ratios, _ = calculate_ratios(
                previous_financials, previous_html.parent
            )
            comparison, comparison_path = compare_years(
                current_financials,
                previous_financials,
                current_ratios,
                previous_ratios,
                current_html.parent,
            )
            self.assertEqual(
                comparison.comparison_basis, "same_fiscal_quarter_prior_year"
            )
            self.assertEqual(comparison.fiscal_period, "Q3")
            self.assertEqual(comparison.form, "10-Q")
            self.assertEqual(len(comparison.changes), 8)
            validate_document(
                json.loads(comparison_path.read_text()),
                expected_record_type="filing_comparison",
            )

    def test_missing_fact_is_reported_and_dependent_ratio_is_skipped(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            metadata, html_path = self.client.download_latest_10k(
                "AAPL", Path(temporary)
            )
            incomplete = copy.deepcopy(COMPANY_FACTS)
            del incomplete["facts"]["us-gaap"]["Liabilities"]
            financials, _ = extract_financials(
                lambda _url: incomplete,
                metadata,
                html_path.parent,
            )
            ratios, _ = calculate_ratios(financials, html_path.parent)

            self.assertEqual(financials.missing_metrics, ("Total liabilities",))
            self.assertEqual(len(financials.facts), 4)
            self.assertEqual(len(ratios.ratios), 2)
            self.assertTrue(
                any("Liabilities-to-assets" in warning for warning in ratios.warnings)
            )

    def test_downloads_latest_10k_and_writes_traceable_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            metadata, html_path = self.client.download_latest_10k(
                "AAPL", Path(temporary)
            )

            self.assertEqual(metadata.filing_date, "2025-10-31")
            self.assertEqual(metadata.accession_number, "0000320193-25-000079")
            self.assertEqual(html_path.read_bytes(), b"<html><body>Apple 10-K</body></html>")

            saved = json.loads((html_path.parent / "metadata.json").read_text())
            validate_document(saved, expected_record_type="filing_metadata")
            self.assertEqual(saved["schema_version"], SCHEMA_VERSION)
            self.assertEqual(saved["company"]["ticker"], "AAPL")
            self.assertEqual(saved["official_url"], metadata.official_url)
            self.assertIn("000032019325000079", saved["official_url"])

    def test_every_request_declares_user_agent(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            self.client.download_latest_10k("AAPL", Path(temporary))

        for request in self.transport.requests:
            headers = {key.lower(): value for key, value in request.header_items()}
            self.assertEqual(
                headers["user-agent"], "SEC Filing Intelligence test@example.com"
            )

    def test_extracts_filing_matched_financials_with_source_links(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            metadata, html_path = self.client.download_latest_10k(
                "AAPL", Path(temporary)
            )
            result, financials_path = extract_financials(
                self.client.fetch_json,
                metadata,
                html_path.parent,
            )

            self.assertEqual(len(result.facts), 5)
            revenue = next(item for item in result.facts if item.key == "revenue")
            self.assertEqual(revenue.value, 416_161_000_000)
            self.assertEqual(revenue.accession_number, TARGET_ACCESSION)
            self.assertEqual(revenue.period_end, "2025-09-27")
            self.assertIn("companyconcept", revenue.sec_concept_url)
            self.assertEqual(revenue.filing_url, metadata.official_url)

            saved = json.loads(financials_path.read_text())
            validate_document(saved, expected_record_type="financial_facts")
            self.assertEqual(saved["source_api_url"], result.source_api_url)
            self.assertEqual(len(saved["facts"]), 5)

    def test_calculates_ratios_with_links_to_both_input_facts(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            metadata, html_path = self.client.download_latest_10k(
                "AAPL", Path(temporary)
            )
            financials, _ = extract_financials(
                self.client.fetch_json,
                metadata,
                html_path.parent,
            )
            result, ratios_path = calculate_ratios(financials, html_path.parent)

            self.assertEqual(len(result.ratios), 3)
            net_margin = next(item for item in result.ratios if item.key == "net_margin")
            self.assertEqual(net_margin.formatted_value, "26.92%")
            self.assertEqual(len(net_margin.input_facts), 2)
            self.assertEqual(
                net_margin.numerator_evidence_id,
                net_margin.input_facts[0].evidence_id,
            )
            self.assertTrue(
                all(item.filing_url for item in net_margin.input_facts)
            )
            self.assertTrue(
                all(item.sec_concept_url for item in net_margin.input_facts)
            )

            saved = json.loads(ratios_path.read_text())
            validate_document(saved, expected_record_type="financial_ratios")
            self.assertEqual(len(saved["ratios"]), 3)
            self.assertEqual(saved["ratios"][0]["formula"], "net_income / revenue")

    def test_compares_two_10ks_and_links_every_change_to_both_filings(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            downloads = self.client.download_recent_10ks(
                "AAPL", Path(temporary), limit=2
            )
            current_metadata, current_html = downloads[0]
            previous_metadata, previous_html = downloads[1]
            current_financials, _ = extract_financials(
                self.client.fetch_json, current_metadata, current_html.parent
            )
            previous_financials, _ = extract_financials(
                self.client.fetch_json, previous_metadata, previous_html.parent
            )
            current_ratios, _ = calculate_ratios(
                current_financials, current_html.parent
            )
            previous_ratios, _ = calculate_ratios(
                previous_financials, previous_html.parent
            )

            result, comparison_path = compare_years(
                current_financials,
                previous_financials,
                current_ratios,
                previous_ratios,
                current_html.parent,
            )

            self.assertEqual(len(result.changes), 8)
            revenue = next(item for item in result.changes if item.key == "revenue")
            self.assertEqual(revenue.formatted_change, "+6.43%")
            self.assertNotEqual(
                revenue.current.accession_number,
                revenue.previous.accession_number,
            )
            for change in result.changes:
                self.assertTrue(change.current.filing_url)
                self.assertTrue(change.previous.filing_url)
                self.assertTrue(change.current.source_facts)
                self.assertTrue(change.previous.source_facts)
                self.assertTrue(
                    all(item.sec_concept_url for item in change.current.source_facts)
                )
                self.assertTrue(
                    all(item.sec_concept_url for item in change.previous.source_facts)
                )

            saved = json.loads(comparison_path.read_text())
            validate_document(saved, expected_record_type="filing_comparison")
            self.assertEqual(saved["previous_report_date"], "2024-09-28")
            self.assertEqual(len(saved["changes"]), 8)

            current_risk_html = current_html.parent / "risk-test.html"
            previous_risk_html = previous_html.parent / "risk-test.html"
            current_risk_html.write_text(
                '<div id="cur"></div><div>Item 1A. Risk Factors</div>'
                '<div>A newly expanded risk passage explains material operational '
                'dependencies and possible adverse consequences for the company.</div>'
                '<div>Item 1B. Unresolved Staff Comments</div>',
                encoding="utf-8",
            )
            previous_risk_html.write_text(
                '<div id="prev"></div><div>Item 1A. Risk Factors</div>'
                '<div>An earlier risk passage explains operational dependencies and '
                'possible consequences for the company.</div>'
                '<div>Item 1B. Unresolved Staff Comments</div>',
                encoding="utf-8",
            )
            current_risks, _ = extract_risk_section(
                current_risk_html, current_metadata, current_html.parent
            )
            previous_risks, _ = extract_risk_section(
                previous_risk_html, previous_metadata, previous_html.parent
            )
            risk_result, _ = compare_risk_sections(
                current_risks, previous_risks, current_html.parent
            )
            report_path = build_html_report(
                current_metadata,
                current_financials,
                current_ratios,
                result,
                risk_result,
                Path(temporary) / "outputs",
            )
            report_html = report_path.read_text(encoding="utf-8")
            self.assertIn("Apple Inc. annual filing change report", report_html)
            self.assertIn("data-filter=\"materially_changed\"", report_html)
            self.assertIn("Open cited passage", report_html)

            schema_report_path = build_html_report_from_files(
                current_html.parent,
                Path(temporary) / "schema-report",
            )
            self.assertIn(
                "Apple Inc. annual filing change report",
                schema_report_path.read_text(encoding="utf-8"),
            )


if __name__ == "__main__":
    unittest.main()
