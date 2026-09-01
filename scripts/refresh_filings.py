"""Discover and process new pilot filings into one idempotent D1 import."""

from __future__ import annotations

import argparse
from collections.abc import Callable, Iterable
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
import json
import os
from pathlib import Path
import sys
from typing import Any, Protocol
from uuid import uuid4

from scripts.build_d1_seed import collect, read_documents, render_sql, sql_value
from sec_filing.client import SUPPORTED_FORMS, SecClient
from sec_filing.schema import validate_document


PILOT_TICKERS = ("AAPL", "MSFT", "NVDA", "TSLA")


class DiscoveryClient(Protocol):
    def resolve_ticker(self, ticker: str) -> tuple[int, str]: ...

    def latest_filing(self, cik: int, *, form: str = "10-K") -> dict[str, str]: ...


PipelineRunner = Callable[[str, str, Path, str], int]


@dataclass(frozen=True)
class TargetResult:
    ticker: str
    form: str
    status: str
    accession_number: str | None
    filing_date: str | None
    stage: str
    error_code: str | None = None
    message: str = ""
    output_root: str | None = None


@dataclass(frozen=True)
class RefreshRun:
    run_id: str
    trigger_type: str
    status: str
    started_at: str
    completed_at: str
    companies_checked: int
    filings_discovered: int
    filings_imported: int
    error_count: int
    error_summary: str | None
    results: tuple[TargetResult, ...]


def _utc_now() -> str:
    return datetime.now(UTC).isoformat()


def _collect_accessions(value: Any, output: set[str]) -> None:
    if isinstance(value, dict):
        accession = value.get("accession_number")
        if isinstance(accession, str):
            output.add(accession)
        for child in value.values():
            _collect_accessions(child, output)
    elif isinstance(value, list):
        for child in value:
            _collect_accessions(child, output)


def read_known_accessions(path: Path | None) -> set[str]:
    """Read accession rows from Wrangler JSON or a simple JSON array."""

    if path is None or not path.exists():
        return set()
    value = json.loads(path.read_text(encoding="utf-8"))
    output: set[str] = set()
    _collect_accessions(value, output)
    return output


def default_pipeline_runner(
    ticker: str,
    form: str,
    output_root: Path,
    user_agent: str,
) -> int:
    """Run the existing evidence-preserving pipeline for one filing target."""

    from sec_filing.cli import main as cli_main

    arguments = [
        ticker,
        "--form",
        form,
        "--output-dir",
        str(output_root),
        "--user-agent",
        user_agent,
        "--calculate-ratios",
        "--compare-previous",
    ]
    if form == "10-K":
        arguments.append("--compare-risks")
    return cli_main(arguments)


def execute_refresh(
    client: DiscoveryClient,
    *,
    tickers: Iterable[str],
    forms: Iterable[str],
    known_accessions: set[str],
    output_dir: Path,
    user_agent: str,
    pipeline_runner: PipelineRunner = default_pipeline_runner,
    trigger_type: str = "manual",
    run_id: str | None = None,
    now: Callable[[], str] = _utc_now,
) -> RefreshRun:
    """Discover immutable accessions, process only new ones, and retain failures."""

    started_at = now()
    results: list[TargetResult] = []
    normalized_tickers = tuple(dict.fromkeys(item.strip().upper() for item in tickers))
    normalized_forms = tuple(dict.fromkeys(item.strip().upper() for item in forms))

    for ticker in normalized_tickers:
        try:
            cik, _ = client.resolve_ticker(ticker)
        except Exception as exc:  # discovery failures are data, not process crashes
            for form in normalized_forms:
                results.append(
                    TargetResult(
                        ticker=ticker,
                        form=form,
                        status="failed",
                        accession_number=None,
                        filing_date=None,
                        stage="discovery",
                        error_code=type(exc).__name__.upper(),
                        message=str(exc),
                    )
                )
            continue

        for form in normalized_forms:
            try:
                filing = client.latest_filing(cik, form=form)
                accession = filing["accessionNumber"]
                filing_date = filing["filingDate"]
            except Exception as exc:
                results.append(
                    TargetResult(
                        ticker=ticker,
                        form=form,
                        status="failed",
                        accession_number=None,
                        filing_date=None,
                        stage="discovery",
                        error_code=type(exc).__name__.upper(),
                        message=str(exc),
                    )
                )
                continue

            if accession in known_accessions:
                results.append(
                    TargetResult(
                        ticker=ticker,
                        form=form,
                        status="up_to_date",
                        accession_number=accession,
                        filing_date=filing_date,
                        stage="complete",
                        message="Latest SEC filing is already stored.",
                    )
                )
                continue

            target_root = output_dir / "targets" / f"{ticker}-{form.replace('-', '').lower()}"
            try:
                exit_code = pipeline_runner(ticker, form, target_root, user_agent)
                if exit_code != 0:
                    raise RuntimeError(f"Pipeline exited with status {exit_code}.")
                validate_generated_documents(target_root)
            except Exception as exc:
                results.append(
                    TargetResult(
                        ticker=ticker,
                        form=form,
                        status="failed",
                        accession_number=accession,
                        filing_date=filing_date,
                        stage="processing",
                        error_code=type(exc).__name__.upper(),
                        message=str(exc),
                    )
                )
                continue

            results.append(
                TargetResult(
                    ticker=ticker,
                    form=form,
                    status="imported",
                    accession_number=accession,
                    filing_date=filing_date,
                    stage="complete",
                    message="Validated filing data is ready for idempotent import.",
                    output_root=str(target_root),
                )
            )

    completed_at = now()
    errors = [item for item in results if item.status == "failed"]
    successes = [item for item in results if item.status != "failed"]
    if errors and successes:
        status = "partial_failure"
    elif errors:
        status = "failed"
    else:
        status = "succeeded"
    return RefreshRun(
        run_id=run_id or str(uuid4()),
        trigger_type=trigger_type,
        status=status,
        started_at=started_at,
        completed_at=completed_at,
        companies_checked=len(normalized_tickers),
        filings_discovered=sum(
            item.accession_number is not None and item.status != "up_to_date"
            for item in results
        ),
        filings_imported=sum(item.status == "imported" for item in results),
        error_count=len(errors),
        error_summary=f"{len(errors)} filing target(s) failed." if errors else None,
        results=tuple(results),
    )


def validate_generated_documents(root: Path) -> None:
    documents = sorted(root.rglob("*.json"))
    if not documents:
        raise ValueError("Pipeline produced no versioned JSON documents.")
    for path in documents:
        value = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(value, dict):
            raise ValueError(f"Generated document is not an object: {path}")
        validate_document(value)


def _company_statuses(run: RefreshRun) -> list[dict[str, str | None]]:
    output: list[dict[str, str | None]] = []
    for ticker in sorted({item.ticker for item in run.results}):
        items = [item for item in run.results if item.ticker == ticker]
        successful = [item for item in items if item.status != "failed"]
        failures = [item for item in items if item.status == "failed"]
        if failures:
            status = "failed"
            message = f"{len(failures)} filing check(s) failed; existing data was preserved."
        elif any(item.status == "imported" for item in items):
            status = "imported"
            message = "New validated SEC filing data was imported."
        else:
            status = "up_to_date"
            message = "Stored filings match the latest SEC submissions."
        latest = max(
            successful,
            key=lambda item: (item.filing_date or "", item.accession_number or ""),
            default=None,
        )
        output.append(
            {
                "ticker": ticker,
                "status": status,
                "message": message,
                "latest_accession": latest.accession_number if latest else None,
                "last_success_at": run.completed_at if not failures else None,
            }
        )
    return output


def render_refresh_status_sql(run: RefreshRun) -> str:
    statements = [
        "INSERT OR IGNORE INTO refresh_runs "
        "(run_id, trigger_type, status, started_at, completed_at, companies_checked, "
        "filings_discovered, filings_imported, error_count, error_summary) VALUES "
        f"({sql_value(run.run_id)}, {sql_value(run.trigger_type)}, {sql_value(run.status)}, "
        f"{sql_value(run.started_at)}, {sql_value(run.completed_at)}, "
        f"{run.companies_checked}, {run.filings_discovered}, {run.filings_imported}, "
        f"{run.error_count}, {sql_value(run.error_summary)});"
    ]
    for item in _company_statuses(run):
        statements.append(
            "INSERT INTO company_refresh_status "
            "(company_id, run_id, status, last_checked_at, last_success_at, "
            "latest_accession, message, updated_at) "
            f"SELECT id, {sql_value(run.run_id)}, {sql_value(item['status'])}, "
            f"{sql_value(run.completed_at)}, {sql_value(item['last_success_at'])}, "
            f"{sql_value(item['latest_accession'])}, {sql_value(item['message'])}, "
            f"{sql_value(run.completed_at)} FROM companies "
            f"WHERE ticker = {sql_value(item['ticker'])} "
            "ON CONFLICT(company_id) DO UPDATE SET "
            "run_id = excluded.run_id, status = excluded.status, "
            "last_checked_at = excluded.last_checked_at, "
            "last_success_at = COALESCE(excluded.last_success_at, company_refresh_status.last_success_at), "
            "latest_accession = COALESCE(excluded.latest_accession, company_refresh_status.latest_accession), "
            "message = excluded.message, updated_at = excluded.updated_at;"
        )
    for item in run.results:
        if item.status != "failed":
            continue
        statements.append(
            "INSERT INTO refresh_failures "
            "(run_id, ticker, form, stage, error_code, message, occurred_at) VALUES "
            f"({sql_value(run.run_id)}, {sql_value(item.ticker)}, {sql_value(item.form)}, "
            f"{sql_value(item.stage)}, {sql_value(item.error_code or 'UNKNOWN')}, "
            f"{sql_value(item.message[:1000])}, {sql_value(run.completed_at)});"
        )
    return "\n".join(statements) + "\n"


def render_import_sql(run: RefreshRun) -> str:
    roots = [Path(item.output_root) for item in run.results if item.output_root]
    seed_sql = ""
    if roots:
        documents = read_documents(roots)
        tickers = {item.ticker for item in run.results if item.output_root}
        seed_sql = render_sql(collect(documents, required_tickers=tickers))
    return seed_sql + render_refresh_status_sql(run)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ticker", action="append", choices=PILOT_TICKERS)
    parser.add_argument("--form", action="append", type=str.upper, choices=SUPPORTED_FORMS)
    parser.add_argument("--known-accessions", type=Path)
    parser.add_argument("--output-dir", type=Path, default=Path("work/refresh"))
    parser.add_argument("--sql-output", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--trigger-type", choices=("manual", "scheduled", "test"), default="manual")
    parser.add_argument("--user-agent", default=os.environ.get("SEC_USER_AGENT"))
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if not args.user_agent:
        print("SEC_USER_AGENT is required.", file=sys.stderr)
        return 2
    run = execute_refresh(
        SecClient(args.user_agent),
        tickers=args.ticker or PILOT_TICKERS,
        forms=args.form or SUPPORTED_FORMS,
        known_accessions=read_known_accessions(args.known_accessions),
        output_dir=args.output_dir,
        user_agent=args.user_agent,
        trigger_type=args.trigger_type,
    )
    args.sql_output.parent.mkdir(parents=True, exist_ok=True)
    args.sql_output.write_text(render_import_sql(run), encoding="utf-8")
    args.manifest.parent.mkdir(parents=True, exist_ok=True)
    args.manifest.write_text(json.dumps(asdict(run), indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: value for key, value in asdict(run).items() if key != "results"}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
