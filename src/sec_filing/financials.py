"""Extract traceable financial facts from the SEC Company Facts API."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Protocol

from .client import FilingMetadata, SecError
from .schema import (
    CompanyReference,
    EvidenceReference,
    FilingReference,
    write_document,
)


COMPANY_FACTS_URL = "https://data.sec.gov/api/xbrl/companyfacts/CIK{cik:010d}.json"
COMPANY_CONCEPT_URL = (
    "https://data.sec.gov/api/xbrl/companyconcept/"
    "CIK{cik:010d}/us-gaap/{concept}.json"
)


@dataclass(frozen=True)
class MetricSpec:
    key: str
    name: str
    concepts: tuple[str, ...]
    period_type: str


METRICS = (
    MetricSpec(
        "revenue",
        "Revenue",
        (
            "RevenueFromContractWithCustomerExcludingAssessedTax",
            "Revenues",
            "SalesRevenueNet",
            "SalesRevenueGoodsNet",
            "SalesRevenueServicesNet",
            "RegulatedAndUnregulatedOperatingRevenue",
            "OperatingRevenue",
        ),
        "duration",
    ),
    MetricSpec(
        "net_income",
        "Net income",
        ("NetIncomeLoss", "ProfitLoss"),
        "duration",
    ),
    MetricSpec("total_assets", "Total assets", ("Assets",), "instant"),
    MetricSpec("total_liabilities", "Total liabilities", ("Liabilities",), "instant"),
    MetricSpec(
        "operating_cash_flow",
        "Net cash provided by operating activities",
        ("NetCashProvidedByUsedInOperatingActivities",),
        "duration",
    ),
)


@dataclass(frozen=True)
class FinancialFact:
    evidence_id: str
    key: str
    name: str
    value: int | float
    formatted_value: str
    unit: str
    taxonomy: str
    concept: str
    sec_label: str
    period_type: str
    period_start: str | None
    period_end: str
    fiscal_year: int | None
    fiscal_period: str | None
    form: str
    filed: str
    accession_number: str
    filing_url: str
    filing_index_url: str
    sec_concept_url: str


@dataclass(frozen=True)
class FinancialExtraction:
    company_name: str
    ticker: str
    cik: str
    form: str
    report_date: str
    accession_number: str
    extracted_at: str
    source_api_url: str
    missing_metrics: tuple[str, ...]
    warnings: tuple[str, ...]
    facts: tuple[FinancialFact, ...]


@dataclass(frozen=True)
class QuarterMatch:
    accession_number: str
    current_fiscal_year: int
    previous_fiscal_year: int
    fiscal_period: str
    supporting_metrics: tuple[str, ...]


class JsonFetcher(Protocol):
    def __call__(self, url: str) -> dict[str, Any]: ...


def _format_usd(value: int | float) -> str:
    absolute = abs(value)
    if absolute >= 1_000_000_000:
        return f"${value / 1_000_000_000:,.2f} billion"
    if absolute >= 1_000_000:
        return f"${value / 1_000_000:,.2f} million"
    return f"${value:,.0f}"


def _choose_fact(
    entries: list[dict[str, Any]],
    metadata: FilingMetadata,
    period_type: str,
) -> dict[str, Any] | None:
    candidates = [
        entry
        for entry in entries
        if entry.get("accn") == metadata.accession_number
        and entry.get("form") == metadata.form
        and entry.get("end") == metadata.report_date
    ]
    if period_type == "duration":
        candidates = [entry for entry in candidates if entry.get("start")]
        fiscal_year_candidates = [entry for entry in candidates if entry.get("fp") == "FY"]
        candidates = fiscal_year_candidates or candidates
        if candidates:
            earliest_start = min(str(entry["start"]) for entry in candidates)
            candidates = [
                entry for entry in candidates if str(entry["start"]) == earliest_start
            ]
            candidates.sort(key=lambda entry: str(entry.get("filed", "")), reverse=True)
    else:
        candidates.sort(
            key=lambda entry: (
                not entry.get("start"),
                entry.get("fp") == "FY",
                str(entry.get("filed", "")),
            ),
            reverse=True,
        )
    if not candidates:
        return None
    # The SEC occasionally exposes duplicate contexts for one concept.  A
    # deterministic choice is safe only when the top context agrees on value;
    # conflicting values are rejected instead of guessed.
    best = candidates[0]
    peers = [
        item for item in candidates
        if item.get("start") == best.get("start")
        and item.get("end") == best.get("end")
        and item.get("fp") == best.get("fp")
    ]
    values = {item.get("val") for item in peers if isinstance(item.get("val"), (int, float))}
    return best if len(values) <= 1 else None


def fiscal_period_identity(financials: FinancialExtraction) -> tuple[int, str]:
    """Return one unambiguous fiscal year/period shared by duration facts."""

    identities = {
        (fact.fiscal_year, fact.fiscal_period)
        for fact in financials.facts
        if fact.period_type == "duration"
        and fact.fiscal_year is not None
        and fact.fiscal_period is not None
    }
    if len(identities) != 1:
        raise SecError(
            "SEC facts do not identify one unambiguous fiscal year and period."
        )
    fiscal_year, fiscal_period = identities.pop()
    return int(fiscal_year), str(fiscal_period)


def find_prior_year_filing(
    fetch_json: JsonFetcher,
    current: FinancialExtraction,
) -> QuarterMatch:
    """Find the prior-year accession with the same SEC fiscal-period focus."""

    if current.form not in {"10-K", "10-Q"}:
        raise SecError("Prior-year matching requires Form 10-K or 10-Q.")
    current_fiscal_year, fiscal_period = fiscal_period_identity(current)
    previous_fiscal_year = current_fiscal_year - 1
    company_facts = fetch_json(COMPANY_FACTS_URL.format(cik=int(current.cik)))
    us_gaap = company_facts.get("facts", {}).get("us-gaap", {})
    if not isinstance(us_gaap, dict):
        raise SecError("SEC Company Facts response does not contain us-gaap facts.")

    metric_votes: dict[str, set[str]] = {}
    for metric in METRICS:
        if metric.period_type != "duration":
            continue
        candidates: set[str] = set()
        for concept in metric.concepts:
            concept_data = us_gaap.get(concept)
            if not isinstance(concept_data, dict):
                continue
            entries = concept_data.get("units", {}).get("USD", [])
            if not isinstance(entries, list):
                continue
            for entry in entries:
                accession = entry.get("accn")
                if (
                    entry.get("form") == current.form
                    and entry.get("fy") == previous_fiscal_year
                    and entry.get("fp") == fiscal_period
                    and isinstance(accession, str)
                    and accession != current.accession_number
                    and str(entry.get("end", "")) < current.report_date
                ):
                    candidates.add(accession)
        for accession in candidates:
            metric_votes.setdefault(accession, set()).add(metric.key)

    if not metric_votes:
        raise SecError(
            f"No prior-year {fiscal_period} {current.form} evidence was found for "
            f"fiscal year {previous_fiscal_year}."
        )
    ranked = sorted(
        metric_votes.items(),
        key=lambda item: (len(item[1]), item[0]),
        reverse=True,
    )
    best_accession, supporting_metrics = ranked[0]
    best_score = len(supporting_metrics)
    available_current_duration_metrics = {
        fact.key for fact in current.facts if fact.period_type == "duration"
    }
    minimum_support = min(2, len(available_current_duration_metrics))
    if minimum_support == 0 or best_score < minimum_support:
        raise SecError(
            "Prior-year filing matching lacks sufficient independent duration evidence."
        )
    if len(ranked) > 1 and len(ranked[1][1]) == best_score:
        raise SecError("Prior-year quarter matching was ambiguous across SEC filings.")
    return QuarterMatch(
        accession_number=best_accession,
        current_fiscal_year=current_fiscal_year,
        previous_fiscal_year=previous_fiscal_year,
        fiscal_period=fiscal_period,
        supporting_metrics=tuple(sorted(supporting_metrics)),
    )


def find_prior_year_quarter(
    fetch_json: JsonFetcher,
    current: FinancialExtraction,
) -> QuarterMatch:
    """Backward-compatible same-fiscal-quarter matcher."""

    if current.form != "10-Q":
        raise SecError("Prior-year quarter matching requires a Form 10-Q.")
    return find_prior_year_filing(fetch_json, current)


def extract_financials(
    fetch_json: JsonFetcher,
    metadata: FilingMetadata,
    destination: Path,
) -> tuple[FinancialExtraction, Path]:
    """Extract five headline values for one exact filing and save them as JSON."""

    cik = int(metadata.cik)
    source_api_url = COMPANY_FACTS_URL.format(cik=cik)
    company_facts = fetch_json(source_api_url)
    us_gaap = company_facts.get("facts", {}).get("us-gaap", {})
    if not isinstance(us_gaap, dict):
        raise SecError("SEC Company Facts response does not contain us-gaap facts.")

    extracted: list[FinancialFact] = []
    missing: list[str] = []
    for metric in METRICS:
        selected_concept: str | None = None
        selected_data: dict[str, Any] | None = None
        selected_entry: dict[str, Any] | None = None

        for concept in metric.concepts:
            concept_data = us_gaap.get(concept)
            if not isinstance(concept_data, dict):
                continue
            usd_entries = concept_data.get("units", {}).get("USD", [])
            if not isinstance(usd_entries, list):
                continue
            entry = _choose_fact(usd_entries, metadata, metric.period_type)
            if entry is not None:
                selected_concept = concept
                selected_data = concept_data
                selected_entry = entry
                break

        if selected_concept is None or selected_data is None or selected_entry is None:
            missing.append(metric.name)
            continue

        value = selected_entry.get("val")
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            raise SecError(f"SEC returned a non-numeric value for {metric.name}.")

        extracted.append(
            FinancialFact(
                evidence_id=(
                    f"{metadata.ticker}-{metadata.accession_number}-{metric.key}"
                ),
                key=metric.key,
                name=metric.name,
                value=value,
                formatted_value=_format_usd(value),
                unit="USD",
                taxonomy="us-gaap",
                concept=selected_concept,
                sec_label=str(selected_data.get("label", metric.name)),
                period_type=metric.period_type,
                period_start=selected_entry.get("start"),
                period_end=str(selected_entry["end"]),
                fiscal_year=selected_entry.get("fy"),
                fiscal_period=selected_entry.get("fp"),
                form=str(selected_entry["form"]),
                filed=str(selected_entry.get("filed", metadata.filing_date)),
                accession_number=str(selected_entry["accn"]),
                filing_url=metadata.official_url,
                filing_index_url=metadata.filing_index_url,
                sec_concept_url=COMPANY_CONCEPT_URL.format(
                    cik=cik, concept=selected_concept
                ),
            )
        )

    if not extracted:
        raise SecError("The filing contained no supported, filing-matched SEC facts.")

    warnings = tuple(
        f"Unsupported or missing filing-matched fact: {name}."
        for name in missing
    )

    result = FinancialExtraction(
        company_name=metadata.company_name,
        ticker=metadata.ticker,
        cik=metadata.cik,
        form=metadata.form,
        report_date=metadata.report_date,
        accession_number=metadata.accession_number,
        extracted_at=datetime.now(UTC).isoformat(),
        source_api_url=source_api_url,
        missing_metrics=tuple(missing),
        warnings=warnings,
        facts=tuple(extracted),
    )
    output_path = destination / "financials.json"
    write_document(
        output_path,
        record_type="financial_facts",
        company=CompanyReference(
            cik=metadata.cik,
            ticker=metadata.ticker,
            name=metadata.company_name,
        ),
        filings=(
            FilingReference(
                accession_number=metadata.accession_number,
                form=metadata.form,
                filing_date=metadata.filing_date,
                report_date=metadata.report_date,
                official_url=metadata.official_url,
                filing_index_url=metadata.filing_index_url,
            ),
        ),
        evidence=tuple(
            EvidenceReference(
                evidence_id=fact.evidence_id,
                evidence_type="xbrl_fact",
                label=fact.name,
                accession_number=fact.accession_number,
                source_url=fact.sec_concept_url,
            )
            for fact in result.facts
        ),
        payload=result,
    )
    return result, output_path
