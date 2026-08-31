"""Calculate financial ratios with links to their exact SEC input facts."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from .client import SecError
from .financials import FinancialExtraction, FinancialFact
from .schema import (
    CompanyReference,
    EvidenceReference,
    FilingReference,
    write_document,
)


@dataclass(frozen=True)
class RatioSpec:
    key: str
    name: str
    numerator_key: str
    denominator_key: str


RATIOS = (
    RatioSpec("net_margin", "Net margin", "net_income", "revenue"),
    RatioSpec(
        "operating_cash_flow_margin",
        "Operating cash-flow margin",
        "operating_cash_flow",
        "revenue",
    ),
    RatioSpec(
        "liabilities_to_assets",
        "Liabilities-to-assets",
        "total_liabilities",
        "total_assets",
    ),
)


@dataclass(frozen=True)
class RatioInput:
    evidence_id: str
    fact_key: str
    name: str
    value: int | float
    formatted_value: str
    unit: str
    accession_number: str
    filing_url: str
    sec_concept_url: str


@dataclass(frozen=True)
class FinancialRatio:
    evidence_id: str
    key: str
    name: str
    value: float
    percentage: float
    formatted_value: str
    formula: str
    calculation: str
    numerator_evidence_id: str
    denominator_evidence_id: str
    input_facts: tuple[RatioInput, RatioInput]


@dataclass(frozen=True)
class RatioExtraction:
    company_name: str
    ticker: str
    form: str
    report_date: str
    accession_number: str
    calculated_at: str
    ratios: tuple[FinancialRatio, ...]


def _ratio_input(fact: FinancialFact) -> RatioInput:
    return RatioInput(
        evidence_id=fact.evidence_id,
        fact_key=fact.key,
        name=fact.name,
        value=fact.value,
        formatted_value=fact.formatted_value,
        unit=fact.unit,
        accession_number=fact.accession_number,
        filing_url=fact.filing_url,
        sec_concept_url=fact.sec_concept_url,
    )


def calculate_ratios(
    financials: FinancialExtraction,
    destination: Path,
) -> tuple[RatioExtraction, Path]:
    """Calculate deterministic ratios and save their complete provenance."""

    facts_by_key = {fact.key: fact for fact in financials.facts}
    calculated: list[FinancialRatio] = []
    for spec in RATIOS:
        try:
            numerator = facts_by_key[spec.numerator_key]
            denominator = facts_by_key[spec.denominator_key]
        except KeyError as exc:
            raise SecError(
                f"Cannot calculate {spec.name}: required fact {exc.args[0]!r} is missing."
            ) from exc
        if denominator.value == 0:
            raise SecError(f"Cannot calculate {spec.name}: denominator is zero.")

        value = numerator.value / denominator.value
        percentage = round(value * 100, 2)
        calculated.append(
            FinancialRatio(
                evidence_id=(
                    f"{financials.ticker}-{financials.accession_number}-{spec.key}"
                ),
                key=spec.key,
                name=spec.name,
                value=round(value, 6),
                percentage=percentage,
                formatted_value=f"{percentage:.2f}%",
                formula=f"{spec.numerator_key} / {spec.denominator_key}",
                calculation=f"{numerator.value} / {denominator.value}",
                numerator_evidence_id=numerator.evidence_id,
                denominator_evidence_id=denominator.evidence_id,
                input_facts=(_ratio_input(numerator), _ratio_input(denominator)),
            )
        )

    result = RatioExtraction(
        company_name=financials.company_name,
        ticker=financials.ticker,
        form=financials.form,
        report_date=financials.report_date,
        accession_number=financials.accession_number,
        calculated_at=datetime.now(UTC).isoformat(),
        ratios=tuple(calculated),
    )
    output_path = destination / "ratios.json"
    first_fact = financials.facts[0]
    fact_evidence = [
        EvidenceReference(
            evidence_id=fact.evidence_id,
            evidence_type="xbrl_fact",
            label=fact.name,
            accession_number=fact.accession_number,
            source_url=fact.sec_concept_url,
        )
        for fact in financials.facts
    ]
    ratio_evidence = [
        EvidenceReference(
            evidence_id=ratio.evidence_id,
            evidence_type="derived_ratio",
            label=ratio.name,
            accession_number=financials.accession_number,
            source_url=None,
            source_evidence_ids=(
                ratio.numerator_evidence_id,
                ratio.denominator_evidence_id,
            ),
        )
        for ratio in result.ratios
    ]
    write_document(
        output_path,
        record_type="financial_ratios",
        company=CompanyReference(
            cik=financials.cik,
            ticker=financials.ticker,
            name=financials.company_name,
        ),
        filings=(
            FilingReference(
                accession_number=financials.accession_number,
                form=financials.form,
                filing_date=first_fact.filed,
                report_date=financials.report_date,
                official_url=first_fact.filing_url,
                filing_index_url=first_fact.filing_index_url,
            ),
        ),
        evidence=(*fact_evidence, *ratio_evidence),
        payload=result,
    )
    return result, output_path
