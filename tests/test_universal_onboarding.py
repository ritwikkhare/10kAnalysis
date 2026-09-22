from __future__ import annotations

from dataclasses import replace
from pathlib import Path
import sqlite3
import tempfile
import unittest

from scripts.build_d1_seed import collect, read_documents, render_sql
from sec_filing.client import FilingMetadata
from sec_filing.comparison import compare_years
from sec_filing.financials import extract_financials, find_prior_year_filing
from sec_filing.ratios import calculate_ratios
from sec_filing.risks import compare_risk_sections, extract_risk_section


COMPANIES = (
    ("COST", 909832, "Costco Wholesale", "RevenueFromContractWithCustomerExcludingAssessedTax", "FY"),
    ("JPM", 19617, "JPMorgan Chase", "RevenuesNetOfInterestExpense", "FY"),
    ("BA", 12927, "Boeing", "SalesRevenueNet", "FY"),
    ("DUK", 1326160, "Duke Energy", "RegulatedAndUnregulatedOperatingRevenue", "FY"),
    ("CRM", 1108524, "Salesforce", "SalesRevenueServicesNet", "FY"),
)


def _metadata(ticker: str, cik: int, name: str, form: str, accession: str, report_date: str) -> FilingMetadata:
    compact = accession.replace("-", "")
    url = f"https://www.sec.gov/Archives/edgar/data/{cik}/{compact}/{ticker.lower()}.htm"
    return FilingMetadata(
        company_name=name, ticker=ticker, cik=f"{cik:010d}", form=form,
        filing_date=report_date, report_date=report_date, accession_number=accession,
        primary_document=f"{ticker.lower()}.htm", official_url=url,
        filing_index_url=f"https://www.sec.gov/Archives/edgar/data/{cik}/{compact}/{accession}-index.html",
        downloaded_at="2026-09-01T00:00:00+00:00",
    )


def _entry(metadata: FilingMetadata, value: int, fy: int, fp: str, start: str | None) -> dict[str, object]:
    item: dict[str, object] = {
        "end": metadata.report_date, "val": value, "accn": metadata.accession_number,
        "fy": fy, "fp": fp, "form": metadata.form, "filed": metadata.filing_date,
    }
    if start:
        item["start"] = start
    return item


def _facts_bundle(cik: int, revenue_concept: str, filings: list[tuple[FilingMetadata, int, str, str]]) -> dict[str, object]:
    duration = {
        revenue_concept: ("Revenue", 1_000_000_000),
        "NetIncomeLoss": ("Net income", 120_000_000),
        "NetCashProvidedByUsedInOperatingActivities": ("Operating cash flow", 180_000_000),
    }
    instant = {"Assets": ("Assets", 2_000_000_000), "Liabilities": ("Liabilities", 900_000_000)}
    concepts: dict[str, object] = {}
    for concept, (label, base) in duration.items():
        concepts[concept] = {"label": label, "units": {"USD": [
            _entry(meta, base + offset * 10_000_000, fy, fp, start)
            for meta, fy, fp, start, offset in ((*item, index) for index, item in enumerate(filings))
        ]}}
    for concept, (label, base) in instant.items():
        concepts[concept] = {"label": label, "units": {"USD": [
            _entry(meta, base + offset * 10_000_000, fy, fp, None)
            for meta, fy, fp, start, offset in ((*item, index) for index, item in enumerate(filings))
        ]}}
    return {"cik": cik, "facts": {"us-gaap": concepts}}


class UniversalOnboardingFixtureTests(unittest.TestCase):
    def test_five_diverse_unprocessed_companies_build_complete_local_dashboards(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output_roots: list[Path] = []
            for company_index, (ticker, cik, name, revenue_concept, _) in enumerate(COMPANIES, start=1):
                prefix = f"{cik:010d}-26"
                annual_current = _metadata(ticker, cik, name, "10-K", f"{prefix}-000001", "2025-12-31")
                annual_previous = _metadata(ticker, cik, name, "10-K", f"{cik:010d}-25-000001", "2024-12-31")
                quarter_current = _metadata(ticker, cik, name, "10-Q", f"{prefix}-000002", "2026-06-30")
                quarter_previous = _metadata(ticker, cik, name, "10-Q", f"{cik:010d}-25-000002", "2025-06-30")
                filing_rows = [
                    (annual_current, 2025, "FY", "2025-01-01"),
                    (annual_previous, 2024, "FY", "2024-01-01"),
                    (quarter_current, 2026, "Q2", "2026-01-01"),
                    (quarter_previous, 2025, "Q2", "2025-01-01"),
                ]
                bundle = _facts_bundle(cik, revenue_concept, filing_rows)
                fetch = lambda _url, value=bundle: value
                company_root = root / ticker
                output_roots.append(company_root)
                extracted = {}
                ratios = {}
                for metadata, *_ in filing_rows:
                    destination = company_root / metadata.accession_number
                    value, _ = extract_financials(fetch, metadata, destination)
                    extracted[metadata.accession_number] = value
                    ratios[metadata.accession_number], _ = calculate_ratios(value, destination)

                annual_match = find_prior_year_filing(fetch, extracted[annual_current.accession_number])
                quarter_match = find_prior_year_filing(fetch, extracted[quarter_current.accession_number])
                self.assertEqual(annual_match.accession_number, annual_previous.accession_number)
                self.assertEqual(quarter_match.accession_number, quarter_previous.accession_number)
                self.assertEqual(quarter_match.fiscal_period, "Q2")
                self.assertEqual(
                    next(item for item in extracted[annual_current.accession_number].facts if item.key == "revenue").concept,
                    revenue_concept,
                )
                for current, previous in ((annual_current, annual_previous), (quarter_current, quarter_previous)):
                    compare_years(
                        extracted[current.accession_number], extracted[previous.accession_number],
                        ratios[current.accession_number], ratios[previous.accession_number],
                        company_root / current.accession_number,
                    )

                risk_html = (
                    "<div>Item 1A — Risk Factors</div>"
                    "<p id='risk'>Demand, regulation, suppliers, cyber incidents, and economic conditions may materially affect operations and financial results.</p>"
                    "<div>Item 1B. Unresolved Staff Comments</div>"
                )
                previous_risk_html = risk_html.replace("cyber incidents", "technology disruptions")
                current_path = company_root / annual_current.accession_number / "filing.html"
                previous_path = company_root / annual_previous.accession_number / "filing.html"
                current_path.parent.mkdir(parents=True, exist_ok=True)
                previous_path.parent.mkdir(parents=True, exist_ok=True)
                current_path.write_text(risk_html, encoding="utf-8")
                previous_path.write_text(previous_risk_html, encoding="utf-8")
                current_risks, _ = extract_risk_section(current_path, annual_current, current_path.parent)
                previous_risks, _ = extract_risk_section(previous_path, annual_previous, previous_path.parent)
                compare_risk_sections(current_risks, previous_risks, current_path.parent)

            seed = collect(read_documents(output_roots), required_tickers={item[0] for item in COMPANIES})
            database = sqlite3.connect(":memory:")
            database.executescript((Path("api/migrations/0001_initial.sql")).read_text(encoding="utf-8"))
            database.executescript(render_sql(seed))
            self.assertEqual(database.execute("SELECT COUNT(*) FROM companies").fetchone()[0], 5)
            for ticker, *_ in COMPANIES:
                counts = database.execute(
                    """SELECT COUNT(DISTINCT f.accession_number), COUNT(DISTINCT x.evidence_id),
                       COUNT(DISTINCT r.evidence_id), COUNT(DISTINCT c.comparison_id)
                       FROM companies co JOIN filings f ON f.company_id=co.id
                       LEFT JOIN financial_facts x ON x.filing_accession=f.accession_number
                       LEFT JOIN ratios r ON r.filing_accession=f.accession_number
                       LEFT JOIN filing_comparisons c ON c.company_id=co.id WHERE co.ticker=?""",
                    (ticker,),
                ).fetchone()
                self.assertEqual(counts[0], 4)
                self.assertGreaterEqual(counts[1], 20)
                self.assertGreaterEqual(counts[2], 12)
                self.assertEqual(counts[3], 2)
                self.assertGreater(database.execute(
                    "SELECT COUNT(*) FROM risk_changes rc JOIN risk_comparisons r ON r.comparison_id=rc.comparison_id JOIN companies c ON c.id=r.company_id WHERE c.ticker=?",
                    (ticker,),
                ).fetchone()[0], 0)


if __name__ == "__main__":
    unittest.main()
