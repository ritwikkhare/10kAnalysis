"""Versioned JSON envelope and validation for SEC intelligence records."""

from __future__ import annotations

from dataclasses import asdict, dataclass
import json
from pathlib import Path
import re
from typing import Any, Iterable
from urllib.parse import urlparse


SCHEMA_VERSION = "1.0.0"
RECORD_TYPES = frozenset(
    {
        "filing_metadata",
        "financial_facts",
        "financial_ratios",
        "filing_comparison",
        "risk_passages",
        "risk_changes",
    }
)
EVIDENCE_TYPES = frozenset(
    {
        "filing_document",
        "filing_index",
        "xbrl_fact",
        "risk_passage",
        "derived_ratio",
        "derived_comparison",
        "derived_risk_change",
    }
)
ACCESSION_PATTERN = re.compile(r"^\d{10}-\d{2}-\d{6}$")
DATE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class SchemaValidationError(ValueError):
    """Raised before an invalid intelligence record can be written."""


@dataclass(frozen=True)
class CompanyReference:
    cik: str
    ticker: str
    name: str


@dataclass(frozen=True)
class FilingReference:
    accession_number: str
    form: str
    filing_date: str
    report_date: str
    official_url: str
    filing_index_url: str
    role: str = "primary"


@dataclass(frozen=True)
class EvidenceReference:
    evidence_id: str
    evidence_type: str
    label: str
    accession_number: str
    source_url: str | None
    source_evidence_ids: tuple[str, ...] = ()


def deduplicate_evidence(
    entries: Iterable[EvidenceReference],
) -> tuple[EvidenceReference, ...]:
    """Keep the first occurrence of identical evidence IDs."""

    unique: dict[str, EvidenceReference] = {}
    for entry in entries:
        existing = unique.get(entry.evidence_id)
        if existing is not None and existing != entry:
            raise SchemaValidationError(
                f"Evidence ID {entry.evidence_id!r} has conflicting definitions."
            )
        unique.setdefault(entry.evidence_id, entry)
    return tuple(unique.values())


def _is_sec_url(value: str) -> bool:
    parsed = urlparse(value)
    return parsed.scheme == "https" and parsed.hostname in {
        "www.sec.gov",
        "data.sec.gov",
    }


def validate_document(
    document: dict[str, Any],
    *,
    expected_record_type: str | None = None,
) -> None:
    """Validate the shared envelope and its complete evidence graph."""

    if document.get("schema_version") != SCHEMA_VERSION:
        raise SchemaValidationError(
            f"schema_version must be {SCHEMA_VERSION!r}."
        )
    record_type = document.get("record_type")
    if record_type not in RECORD_TYPES:
        raise SchemaValidationError(f"Unknown record_type {record_type!r}.")
    if expected_record_type is not None and record_type != expected_record_type:
        raise SchemaValidationError(
            f"Expected record_type {expected_record_type!r}, found {record_type!r}."
        )

    company = document.get("company")
    if not isinstance(company, dict):
        raise SchemaValidationError("company must be an object.")
    cik = company.get("cik")
    ticker = company.get("ticker")
    if not isinstance(cik, str) or len(cik) != 10 or not cik.isdigit():
        raise SchemaValidationError("company.cik must contain exactly 10 digits.")
    if not isinstance(ticker, str) or not ticker or ticker != ticker.upper():
        raise SchemaValidationError("company.ticker must be a non-empty uppercase string.")
    if not isinstance(company.get("name"), str) or not company["name"].strip():
        raise SchemaValidationError("company.name must be a non-empty string.")

    filings = document.get("filings")
    if not isinstance(filings, list) or not filings:
        raise SchemaValidationError("filings must contain at least one filing reference.")
    accessions: set[str] = set()
    roles: set[str] = set()
    for filing in filings:
        if not isinstance(filing, dict):
            raise SchemaValidationError("Each filing reference must be an object.")
        accession = filing.get("accession_number")
        if not isinstance(accession, str) or not ACCESSION_PATTERN.fullmatch(accession):
            raise SchemaValidationError(
                f"Invalid filing accession number {accession!r}."
            )
        if accession in accessions:
            raise SchemaValidationError(f"Duplicate filing accession {accession!r}.")
        accessions.add(accession)
        role = filing.get("role")
        if role not in {"primary", "comparison"} or role in roles:
            raise SchemaValidationError(f"Invalid or duplicate filing role {role!r}.")
        roles.add(role)
        if filing.get("form") not in {"10-K", "10-Q"}:
            raise SchemaValidationError(f"Unsupported filing form {filing.get('form')!r}.")
        for field in ("filing_date", "report_date"):
            value = filing.get(field)
            if not isinstance(value, str) or not DATE_PATTERN.fullmatch(value):
                raise SchemaValidationError(f"filing.{field} must use YYYY-MM-DD.")
        for field in ("official_url", "filing_index_url"):
            value = filing.get(field)
            if not isinstance(value, str) or not _is_sec_url(value):
                raise SchemaValidationError(f"filing.{field} must be an SEC HTTPS URL.")

    evidence = document.get("evidence")
    if not isinstance(evidence, list) or not evidence:
        raise SchemaValidationError("evidence must contain at least one reference.")
    evidence_ids: set[str] = set()
    for item in evidence:
        if not isinstance(item, dict):
            raise SchemaValidationError("Each evidence reference must be an object.")
        evidence_id = item.get("evidence_id")
        if not isinstance(evidence_id, str) or not evidence_id:
            raise SchemaValidationError("Every evidence reference needs an evidence_id.")
        if evidence_id in evidence_ids:
            raise SchemaValidationError(f"Duplicate evidence ID {evidence_id!r}.")
        evidence_ids.add(evidence_id)
        if item.get("evidence_type") not in EVIDENCE_TYPES:
            raise SchemaValidationError(
                f"Unknown evidence_type {item.get('evidence_type')!r}."
            )
        if item.get("accession_number") not in accessions:
            raise SchemaValidationError(
                f"Evidence {evidence_id!r} references an unknown filing accession."
            )
        source_url = item.get("source_url")
        source_ids = item.get("source_evidence_ids")
        if not isinstance(source_ids, (list, tuple)):
            raise SchemaValidationError("source_evidence_ids must be a list or tuple.")
        if source_url is not None and (
            not isinstance(source_url, str) or not _is_sec_url(source_url)
        ):
            raise SchemaValidationError(
                f"Evidence {evidence_id!r} must link to an official SEC HTTPS URL."
            )
        if source_url is None and not source_ids:
            raise SchemaValidationError(
                f"Derived evidence {evidence_id!r} must cite input evidence IDs."
            )

    for item in evidence:
        for source_id in item["source_evidence_ids"]:
            if source_id not in evidence_ids:
                raise SchemaValidationError(
                    f"Evidence {item['evidence_id']!r} cites missing input {source_id!r}."
                )


def build_document(
    *,
    record_type: str,
    company: CompanyReference,
    filings: Iterable[FilingReference],
    evidence: Iterable[EvidenceReference],
    payload: Any,
) -> dict[str, Any]:
    """Combine compatible domain data with the standard schema envelope."""

    if hasattr(payload, "__dataclass_fields__"):
        payload_data = asdict(payload)
    elif isinstance(payload, dict):
        payload_data = dict(payload)
    else:
        raise TypeError("Schema payload must be a dataclass or dictionary.")
    document = {
        "schema_version": SCHEMA_VERSION,
        "record_type": record_type,
        "company": asdict(company),
        "filings": [asdict(item) for item in filings],
        "evidence": [asdict(item) for item in deduplicate_evidence(evidence)],
        **payload_data,
    }
    validate_document(document, expected_record_type=record_type)
    return document


def write_document(
    path: Path,
    *,
    record_type: str,
    company: CompanyReference,
    filings: Iterable[FilingReference],
    evidence: Iterable[EvidenceReference],
    payload: Any,
) -> Path:
    """Validate and write one schema document as formatted JSON."""

    document = build_document(
        record_type=record_type,
        company=company,
        filings=filings,
        evidence=evidence,
        payload=payload,
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
    return path
