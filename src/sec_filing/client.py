"""Small, dependency-free client for public SEC EDGAR data."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
import json
from pathlib import Path
import time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"
SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK{cik:010d}.json"
ARCHIVES_URL = "https://www.sec.gov/Archives/edgar/data"


class SecError(RuntimeError):
    """Raised when EDGAR data cannot be retrieved or understood."""


@dataclass(frozen=True)
class FilingMetadata:
    company_name: str
    ticker: str
    cik: str
    form: str
    filing_date: str
    report_date: str
    accession_number: str
    primary_document: str
    official_url: str
    filing_index_url: str
    downloaded_at: str


Transport = Callable[[Request, float], bytes]


def _default_transport(request: Request, timeout: float) -> bytes:
    with urlopen(request, timeout=timeout) as response:  # noqa: S310 - fixed HTTPS hosts
        return response.read()


class SecClient:
    """Download company filings while following SEC fair-access conventions."""

    def __init__(
        self,
        user_agent: str,
        *,
        timeout: float = 30.0,
        min_request_interval: float = 0.12,
        transport: Transport | None = None,
    ) -> None:
        if not user_agent.strip() or "@" not in user_agent:
            raise ValueError(
                "SEC user agent must identify the app and include a contact email."
            )
        self.user_agent = user_agent.strip()
        self.timeout = timeout
        self.min_request_interval = min_request_interval
        self._transport = transport or _default_transport
        self._last_request_at = 0.0

    def _fetch_bytes(self, url: str) -> bytes:
        elapsed = time.monotonic() - self._last_request_at
        if elapsed < self.min_request_interval:
            time.sleep(self.min_request_interval - elapsed)

        request = Request(
            url,
            headers={
                "User-Agent": self.user_agent,
                "Accept-Encoding": "identity",
                "Accept": "application/json,text/html;q=0.9,*/*;q=0.8",
            },
        )
        try:
            result = self._transport(request, self.timeout)
        except HTTPError as exc:
            raise SecError(f"SEC returned HTTP {exc.code} for {url}") from exc
        except URLError as exc:
            raise SecError(f"Could not connect to the SEC for {url}: {exc.reason}") from exc
        finally:
            self._last_request_at = time.monotonic()
        return result

    def _fetch_json(self, url: str) -> dict[str, Any]:
        try:
            value = json.loads(self._fetch_bytes(url))
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise SecError(f"SEC returned invalid JSON for {url}") from exc
        if not isinstance(value, dict):
            raise SecError(f"SEC returned an unexpected JSON shape for {url}")
        return value

    def fetch_json(self, url: str) -> dict[str, Any]:
        """Fetch SEC JSON while preserving this client's headers and rate limit."""
        return self._fetch_json(url)

    def resolve_ticker(self, ticker: str) -> tuple[int, str]:
        wanted = ticker.strip().upper()
        if not wanted:
            raise ValueError("Ticker cannot be empty.")

        companies = self._fetch_json(TICKERS_URL)
        for company in companies.values():
            if str(company.get("ticker", "")).upper() == wanted:
                return int(company["cik_str"]), str(company["title"])
        raise SecError(f"Ticker {wanted!r} was not found in the SEC company list.")

    def latest_10k(self, cik: int) -> dict[str, str]:
        return self.recent_10ks(cik, limit=1)[0]

    def recent_10ks(self, cik: int, *, limit: int = 2) -> list[dict[str, str]]:
        if limit < 1:
            raise ValueError("Filing limit must be at least one.")
        submission = self._fetch_json(SUBMISSIONS_URL.format(cik=cik))
        recent = submission.get("filings", {}).get("recent", {})
        required = (
            "form",
            "filingDate",
            "reportDate",
            "accessionNumber",
            "primaryDocument",
        )
        if not all(isinstance(recent.get(key), list) for key in required):
            raise SecError("SEC submissions response is missing recent filing fields.")

        filings: list[dict[str, str]] = []
        for index, form in enumerate(recent["form"]):
            if form == "10-K":
                try:
                    filings.append({key: str(recent[key][index]) for key in required})
                except IndexError as exc:
                    raise SecError("SEC submissions response has inconsistent columns.") from exc
                if len(filings) == limit:
                    return filings
        if not filings:
            raise SecError("No 10-K filing was found for this company.")
        raise SecError(f"Only found {len(filings)} 10-K filing(s); {limit} required.")

    def download_latest_10k(self, ticker: str, output_dir: Path) -> tuple[FilingMetadata, Path]:
        return self.download_recent_10ks(ticker, output_dir, limit=1)[0]

    def download_recent_10ks(
        self,
        ticker: str,
        output_dir: Path,
        *,
        limit: int = 2,
    ) -> list[tuple[FilingMetadata, Path]]:
        normalized_ticker = ticker.strip().upper()
        cik, company_name = self.resolve_ticker(normalized_ticker)
        filings = self.recent_10ks(cik, limit=limit)
        return [
            self._download_10k_record(
                normalized_ticker,
                cik,
                company_name,
                filing,
                output_dir,
            )
            for filing in filings
        ]

    def _download_10k_record(
        self,
        normalized_ticker: str,
        cik: int,
        company_name: str,
        filing: dict[str, str],
        output_dir: Path,
    ) -> tuple[FilingMetadata, Path]:
        accession = filing["accessionNumber"]
        accession_compact = accession.replace("-", "")
        primary_document = Path(filing["primaryDocument"]).name
        if not primary_document:
            raise SecError("The filing does not name a primary document.")

        base_url = f"{ARCHIVES_URL}/{cik}/{accession_compact}"
        official_url = f"{base_url}/{primary_document}"
        filing_index_url = f"{base_url}/{accession}-index.html"
        html = self._fetch_bytes(official_url)

        destination = output_dir / normalized_ticker / accession
        destination.mkdir(parents=True, exist_ok=True)
        html_path = destination / "filing.html"
        html_path.write_bytes(html)

        metadata = FilingMetadata(
            company_name=company_name,
            ticker=normalized_ticker,
            cik=f"{cik:010d}",
            form="10-K",
            filing_date=filing["filingDate"],
            report_date=filing["reportDate"],
            accession_number=accession,
            primary_document=primary_document,
            official_url=official_url,
            filing_index_url=filing_index_url,
            downloaded_at=datetime.now(UTC).isoformat(),
        )
        metadata_path = destination / "metadata.json"
        metadata_path.write_text(
            json.dumps(asdict(metadata), indent=2) + "\n",
            encoding="utf-8",
        )
        return metadata, html_path
