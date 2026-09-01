"""Download, validate, cache, and render the official SEC ticker directory for D1."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import UTC, datetime
import hashlib
import json
import os
from pathlib import Path
import re
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


SOURCE_URL = "https://www.sec.gov/files/company_tickers.json"
TICKER_PATTERN = re.compile(r"^[A-Z][A-Z0-9.-]{0,14}$")


class DirectoryError(RuntimeError):
    """Raised when the official SEC directory cannot be safely synchronized."""


@dataclass(frozen=True)
class DirectoryCompany:
    ticker: str
    cik: str
    name: str


@dataclass(frozen=True)
class FetchResult:
    status: int
    body: bytes | None
    etag: str | None
    last_modified: str | None


def validate_user_agent(value: str) -> str:
    user_agent = value.strip()
    if not user_agent or "@" not in user_agent or len(user_agent) > 200:
        raise ValueError(
            "SEC_USER_AGENT must identify the project and include a contact email."
        )
    return user_agent


def normalize_directory(
    payload: object, *, minimum_entries: int = 1
) -> list[DirectoryCompany]:
    if not isinstance(payload, dict):
        raise DirectoryError("SEC ticker directory must be a JSON object.")

    companies: list[DirectoryCompany] = []
    seen: set[str] = set()
    for key, raw in payload.items():
        if not isinstance(key, str) or not isinstance(raw, dict):
            raise DirectoryError("SEC ticker directory contains an invalid row.")
        ticker = str(raw.get("ticker", "")).strip().upper()
        name = " ".join(str(raw.get("title", "")).split())
        cik_value = raw.get("cik_str")
        if not TICKER_PATTERN.fullmatch(ticker):
            raise DirectoryError(f"SEC ticker row has an invalid ticker: {ticker!r}.")
        if ticker in seen:
            raise DirectoryError(f"SEC ticker directory contains duplicate ticker {ticker}.")
        if not name or len(name) > 500:
            raise DirectoryError(f"SEC ticker {ticker} has an invalid company name.")
        if isinstance(cik_value, bool):
            raise DirectoryError(f"SEC ticker {ticker} has an invalid CIK.")
        try:
            cik_number = int(cik_value)
        except (TypeError, ValueError) as exc:
            raise DirectoryError(f"SEC ticker {ticker} has an invalid CIK.") from exc
        if not 0 < cik_number <= 9_999_999_999:
            raise DirectoryError(f"SEC ticker {ticker} has an out-of-range CIK.")
        seen.add(ticker)
        companies.append(DirectoryCompany(ticker, f"{cik_number:010d}", name))

    if len(companies) < minimum_entries:
        raise DirectoryError(
            f"SEC ticker directory contains only {len(companies)} rows; "
            f"at least {minimum_entries} were required."
        )
    return sorted(companies, key=lambda company: company.ticker)


def fetch_directory(
    user_agent: str,
    *,
    etag: str | None = None,
    last_modified: str | None = None,
    timeout: float = 30.0,
) -> FetchResult:
    headers = {
        "User-Agent": validate_user_agent(user_agent),
        "Accept": "application/json",
        "Accept-Encoding": "identity",
    }
    if etag:
        headers["If-None-Match"] = etag
    if last_modified:
        headers["If-Modified-Since"] = last_modified
    request = Request(SOURCE_URL, headers=headers)
    try:
        with urlopen(request, timeout=timeout) as response:  # noqa: S310 - fixed SEC HTTPS URL
            return FetchResult(
                status=response.status,
                body=response.read(),
                etag=response.headers.get("ETag"),
                last_modified=response.headers.get("Last-Modified"),
            )
    except HTTPError as exc:
        if exc.code == 304:
            return FetchResult(304, None, etag, last_modified)
        raise DirectoryError(f"SEC returned HTTP {exc.code} for {SOURCE_URL}.") from exc
    except URLError as exc:
        raise DirectoryError(f"Could not reach the SEC ticker directory: {exc.reason}.") from exc


def sql_value(value: object) -> str:
    if value is None:
        return "NULL"
    return "'" + str(value).replace("'", "''") + "'"


def render_sql(
    companies: list[DirectoryCompany],
    *,
    fetched_at: str,
    sha256: str,
    etag: str | None,
    last_modified: str | None,
) -> str:
    rows = [
        "(" + ", ".join(
            sql_value(value)
            for value in (company.ticker, company.cik, company.name)
        ) + ")"
        for company in companies
    ]
    batch_size = 250
    inserts = "\n".join(
        "INSERT INTO sec_company_directory_import (ticker, cik, name) VALUES\n"
        + ",\n".join(rows[offset : offset + batch_size])
        + ";"
        for offset in range(0, len(rows), batch_size)
    )
    return f"""PRAGMA foreign_keys = ON;
DELETE FROM sec_company_directory_import;
{inserts}
INSERT INTO sec_company_directory
  (ticker, cik, name, source_url, source_fetched_at, updated_at)
SELECT ticker, cik, name, {sql_value(SOURCE_URL)}, {sql_value(fetched_at)}, CURRENT_TIMESTAMP
FROM sec_company_directory_import
WHERE 1
ON CONFLICT(ticker) DO UPDATE SET
  cik = excluded.cik,
  name = excluded.name,
  source_url = excluded.source_url,
  source_fetched_at = excluded.source_fetched_at,
  updated_at = CURRENT_TIMESTAMP;
DELETE FROM sec_company_directory
WHERE ticker NOT IN (SELECT ticker FROM sec_company_directory_import);
INSERT INTO sec_directory_sync
  (singleton_id, source_url, etag, last_modified, fetched_at, row_count, sha256)
VALUES
  (1, {sql_value(SOURCE_URL)}, {sql_value(etag)}, {sql_value(last_modified)},
   {sql_value(fetched_at)}, {len(companies)}, {sql_value(sha256)})
ON CONFLICT(singleton_id) DO UPDATE SET
  source_url = excluded.source_url,
  etag = excluded.etag,
  last_modified = excluded.last_modified,
  fetched_at = excluded.fetched_at,
  row_count = excluded.row_count,
  sha256 = excluded.sha256;
DELETE FROM sec_company_directory_import;
"""


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_text(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(value, encoding="utf-8", newline="\n")
    temporary.replace(path)


def synchronize(args: argparse.Namespace) -> dict[str, object]:
    user_agent = validate_user_agent(args.user_agent)
    cache_path = Path(args.cache_file)
    metadata_path = Path(args.metadata_file)
    metadata = read_json(metadata_path) if metadata_path.exists() else {}
    if not isinstance(metadata, dict):
        raise DirectoryError("Cached SEC directory metadata is invalid.")

    result = fetch_directory(
        user_agent,
        etag=None if args.force else metadata.get("etag"),
        last_modified=None if args.force else metadata.get("last_modified"),
        timeout=args.timeout,
    )
    if result.status == 304:
        if not cache_path.exists():
            raise DirectoryError("SEC returned not-modified but no cached directory exists.")
        body = cache_path.read_bytes()
        fetched_at = str(metadata.get("fetched_at", ""))
        if not fetched_at:
            raise DirectoryError("Cached SEC directory is missing its fetched timestamp.")
    else:
        if result.status != 200 or result.body is None:
            raise DirectoryError(f"Unexpected SEC directory response status {result.status}.")
        body = result.body
        fetched_at = datetime.now(UTC).isoformat()

    try:
        payload = json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise DirectoryError("SEC ticker directory is not valid UTF-8 JSON.") from exc
    companies = normalize_directory(payload, minimum_entries=args.minimum_entries)
    digest = hashlib.sha256(body).hexdigest()

    if result.status == 200:
        write_text(cache_path, body.decode("utf-8"))
        metadata = {
            "source_url": SOURCE_URL,
            "etag": result.etag,
            "last_modified": result.last_modified,
            "fetched_at": fetched_at,
            "row_count": len(companies),
            "sha256": digest,
        }
        write_text(metadata_path, json.dumps(metadata, indent=2) + "\n")

    sql = render_sql(
        companies,
        fetched_at=fetched_at,
        sha256=digest,
        etag=metadata.get("etag"),
        last_modified=metadata.get("last_modified"),
    )
    write_text(Path(args.sql_output), sql)
    return {
        "status": "downloaded" if result.status == 200 else "not_modified",
        "row_count": len(companies),
        "source_url": SOURCE_URL,
        "fetched_at": fetched_at,
        "sha256": digest,
        "sql_output": str(Path(args.sql_output).resolve()),
    }


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(description=__doc__)
    value.add_argument(
        "--user-agent",
        default=os.environ.get("SEC_USER_AGENT", ""),
        help="Project name and contact email; defaults to SEC_USER_AGENT.",
    )
    value.add_argument("--cache-file", default="data/sec/company_tickers.json")
    value.add_argument("--metadata-file", default="data/sec/company_tickers.metadata.json")
    value.add_argument("--sql-output", default="work/sec-directory/import.sql")
    value.add_argument("--minimum-entries", type=int, default=1_000)
    value.add_argument("--timeout", type=float, default=30.0)
    value.add_argument("--force", action="store_true")
    return value


def main() -> int:
    args = parser().parse_args()
    try:
        result = synchronize(args)
    except (DirectoryError, ValueError, OSError) as exc:
        raise SystemExit(f"SEC directory sync failed: {exc}") from exc
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
