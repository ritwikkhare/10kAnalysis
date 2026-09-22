from __future__ import annotations

from difflib import SequenceMatcher as RealSequenceMatcher
from pathlib import Path
import json
import tempfile
import unittest
from unittest.mock import patch

from sec_filing.client import FilingMetadata
from sec_filing.risks import (
    MAX_APPROXIMATE_CANDIDATES,
    POSITIONAL_NEIGHBORS,
    _risk_candidate_pairs,
    compare_risk_sections,
    extract_risk_section,
)
from sec_filing.schema import validate_document


def metadata(accession: str, report_date: str, url: str) -> FilingMetadata:
    return FilingMetadata(
        company_name="Apple Inc.",
        ticker="AAPL",
        cik="0000320193",
        form="10-K",
        filing_date=report_date,
        report_date=report_date,
        accession_number=accession,
        primary_document="aapl.htm",
        official_url=url,
        filing_index_url=f"{url}-index",
        downloaded_at="2026-01-01T00:00:00+00:00",
    )


class RiskComparisonTests(unittest.TestCase):
    def test_nested_blocks_keep_document_order_and_stop_at_item_1b(self) -> None:
        html = """
        <html><body>
          <div><div>Forward-looking statement outside the risk section contains enough text to look like a passage.</div></div>
          <div id="risk-start"><div><span>Item 1A. Risk Factors</span></div>
            <div><p>Cybersecurity incidents could interrupt operations, harm customers, and create substantial remediation costs.</p></div>
            <div id="risk-page"><p>Changing regulations could restrict products and increase compliance costs across important markets.</p></div>
          </div>
          <div><div>Item 1B. Unresolved Staff Comments.</div>
            <p>Management controls and audit material outside Item 1A must never be included in risk passages.</p>
          </div>
        </body></html>
        """
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = root / "filing.html"
            path.write_text(html, encoding="utf-8")
            result, _ = extract_risk_section(
                path,
                metadata(
                    "0000320193-25-000079",
                    "2025-09-27",
                    "https://www.sec.gov/Archives/nested.htm",
                ),
                root,
            )

        self.assertEqual(len(result.passages), 2)
        combined = " ".join(passage.text for passage in result.passages)
        self.assertNotIn("Forward-looking", combined)
        self.assertNotIn("Management controls", combined)
        self.assertIn("Cybersecurity incidents", combined)
        self.assertIn("Changing regulations", combined)

    def test_item_1a_cross_reference_does_not_start_a_false_section(self) -> None:
        html = """
        <div>Item 1A. Risk Factors.</div>
        <p>A genuine risk passage describes market disruption and operational uncertainty in sufficient detail.</p>
        <div>Item 1B. Unresolved Staff Comments.</div>
        <p>The other uncertainties are detailed in Part I, Item 1A: Risk Factors in this Form 10-K.</p>
        <p>Management and audit material after that cross-reference must not become a new risk section.</p>
        """
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = root / "filing.html"
            path.write_text(html, encoding="utf-8")
            result, _ = extract_risk_section(
                path,
                metadata(
                    "0000320193-25-000079",
                    "2025-09-27",
                    "https://www.sec.gov/Archives/reference.htm",
                ),
                root,
            )

        self.assertEqual(len(result.passages), 1)
        self.assertIn("genuine risk passage", result.passages[0].text)

    def test_large_risk_sections_use_a_bounded_candidate_search(self) -> None:
        current = [
            f"scenario{i:04d} supplier demand regulation cybersecurity and liquidity controls changed this year"
            for i in range(500)
        ]
        previous = [
            f"scenario{i:04d} supplier demand regulation cybersecurity and liquidity controls existed last year"
            for i in range(500)
        ]
        with patch(
            "sec_filing.risks.SequenceMatcher",
            side_effect=lambda *args, **kwargs: RealSequenceMatcher(*args, **kwargs),
        ) as matcher:
            pairs = _risk_candidate_pairs(
                current, previous, match_threshold=0.55
            )
        self.assertEqual(len({item[1] for item in pairs}), 500)
        maximum_per_passage = MAX_APPROXIMATE_CANDIDATES + (2 * POSITIONAL_NEIGHBORS + 1)
        self.assertLessEqual(matcher.call_count, len(current) * maximum_per_passage)

    def test_ignores_table_of_contents_item_1a_and_accepts_item_2_boundary(self) -> None:
        html = """
        <table><tr><td>Item 1A. Risk Factors</td><td>12</td></tr></table>
        <div>Item 1B. Unresolved Staff Comments</div>
        <div id="real-risk">ITEM 1A: RISK FACTORS</div>
        <p>A substantial operating risk passage explains supplier, demand, legal, and technology uncertainty for investors.</p>
        <div>Item 2. Properties</div>
        """
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = root / "filing.html"
            path.write_text(html, encoding="utf-8")
            result, _ = extract_risk_section(
                path,
                metadata("0000320193-25-000079", "2025-09-27", "https://www.sec.gov/Archives/current.htm"),
                root,
            )
            self.assertEqual(len(result.passages), 1)
            self.assertIn("substantial operating risk", result.passages[0].text)

    def test_extracts_item_1a_and_classifies_evidence_linked_changes(self) -> None:
        current_html = """
        <html><body>
          <div id="current-start"></div>
          <div><span>Item 1A. Risk Factors</span></div>
          <div id="current-page"></div>
          <div>An unchanged risk passage explains that global conditions may affect demand for the Company's products.</div>
          <div>The Company relies on a concentrated network of third-party manufacturers; geopolitical restrictions or capacity shortages could delay products and increase costs.</div>
          <div>New artificial intelligence regulations could restrict product features and increase compliance costs in several markets.</div>
          <div>Item 1B. Unresolved Staff Comments</div>
        </body></html>
        """
        previous_html = """
        <html><body>
          <div id="previous-start"></div>
          <div><span>Item 1A. Risk Factors</span></div>
          <div id="previous-page"></div>
          <div>An unchanged risk passage explains that global conditions may affect demand for the Company's products.</div>
          <div>The Company depends on third-party manufacturers, and operational failures could disrupt product supply and increase costs.</div>
          <div>Legacy optical-drive component shortages could reduce availability of certain older products in some regions.</div>
          <div>Item 1B. Unresolved Staff Comments</div>
        </body></html>
        """

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            current_path = root / "current.html"
            previous_path = root / "previous.html"
            current_path.write_text(current_html, encoding="utf-8")
            previous_path.write_text(previous_html, encoding="utf-8")

            current, _ = extract_risk_section(
                current_path,
                metadata(
                    "0000320193-25-000079",
                    "2025-09-27",
                    "https://www.sec.gov/Archives/current.htm",
                ),
                root / "current",
            )
            previous, _ = extract_risk_section(
                previous_path,
                metadata(
                    "0000320193-24-000123",
                    "2024-09-28",
                    "https://www.sec.gov/Archives/previous.htm",
                ),
                root / "previous",
            )
            result, output_path = compare_risk_sections(
                current, previous, root / "current"
            )

            validate_document(
                json.loads((root / "current" / "risk_factors.json").read_text()),
                expected_record_type="risk_passages",
            )
            validate_document(
                json.loads(output_path.read_text()),
                expected_record_type="risk_changes",
            )
            risk_changes_document = json.loads(output_path.read_text())
            filing_evidence = {
                item["evidence_id"]: item
                for item in risk_changes_document["evidence"]
                if item["evidence_type"] == "filing_document"
            }
            self.assertEqual(
                filing_evidence[
                    "AAPL-0000320193-25-000079-filing-document"
                ]["label"],
                "Apple Inc. 10-K",
            )
            self.assertEqual(
                filing_evidence[
                    "AAPL-0000320193-24-000123-filing-document"
                ]["label"],
                "Apple Inc. 10-K",
            )

            change_types = [item.change_type for item in result.changes]
            self.assertEqual(change_types.count("materially_changed"), 1)
            self.assertEqual(change_types.count("added"), 1)
            self.assertEqual(change_types.count("removed"), 1)
            self.assertEqual(result.added_count, 1)
            self.assertEqual(result.removed_count, 1)
            self.assertEqual(result.materially_changed_count, 1)

            for change in result.changes:
                if change.current:
                    self.assertIn("#current-page", change.current.source_url)
                    self.assertTrue(change.current.text)
                if change.previous:
                    self.assertIn("#previous-page", change.previous.source_url)
                    self.assertTrue(change.previous.text)
            self.assertTrue(output_path.exists())


if __name__ == "__main__":
    unittest.main()
