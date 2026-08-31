from __future__ import annotations

from pathlib import Path
import tempfile
import unittest

from sec_filing.client import FilingMetadata
from sec_filing.risks import compare_risk_sections, extract_risk_section


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
                metadata("current-accession", "2025-09-27", "https://sec/current"),
                root / "current",
            )
            previous, _ = extract_risk_section(
                previous_path,
                metadata("previous-accession", "2024-09-28", "https://sec/previous"),
                root / "previous",
            )
            result, output_path = compare_risk_sections(
                current, previous, root / "current"
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

