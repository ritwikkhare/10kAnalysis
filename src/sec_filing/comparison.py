"""Build year-over-year comparisons with evidence from both SEC filings."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from .client import SecError
from .financials import FinancialExtraction, FinancialFact, fiscal_period_identity
from .ratios import FinancialRatio, RatioExtraction, RatioInput
from .schema import (
    CompanyReference,
    EvidenceReference,
    FilingReference,
    write_document,
)


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
    form: str
    comparison_basis: str
    fiscal_period: str
    calculated_at: str
    warnings: tuple[str, ...]
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
    """Compare matching prior-year filings and preserve every input citation."""

    if current_financials.ticker != previous_financials.ticker:
        raise SecError("Cannot compare filings from different companies.")
    if current_financials.form != previous_financials.form:
        raise SecError("Cannot compare different SEC filing forms.")
    if current_financials.report_date <= previous_financials.report_date:
        raise SecError("Current filing must have a later report date than previous filing.")
    current_fiscal_year, current_fiscal_period = fiscal_period_identity(
        current_financials
    )
    previous_fiscal_year, previous_fiscal_period = fiscal_period_identity(
        previous_financials
    )
    if current_fiscal_period != previous_fiscal_period:
        raise SecError(
            "Filings must have the same fiscal period focus for comparison."
        )
    if current_fiscal_year - previous_fiscal_year != 1:
        raise SecError("Filings must represent consecutive fiscal years.")
    comparison_basis = (
        "same_fiscal_quarter_prior_year"
        if current_financials.form == "10-Q"
        else "consecutive_fiscal_years"
    )

    changes: list[FinancialChange] = []
    warnings: list[str] = []
    previous_facts = {fact.key: fact for fact in previous_financials.facts}
    for current in current_financials.facts:
        previous = previous_facts.get(current.key)
        if previous is None:
            warnings.append(
                f"Skipped {current.name}: the prior-year filing lacks {current.key}."
            )
            continue
        if previous.value == 0:
            warnings.append(
                f"Skipped {current.name}: the prior-year value is zero."
            )
            continue
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
            warnings.append(
                f"Skipped {current.name}: the prior-year ratio is unavailable."
            )
            continue
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

    if not changes:
        raise SecError("No safely comparable facts or ratios were available.")

    result = YearOverYearComparison(
        company_name=current_financials.company_name,
        ticker=current_financials.ticker,
        current_report_date=current_financials.report_date,
        previous_report_date=previous_financials.report_date,
        current_accession_number=current_financials.accession_number,
        previous_accession_number=previous_financials.accession_number,
        form=current_financials.form,
        comparison_basis=comparison_basis,
        fiscal_period=current_fiscal_period,
        calculated_at=datetime.now(UTC).isoformat(),
        warnings=tuple(warnings),
        changes=tuple(changes),
    )
    output_path = destination / "comparison.json"
    all_facts = (*current_financials.facts, *previous_financials.facts)
    fact_evidence = [
        EvidenceReference(
            evidence_id=fact.evidence_id,
            evidence_type="xbrl_fact",
            label=fact.name,
            accession_number=fact.accession_number,
            source_url=fact.sec_concept_url,
        )
        for fact in all_facts
    ]
    all_ratios = (*current_ratios.ratios, *previous_ratios.ratios)
    ratio_evidence = [
        EvidenceReference(
            evidence_id=ratio.evidence_id,
            evidence_type="derived_ratio",
            label=ratio.name,
            accession_number=ratio.input_facts[0].accession_number,
            source_url=None,
            source_evidence_ids=(
                ratio.numerator_evidence_id,
                ratio.denominator_evidence_id,
            ),
        )
        for ratio in all_ratios
    ]
    comparison_evidence = [
        EvidenceReference(
            evidence_id=change.evidence_id,
            evidence_type="derived_comparison",
            label=change.name,
            accession_number=current_financials.accession_number,
            source_url=None,
            source_evidence_ids=(
                change.current.evidence_id,
                change.previous.evidence_id,
            ),
        )
        for change in result.changes
    ]
    current_first = current_financials.facts[0]
    previous_first = previous_financials.facts[0]
    write_document(
        output_path,
        record_type="filing_comparison",
        company=CompanyReference(
            cik=current_financials.cik,
            ticker=current_financials.ticker,
            name=current_financials.company_name,
        ),
        filings=(
            FilingReference(
                accession_number=current_financials.accession_number,
                form=current_financials.form,
                filing_date=current_first.filed,
                report_date=current_financials.report_date,
                official_url=current_first.filing_url,
                filing_index_url=current_first.filing_index_url,
            ),
            FilingReference(
                accession_number=previous_financials.accession_number,
                form=previous_financials.form,
                filing_date=previous_first.filed,
                report_date=previous_financials.report_date,
                official_url=previous_first.filing_url,
                filing_index_url=previous_first.filing_index_url,
                role="comparison",
            ),
        ),
        evidence=(*fact_evidence, *ratio_evidence, *comparison_evidence),
        payload=result,
    )
    return result, output_path
