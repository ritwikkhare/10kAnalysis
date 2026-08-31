"""Command-line interface for downloading SEC filings."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import sys

from .client import SUPPORTED_FORMS, SecClient, SecError
from .comparison import compare_years
from .financials import extract_financials, find_prior_year_quarter
from .ratios import calculate_ratios
from .report import build_html_report
from .risks import compare_risk_sections, extract_risk_section


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="sec-filing",
        description="Download a company's latest 10-K or 10-Q from SEC EDGAR.",
    )
    parser.add_argument("ticker", help="Company ticker, for example AAPL")
    parser.add_argument(
        "--form",
        type=str.upper,
        choices=SUPPORTED_FORMS,
        default="10-K",
        help="SEC filing form to download (default: 10-K)",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("data/filings"),
        help="Where downloaded filings are saved (default: data/filings)",
    )
    parser.add_argument(
        "--user-agent",
        default=os.environ.get("SEC_USER_AGENT"),
        help="App name and contact email; or set SEC_USER_AGENT",
    )
    parser.add_argument(
        "--extract-financials",
        action="store_true",
        help="Also extract headline financial facts into financials.json",
    )
    parser.add_argument(
        "--calculate-ratios",
        action="store_true",
        help="Extract financials and calculate traceable ratios into ratios.json",
    )
    parser.add_argument(
        "--compare-previous",
        action="store_true",
        help=(
            "Compare with the prior fiscal year; 10-Q uses the same prior-year quarter"
        ),
    )
    parser.add_argument(
        "--compare-risks",
        action="store_true",
        help="Extract and compare Item 1A from the two latest 10-Ks",
    )
    parser.add_argument(
        "--build-report",
        action="store_true",
        help="Run both comparisons and build a self-contained HTML report",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if not args.user_agent:
        print(
            "Missing SEC contact information. Set SEC_USER_AGENT to "
            "'Your Name your.email@example.com' or pass --user-agent.",
            file=sys.stderr,
        )
        return 2

    try:
        if args.form != "10-K" and (args.compare_risks or args.build_report):
            raise SecError(
                "Item 1A comparison and the complete risk report require Form 10-K."
            )
        client = SecClient(args.user_agent)
        filing_count = (
            2
            if args.form == "10-K"
            and (args.compare_previous or args.compare_risks or args.build_report)
            else 1
        )
        downloads = client.download_recent_filings(
            args.ticker,
            args.output_dir,
            form=args.form,
            limit=filing_count,
        )
        metadata, html_path = downloads[0]
        financials_path = None
        ratios_path = None
        comparison_path = None
        risk_changes_path = None
        report_path = None
        comparison_result = None
        risk_comparison_result = None
        quarter_match = None
        pipeline_warnings: list[str] = []
        if (
            args.extract_financials
            or args.calculate_ratios
            or args.compare_previous
            or args.build_report
        ):
            financials, financials_path = extract_financials(
                client.fetch_json,
                metadata,
                html_path.parent,
            )
            pipeline_warnings.extend(financials.warnings)
            if args.calculate_ratios or args.compare_previous or args.build_report:
                ratios, ratios_path = calculate_ratios(financials, html_path.parent)
                pipeline_warnings.extend(ratios.warnings)
            if args.compare_previous or args.build_report:
                if args.form == "10-Q":
                    quarter_match = find_prior_year_quarter(
                        client.fetch_json,
                        financials,
                    )
                    downloads.append(
                        client.download_filing_by_accession(
                            args.ticker,
                            quarter_match.accession_number,
                            args.output_dir,
                        )
                    )
                previous_metadata, previous_html_path = downloads[1]
                previous_financials, _ = extract_financials(
                    client.fetch_json,
                    previous_metadata,
                    previous_html_path.parent,
                )
                previous_ratios, _ = calculate_ratios(
                    previous_financials,
                    previous_html_path.parent,
                )
                pipeline_warnings.extend(previous_financials.warnings)
                pipeline_warnings.extend(previous_ratios.warnings)
                comparison_result, comparison_path = compare_years(
                    financials,
                    previous_financials,
                    ratios,
                    previous_ratios,
                    html_path.parent,
                )
                pipeline_warnings.extend(comparison_result.warnings)
        if args.compare_risks or args.build_report:
            previous_metadata, previous_html_path = downloads[1]
            current_risks, _ = extract_risk_section(
                html_path, metadata, html_path.parent
            )
            previous_risks, _ = extract_risk_section(
                previous_html_path,
                previous_metadata,
                previous_html_path.parent,
            )
            risk_comparison_result, risk_changes_path = compare_risk_sections(
                current_risks,
                previous_risks,
                html_path.parent,
            )
        if args.build_report:
            if comparison_result is None or risk_comparison_result is None:
                raise SecError("Report inputs were not generated.")
            report_path = build_html_report(
                metadata,
                financials,
                ratios,
                comparison_result,
                risk_comparison_result,
                Path("outputs"),
            )
    except (ValueError, SecError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    print(f"Downloaded {metadata.company_name} {metadata.form}")
    print(f"Filed: {metadata.filing_date}")
    print(f"Accession: {metadata.accession_number}")
    print(f"Official URL: {metadata.official_url}")
    print(f"Saved HTML: {html_path.resolve()}")
    print(f"Saved metadata: {(html_path.parent / 'metadata.json').resolve()}")
    if financials_path is not None:
        print(f"Saved financials: {financials_path.resolve()}")
    if ratios_path is not None:
        print(f"Saved ratios: {ratios_path.resolve()}")
    if comparison_path is not None:
        previous_metadata, previous_html_path = downloads[1]
        print(
            f"Downloaded previous {previous_metadata.form}: "
            f"{previous_metadata.accession_number}"
        )
        print(f"Saved previous HTML: {previous_html_path.resolve()}")
        if quarter_match is not None:
            print(
                "Matched fiscal quarter: "
                f"{quarter_match.fiscal_period} FY{quarter_match.current_fiscal_year} "
                f"vs FY{quarter_match.previous_fiscal_year}"
            )
        print(f"Saved comparison: {comparison_path.resolve()}")
    if risk_changes_path is not None:
        previous_metadata, previous_html_path = downloads[1]
        print(f"Compared Item 1A with: {previous_metadata.accession_number}")
        print(f"Saved current risks: {(html_path.parent / 'risk_factors.json').resolve()}")
        print(
            "Saved previous risks: "
            f"{(previous_html_path.parent / 'risk_factors.json').resolve()}"
        )
        print(f"Saved risk changes: {risk_changes_path.resolve()}")
    if report_path is not None:
        print(f"Saved HTML report: {report_path.resolve()}")
    for warning in dict.fromkeys(pipeline_warnings):
        print(f"Warning: {warning}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
