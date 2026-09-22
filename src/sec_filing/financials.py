"""Extract traceable financial facts from the SEC Company Facts API."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from html.parser import HTMLParser
from pathlib import Path
import re
from typing import Any, Protocol

from .client import FilingMetadata, SUBMISSIONS_URL, SecError
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
            "RevenuesNetOfInterestExpense",
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


@dataclass
class _InlineContext:
    cik: str | None = None
    start: str | None = None
    end: str | None = None
    dimensioned: bool = False


@dataclass
class _InlineFact:
    concept: str
    context_ref: str
    unit_ref: str
    scale: int
    sign: str
    element_id: str | None
    parts: list[str]


class _InlineXbrlParser(HTMLParser):
    """Collect the small inline-XBRL subset needed for a safe fallback."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.contexts: dict[str, _InlineContext] = {}
        self.facts: list[_InlineFact] = []
        self.document_fields: dict[str, str] = {}
        self._context_id: str | None = None
        self._context_field: str | None = None
        self._context_parts: list[str] = []
        self._fact: _InlineFact | None = None
        self._document_name: str | None = None
        self._document_parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        lowered = tag.lower()
        attributes = {key.lower(): value for key, value in attrs}
        if lowered == "xbrli:context":
            self._context_id = attributes.get("id")
            if self._context_id:
                self.contexts[self._context_id] = _InlineContext()
            return
        if self._context_id and lowered in {"xbrli:segment", "xbrli:scenario"}:
            self.contexts[self._context_id].dimensioned = True
        if self._context_id and lowered in {
            "xbrli:identifier", "xbrli:startdate", "xbrli:enddate", "xbrli:instant"
        }:
            self._context_field = lowered
            self._context_parts = []
            return
        if lowered == "ix:nonfraction":
            concept = attributes.get("name") or ""
            context_ref = attributes.get("contextref") or ""
            unit_ref = attributes.get("unitref") or ""
            try:
                scale = int(attributes.get("scale") or "0")
            except ValueError:
                scale = 0
            self._fact = _InlineFact(
                concept=concept,
                context_ref=context_ref,
                unit_ref=unit_ref,
                scale=scale,
                sign=attributes.get("sign") or "",
                element_id=attributes.get("id"),
                parts=[],
            )
            return
        if lowered == "ix:nonnumeric":
            name = attributes.get("name") or ""
            if name.lower() in {
                "dei:documentfiscalyearfocus", "dei:documentfiscalperiodfocus"
            }:
                self._document_name = name.lower()
                self._document_parts = []

    def handle_data(self, data: str) -> None:
        if self._context_field:
            self._context_parts.append(data)
        if self._fact:
            self._fact.parts.append(data)
        if self._document_name:
            self._document_parts.append(data)

    def handle_endtag(self, tag: str) -> None:
        lowered = tag.lower()
        if self._context_id and lowered == self._context_field:
            value = "".join(self._context_parts).strip()
            context = self.contexts[self._context_id]
            if lowered == "xbrli:identifier":
                context.cik = value.zfill(10)
            elif lowered == "xbrli:startdate":
                context.start = value
            else:
                context.end = value
            self._context_field = None
            self._context_parts = []
        if lowered == "xbrli:context":
            self._context_id = None
        if lowered == "ix:nonfraction" and self._fact:
            self.facts.append(self._fact)
            self._fact = None
        if lowered == "ix:nonnumeric" and self._document_name:
            self.document_fields[self._document_name] = "".join(
                self._document_parts
            ).strip()
            self._document_name = None
            self._document_parts = []


def _inline_amount(fact: _InlineFact) -> int | float | None:
    text = "".join(fact.parts).strip()
    if not text or text in {"—", "–", "-"}:
        return None
    negative = text.startswith("(") and text.endswith(")")
    normalized = re.sub(r"[^0-9.\-]", "", text)
    try:
        value = Decimal(normalized) * (Decimal(10) ** fact.scale)
    except (InvalidOperation, ValueError):
        return None
    if negative or fact.sign == "-":
        value = -abs(value)
    return int(value) if value == value.to_integral_value() else float(value)


def _inline_facts(
    html_path: Path,
    metadata: FilingMetadata,
) -> dict[str, list[dict[str, Any]]]:
    """Return consolidated filing facts when Company Facts omits an accession."""

    if not html_path.exists():
        return {}
    parser = _InlineXbrlParser()
    parser.feed(html_path.read_text(encoding="utf-8", errors="replace"))
    fiscal_year_text = parser.document_fields.get("dei:documentfiscalyearfocus")
    fiscal_period = parser.document_fields.get("dei:documentfiscalperiodfocus")
    try:
        fiscal_year = int(fiscal_year_text) if fiscal_year_text else None
    except ValueError:
        fiscal_year = None
    output: dict[str, list[dict[str, Any]]] = {}
    for fact in parser.facts:
        if not fact.concept.lower().startswith("us-gaap:"):
            continue
        if fact.unit_ref.lower() != "usd":
            continue
        context = parser.contexts.get(fact.context_ref)
        if (
            context is None
            or context.cik != metadata.cik
            or context.dimensioned
            or context.end != metadata.report_date
        ):
            continue
        value = _inline_amount(fact)
        if value is None:
            continue
        concept = fact.concept.split(":", 1)[1]
        source_url = (
            f"{metadata.official_url}#{fact.element_id}"
            if fact.element_id else metadata.official_url
        )
        output.setdefault(concept, []).append({
            "accn": metadata.accession_number,
            "form": metadata.form,
            "filed": metadata.filing_date,
            "start": context.start,
            "end": context.end,
            "fy": fiscal_year,
            "fp": fiscal_period,
            "val": value,
            "_source_url": source_url,
        })
    return output


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
        # Combined registrant filings can contain valid inline XBRL while the
        # SEC Company Facts endpoint has no rows for that accession. Select the
        # filing nearest the same report date one year earlier; the downloaded
        # inline facts are still required to prove the same FY/FP identity
        # before compare_years will accept the pair.
        submissions = fetch_json(SUBMISSIONS_URL.format(cik=int(current.cik)))
        recent = submissions.get("filings", {}).get("recent", {})
        required = ("form", "reportDate", "accessionNumber")
        if all(isinstance(recent.get(key), list) for key in required):
            current_date = date.fromisoformat(current.report_date)
            try:
                target = current_date.replace(year=current_date.year - 1)
            except ValueError:  # February 29 has no direct prior-year date.
                target = current_date.replace(year=current_date.year - 1, day=28)
            candidates: list[tuple[int, str]] = []
            for index, form in enumerate(recent["form"]):
                if form != current.form:
                    continue
                try:
                    accession = str(recent["accessionNumber"][index])
                    report_date = date.fromisoformat(str(recent["reportDate"][index]))
                except (IndexError, ValueError):
                    continue
                if accession == current.accession_number or report_date >= current_date:
                    continue
                distance = abs((report_date - target).days)
                if distance <= 45:
                    candidates.append((distance, accession))
            candidates.sort()
            if candidates and (len(candidates) == 1 or candidates[0][0] < candidates[1][0]):
                return QuarterMatch(
                    accession_number=candidates[0][1],
                    current_fiscal_year=current_fiscal_year,
                    previous_fiscal_year=previous_fiscal_year,
                    fiscal_period=fiscal_period,
                    supporting_metrics=("validated_report_date_fallback",),
                )
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
    inline_us_gaap = _inline_facts(destination / "filing.html", metadata)

    extracted: list[FinancialFact] = []
    missing: list[str] = []
    warnings: list[str] = []
    for metric in METRICS:
        selected_concept: str | None = None
        selected_data: dict[str, Any] | None = None
        selected_entry: dict[str, Any] | None = None

        for concept in metric.concepts:
            concept_data = us_gaap.get(concept)
            usd_entries = (
                concept_data.get("units", {}).get("USD", [])
                if isinstance(concept_data, dict) else []
            )
            entry = (
                _choose_fact(usd_entries, metadata, metric.period_type)
                if isinstance(usd_entries, list) else None
            )
            used_inline = False
            if entry is None:
                entry = _choose_fact(
                    inline_us_gaap.get(concept, []), metadata, metric.period_type
                )
                used_inline = entry is not None
            if entry is not None:
                selected_concept = concept
                selected_data = (
                    concept_data
                    if isinstance(concept_data, dict)
                    else {"label": metric.name}
                )
                selected_entry = entry
                if used_inline:
                    warnings.append(
                        f"Used filing-inline XBRL fallback for {metric.name}; "
                        "SEC Company Facts did not expose a matching accession fact."
                    )
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
                sec_concept_url=str(
                    selected_entry.get("_source_url")
                    or COMPANY_CONCEPT_URL.format(cik=cik, concept=selected_concept)
                ),
            )
        )

    if not extracted:
        raise SecError("The filing contained no supported, filing-matched SEC facts.")

    warnings.extend(
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
        warnings=tuple(warnings),
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
