"""Process one queued SEC company and produce a validation-gated D1 import."""

from __future__ import annotations

import argparse
from dataclasses import asdict
from datetime import UTC, datetime
import json
from pathlib import Path
import re
import sys

from scripts.build_d1_seed import collect, read_documents, render_sql, sql_value
from scripts.refresh_filings import (
    DiscoveryClient,
    PipelineRunner,
    default_pipeline_runner,
    execute_refresh,
    read_known_accessions,
)
from sec_filing.client import SecClient


TICKER = re.compile(r"^[A-Z][A-Z0-9.-]{0,14}$")
JOB_ID = re.compile(r"^[0-9a-fA-F-]{36}$")


def utc_now() -> str:
    return datetime.now(UTC).isoformat()


def job_update_sql(
    job_id: str,
    *,
    status: str,
    message: str,
    error_code: str | None = None,
    failure_stage: str | None = None,
    diagnostic: str | None = None,
    timestamp: str | None = None,
) -> str:
    completed_at = timestamp or utc_now()
    statements: list[str] = []
    if diagnostic:
        statements.append(
            "INSERT INTO analysis_job_failures "
            "(job_id, stage, error_code, diagnostic_message, occurred_at) VALUES "
            f"({sql_value(job_id)}, {sql_value(failure_stage or 'processing')}, "
            f"{sql_value(error_code or 'UNKNOWN')}, {sql_value(diagnostic[:2000])}, "
            f"{sql_value(completed_at)});"
        )
    statements.append(
        "UPDATE analysis_jobs SET "
        f"status = {sql_value(status)}, completed_at = {sql_value(completed_at)}, "
        f"updated_at = {sql_value(completed_at)}, public_message = {sql_value(message)}, "
        f"error_code = {sql_value(error_code)}, failure_stage = {sql_value(failure_stage)} "
        f"WHERE job_id = {sql_value(job_id)} AND status = 'processing';"
    )
    return "\n".join(statements) + "\n"


def build_onboarding_import(
    *,
    job_id: str,
    ticker: str,
    expected_cik: str,
    known_accessions: set[str],
    output_dir: Path,
    user_agent: str,
    client: DiscoveryClient | None = None,
    pipeline_runner: PipelineRunner = default_pipeline_runner,
) -> tuple[dict[str, object], str, bool]:
    """Return a manifest, SQL, and success flag without publishing partial data."""

    client = client or SecClient(user_agent)
    try:
        cik, company_name = client.resolve_ticker(ticker)
    except Exception as exc:
        manifest = {
            "job_id": job_id,
            "ticker": ticker,
            "status": "unsupported",
            "message": "The ticker is not supported by the current SEC 10-K/10-Q pipeline.",
            "error": {"stage": "directory", "code": type(exc).__name__.upper(), "detail": str(exc)},
        }
        sql = job_update_sql(
            job_id,
            status="unsupported",
            message=str(manifest["message"]),
            error_code="UNSUPPORTED_COMPANY",
            failure_stage="directory",
            diagnostic=str(exc),
        )
        return manifest, sql, False

    resolved_cik = f"{cik:010d}"
    if resolved_cik != expected_cik:
        detail = f"Directory CIK mismatch: expected {expected_cik}, resolved {resolved_cik}."
        manifest = {
            "job_id": job_id,
            "ticker": ticker,
            "status": "failed",
            "message": "SEC identity validation failed; no filing data was published.",
            "error": {"stage": "identity", "code": "CIK_MISMATCH", "detail": detail},
        }
        return manifest, job_update_sql(
            job_id,
            status="failed",
            message=str(manifest["message"]),
            error_code="CIK_MISMATCH",
            failure_stage="identity",
            diagnostic=detail,
        ), False

    run = execute_refresh(
        client,
        tickers=(ticker,),
        forms=("10-K", "10-Q"),
        known_accessions=known_accessions,
        output_dir=output_dir,
        user_agent=user_agent,
        trigger_type="manual",
        run_id=job_id,
        pipeline_runner=pipeline_runner,
    )
    failures = [item for item in run.results if item.status == "failed"]
    unsupported = bool(failures) and all(item.stage == "discovery" for item in failures)
    if failures:
        status = "unsupported" if unsupported else "failed"
        code = "UNSUPPORTED_FORMS" if unsupported else "PIPELINE_FAILED"
        public_message = (
            "This SEC company does not currently provide the 10-K and 10-Q combination required by FilingLens."
            if unsupported
            else "Filing processing or evidence validation failed; no new company data was published."
        )
        diagnostic = "; ".join(
            f"{item.form}/{item.stage}/{item.error_code or 'UNKNOWN'}: {item.message}"
            for item in failures
        )
        manifest = {
            "job_id": job_id,
            "ticker": ticker,
            "company_name": company_name,
            "status": status,
            "message": public_message,
            "refresh": asdict(run),
        }
        return manifest, job_update_sql(
            job_id,
            status=status,
            message=public_message,
            error_code=code,
            failure_stage="processing",
            diagnostic=diagnostic,
            timestamp=run.completed_at,
        ), False

    roots = [Path(item.output_root) for item in run.results if item.output_root]
    if not roots:
        detail = "No new filing outputs were created for an unprocessed company."
        manifest = {
            "job_id": job_id,
            "ticker": ticker,
            "status": "failed",
            "message": "No validated filing data was available to publish.",
            "refresh": asdict(run),
        }
        return manifest, job_update_sql(
            job_id,
            status="failed",
            message=str(manifest["message"]),
            error_code="NO_OUTPUT",
            failure_stage="validation",
            diagnostic=detail,
            timestamp=run.completed_at,
        ), False

    # collect() re-validates the complete evidence graph. SQL is rendered only
    # after both filing targets and every schema/evidence edge pass.
    seed = collect(read_documents(roots), required_tickers={ticker})
    seed_sql = render_sql(seed)
    completed_sql = job_update_sql(
        job_id,
        status="completed",
        message="Analysis completed. The latest validated 10-K and 10-Q data are now available.",
        timestamp=run.completed_at,
    )
    manifest = {
        "job_id": job_id,
        "ticker": ticker,
        "company_name": company_name,
        "status": "completed",
        "message": "Validated company data is ready for idempotent import.",
        "refresh": asdict(run),
    }
    return manifest, seed_sql + completed_sql, True


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--ticker", required=True, type=str.upper)
    parser.add_argument("--cik", required=True)
    parser.add_argument("--known-accessions", type=Path)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--sql-output", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--user-agent", required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if not JOB_ID.fullmatch(args.job_id) or not TICKER.fullmatch(args.ticker) or not re.fullmatch(r"\d{10}", args.cik):
        print("Invalid job ID, ticker, or CIK.", file=sys.stderr)
        return 2
    try:
        manifest, sql, success = build_onboarding_import(
            job_id=args.job_id,
            ticker=args.ticker,
            expected_cik=args.cik,
            known_accessions=read_known_accessions(args.known_accessions),
            output_dir=args.output_dir,
            user_agent=args.user_agent,
        )
    except Exception as exc:  # always leave a diagnosable terminal job state
        manifest = {
            "job_id": args.job_id,
            "ticker": args.ticker,
            "status": "failed",
            "message": "An unexpected processing failure occurred; no new company data was published.",
            "error": {
                "stage": "runner",
                "code": type(exc).__name__.upper(),
                "detail": str(exc),
            },
        }
        sql = job_update_sql(
            args.job_id,
            status="failed",
            message=str(manifest["message"]),
            error_code="RUNNER_FAILED",
            failure_stage="runner",
            diagnostic=f"{type(exc).__name__}: {exc}",
        )
        success = False
    args.sql_output.parent.mkdir(parents=True, exist_ok=True)
    args.sql_output.write_text(sql, encoding="utf-8")
    args.manifest.parent.mkdir(parents=True, exist_ok=True)
    args.manifest.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: value for key, value in manifest.items() if key != "refresh"}, indent=2))
    return 0 if success else 1


if __name__ == "__main__":
    raise SystemExit(main())
