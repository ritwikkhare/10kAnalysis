"""Build year-over-year comparisons with evidence from both SEC filings."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import UTC, datetime
import json
from pathlib import Path

from .client import SecError
from .financials import FinancialExtraction, FinancialFact
from .ratios import FinancialRatio, RatioExtraction, RatioInput


@dataclass(frozen=True)
class SourceFactLink:
    evidence_id: str
    name: str
    value: int | float
    formatted_value: str
    accession_number: str
    filing_url: str
    sec_concept_url: str


@dataclass(frozen=True)
class ComparisonSide:
    evidence_id: str
    accession_number: str
    report_date: str
    value: int | float
    formatted_value: str
    filing_url: str
    source_facts: tuple[SourceFactLink, ...]


@dataclass(frozen=True)
class FinancialChange:
    evidence_id: str
    key: str
    name: str
    comparison_type: str
    direction: str
    change_value: float
    formatted_change: str
    formula: str
    current: ComparisonSide
    previous: ComparisonSide


@dataclass(frozen=True)
class YearOverYearComparison:
    company_name: str
    ticker: str
    current_report_date: str
    previous_report_date: str
    current_accession_number: str
    previous_accession_number: str
    calculated_at: str
    changes: tuple[FinancialChange, ...]


def _source_from_fact(fact: FinancialFact) -> SourceFactLink:
    return SourceFactLink(
        evidence_id=fact.evidence_id,
        name=fact.name,
        value=fact.value,
        formatted_value=fact.formatted_value,
        accession_number=fact.accession_number,
        filing_url=fact.filing_url,
        sec_concept_url=fact.sec_concept_url,
    )


def _source_from_ratio_input(item: RatioInput) -> SourceFactLink:
    return SourceFactLink(
        evidence_id=item.evidence_id,
        name=item.name,
        value=item.value,
        formatted_value=item.formatted_value,
        accession_number=item.accession_number,
        filing_url=item.filing_url,
        sec_concept_url=item.sec_concept_url,
    )


def _direction(change: float) -> str:
    if change > 0:
        return "increased"
    if change < 0:
        return "decreased"
    return "unchanged"


def _fact_side(fact: FinancialFact, report_date: str) -> ComparisonSide:
    return ComparisonSide(
        evidence_id=fact.evidence_id,
        accession_number=fact.accession_number,
        report_date=report_date,
        value=fact.value,
        formatted_value=fact.formatted_value,
        filing_url=fact.filing_url,
        source_facts=(_source_from_fact(fact),),
    )


def _ratio_side(ratio: FinancialRatio, report_date: str) -> ComparisonSide:
    first_source = ratio.input_facts[0]
    return ComparisonSide(
        evidence_id=ratio.evidence_id,
        accession_number=first_source.accession_number,
        report_date=report_date,
        value=ratio.percentage,
        formatted_value=ratio.formatted_value,
        filing_url=first_source.filing_url,
        source_facts=tuple(_source_from_ratio_input(item) for item in ratio.input_facts),
    )


def compare_years(
    current_financials: FinancialExtraction,
    previous_financials: FinancialExtraction,
    current_ratios: RatioExtraction,
    previous_ratios: RatioExtraction,
    destination: Path,
) -> tuple[YearOverYearComparison, Path]:
    """Compare two annual filings and preserve both sides of every conclusion."""

    if current_financials.ticker != previous_financials.ticker:
        raise SecError("Cannot compare filings from different companies.")
    if current_financials.report_date <= previous_financials.report_date:
        raise SecError("Current filing must have a later report date than previous filing.")

    changes: list[FinancialChange] = []
    previous_facts = {fact.key: fact for fact in previous_financials.facts}
    for current in current_financials.facts:
        previous = previous_facts.get(current.key)
        if previous is None:
            raise SecError(f"Previous filing is missing required fact {current.key!r}.")
        if previous.value == 0:
            raise SecError(f"Cannot compare {current.name}: previous value is zero.")
        change = round(
            ((current.value - previous.value) / abs(previous.value)) * 100,
            2,
        )
        changes.append(
            FinancialChange(
                evidence_id=(
                    f"{current_financials.ticker}-"
                    f"{current_financials.accession_number}-vs-"
                    f"{previous_financials.accession_number}-{current.key}"
                ),
                key=current.key,
                name=current.name,
                comparison_type="percent_change",
                direction=_direction(change),
                change_value=change,
                formatted_change=f"{change:+.2f}%",
                formula="((current - previous) / abs(previous)) * 100",
                current=_fact_side(current, current_financials.report_date),
                previous=_fact_side(previous, previous_financials.report_date),
            )
        )

    previous_ratio_map = {ratio.key: ratio for ratio in previous_ratios.ratios}
    for current in current_ratios.ratios:
        previous = previous_ratio_map.get(current.key)
        if previous is None:
            raise SecError(f"Previous filing is missing required ratio {current.key!r}.")
        change = round(current.percentage - previous.percentage, 2)
        changes.append(
            FinancialChange(
                evidence_id=(
                    f"{current_financials.ticker}-"
                    f"{current_financials.accession_number}-vs-"
                    f"{previous_financials.accession_number}-{current.key}"
                ),
                key=current.key,
                name=current.name,
                comparison_type="percentage_point_change",
                direction=_direction(change),
                change_value=change,
                formatted_change=f"{change:+.2f} percentage points",
                formula="current percentage - previous percentage",
                current=_ratio_side(current, current_ratios.report_date),
                previous=_ratio_side(previous, previous_ratios.report_date),
            )
        )

    result = YearOverYearComparison(
        company_name=current_financials.company_name,
        ticker=current_financials.ticker,
        current_report_date=current_financials.report_date,
        previous_report_date=previous_financials.report_date,
        current_accession_number=current_financials.accession_number,
        previous_accession_number=previous_financials.accession_number,
        calculated_at=datetime.now(UTC).isoformat(),
        changes=tuple(changes),
    )
    destination.mkdir(parents=True, exist_ok=True)
    output_path = destination / "comparison.json"
    output_path.write_text(
        json.dumps(asdict(result), indent=2) + "\n",
        encoding="utf-8",
    )
    return result, output_path

