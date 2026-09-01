"""Convert validated SEC intelligence JSON files into deterministic D1 seed SQL."""

from __future__ import annotations

import argparse
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import UTC, datetime
import json
from pathlib import Path
import re
from typing import Any, Iterable
from urllib.parse import urlparse


SCHEMA_VERSION = "1.0.0"
ACCESSION = re.compile(r"^\d{10}-\d{2}-\d{6}$")
PILOT_TICKERS = frozenset({"AAPL", "MSFT", "NVDA", "TSLA"})


def sec_url(value: str | None) -> str | None:
    if value is None:
        return None
    parsed = urlparse(value)
    if parsed.scheme != "https" or parsed.hostname not in {"www.sec.gov", "data.sec.gov"}:
        raise ValueError(f"Not an official SEC HTTPS URL: {value}")
    return value


def sql_value(value: Any) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, (int, float)):
        return repr(value)
    return "'" + str(value).replace("'", "''") + "'"


def insert(table: str, columns: Iterable[str], values: Iterable[Any]) -> str:
    column_list = tuple(columns)
    value_list = tuple(values)
    return (
        f"INSERT OR IGNORE INTO {table} ({', '.join(column_list)}) VALUES "
        f"({', '.join(sql_value(value) for value in value_list)});"
    )


@dataclass
class SeedData:
    companies: dict[str, dict[str, Any]] = field(default_factory=dict)
    filings: dict[str, dict[str, Any]] = field(default_factory=dict)
    evidence: dict[str, dict[str, Any]] = field(default_factory=dict)
    evidence_sources: set[tuple[str, str]] = field(default_factory=set)
    facts: dict[str, dict[str, Any]] = field(default_factory=dict)
    ratios: dict[str, dict[str, Any]] = field(default_factory=dict)
    comparisons: dict[str, dict[str, Any]] = field(default_factory=dict)
    comparison_changes: dict[str, dict[str, Any]] = field(default_factory=dict)
    risk_passages: dict[str, dict[str, Any]] = field(default_factory=dict)
    risk_comparisons: dict[str, dict[str, Any]] = field(default_factory=dict)
    risk_changes: dict[str, dict[str, Any]] = field(default_factory=dict)

    def add_evidence(
        self,
        evidence_id: str,
        evidence_type: str,
        label: str,
        accession_number: str,
        source_url: str | None,
        source_ids: Iterable[str] = (),
    ) -> None:
        if not evidence_id:
            raise ValueError("Evidence ID cannot be empty.")
        if not ACCESSION.fullmatch(accession_number):
            raise ValueError(f"Invalid accession number: {accession_number}")
        record = {
            "evidence_id": evidence_id,
            "schema_version": SCHEMA_VERSION,
            "evidence_type": evidence_type,
            "label": label,
            "filing_accession": accession_number,
            "source_url": sec_url(source_url),
        }
        existing = self.evidence.get(evidence_id)
        if existing is not None and existing != record:
            raise ValueError(f"Conflicting evidence definition: {evidence_id}")
        self.evidence[evidence_id] = record
        for source_id in source_ids:
            self.evidence_sources.add((evidence_id, source_id))


def read_documents(roots: list[Path]) -> list[tuple[Path, dict[str, Any]]]:
    documents: list[tuple[Path, dict[str, Any]]] = []
    seen: set[Path] = set()
    for root in roots:
        if not root.exists():
            continue
        for path in sorted(root.rglob("*.json")):
            resolved = path.resolve()
            if resolved in seen:
                continue
            seen.add(resolved)
            document = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(document, dict):
                documents.append((path, document))
    return documents


def index_metadata(documents: list[tuple[Path, dict[str, Any]]]) -> dict[str, dict[str, Any]]:
    metadata: dict[str, dict[str, Any]] = {}
    for path, document in documents:
        if path.name != "metadata.json":
            continue
        accession = document.get("accession_number")
        if isinstance(accession, str):
            metadata[accession] = document
    return metadata


def filing_from_reference(reference: dict[str, Any], company: dict[str, Any], metadata: dict[str, dict[str, Any]]) -> dict[str, Any]:
    accession = str(reference["accession_number"])
    stored = metadata.get(accession, {})
    return {
        "accession_number": accession,
        "ticker": company["ticker"],
        "schema_version": SCHEMA_VERSION,
        "form": reference.get("form") or stored.get("form"),
        "filing_date": reference.get("filing_date") or stored.get("filing_date"),
        "report_date": reference.get("report_date") or stored.get("report_date"),
        "primary_document": stored.get("primary_document"),
        "official_url": sec_url(reference.get("official_url") or stored.get("official_url")),
        "filing_index_url": sec_url(reference.get("filing_index_url") or stored.get("filing_index_url")),
        "downloaded_at": stored.get("downloaded_at"),
    }


def collect(
    documents: list[tuple[Path, dict[str, Any]]],
    *,
    required_tickers: frozenset[str] | set[str] | None = PILOT_TICKERS,
) -> SeedData:
    data = SeedData()
    metadata = index_metadata(documents)

    for _, document in documents:
        company = document.get("company")
        if not isinstance(company, dict):
            accession = document.get("accession_number") or document.get("current_accession_number")
            stored = metadata.get(str(accession), {})
            company = stored.get("company") or {
                "cik": stored.get("cik"),
                "ticker": document.get("ticker") or stored.get("ticker"),
                "name": document.get("company_name") or stored.get("company_name"),
            }
        if not all(isinstance(company.get(key), str) and company[key] for key in ("cik", "ticker", "name")):
            continue
        ticker = str(company["ticker"]).upper()
        normalized_company = {"cik": str(company["cik"]), "ticker": ticker, "name": str(company["name"])}
        data.companies[ticker] = normalized_company

        references = document.get("filings")
        if isinstance(references, list):
            for reference in references:
                if isinstance(reference, dict):
                    filing = filing_from_reference(reference, normalized_company, metadata)
                    data.filings[filing["accession_number"]] = filing
        elif document.get("accession_number"):
            accession = str(document["accession_number"])
            stored = metadata.get(accession, document)
            reference = {
                "accession_number": accession,
                "form": document.get("form") or stored.get("form"),
                "filing_date": document.get("filing_date") or stored.get("filing_date"),
                "report_date": document.get("report_date") or stored.get("report_date"),
                "official_url": document.get("official_url") or document.get("filing_url") or stored.get("official_url"),
                "filing_index_url": document.get("filing_index_url") or stored.get("filing_index_url"),
            }
            filing = filing_from_reference(reference, normalized_company, metadata)
            data.filings[accession] = filing

        for evidence in document.get("evidence", []):
            if isinstance(evidence, dict):
                data.add_evidence(
                    str(evidence["evidence_id"]),
                    str(evidence["evidence_type"]),
                    str(evidence["label"]),
                    str(evidence["accession_number"]),
                    evidence.get("source_url"),
                    evidence.get("source_evidence_ids", []),
                )

        record_type = document.get("record_type")
        if record_type == "financial_facts" or document.get("facts"):
            collect_facts(data, document)
        if record_type == "financial_ratios" or document.get("ratios"):
            collect_ratios(data, document)
        if record_type == "filing_comparison" or (document.get("changes") and document.get("comparison_basis")):
            collect_comparison(data, document)
        if record_type == "risk_passages" or document.get("passages"):
            collect_risk_passages(data, document)
        if record_type == "risk_changes" or (document.get("changes") and document.get("methodology")):
            collect_risk_changes(data, document)

    validate_graph(data, required_tickers=required_tickers)
    return data


def collect_facts(data: SeedData, document: dict[str, Any]) -> None:
    for fact in document.get("facts", []):
        evidence_id = str(fact["evidence_id"])
        data.facts[evidence_id] = dict(fact)
        if evidence_id not in data.evidence:
            data.add_evidence(evidence_id, "xbrl_fact", str(fact["name"]), str(fact["accession_number"]), fact.get("sec_concept_url"))


def collect_ratios(data: SeedData, document: dict[str, Any]) -> None:
    accession = str(document["accession_number"])
    for ratio in document.get("ratios", []):
        evidence_id = str(ratio["evidence_id"])
        data.ratios[evidence_id] = {**ratio, "accession_number": accession}
        if evidence_id not in data.evidence:
            data.add_evidence(
                evidence_id,
                "derived_ratio",
                str(ratio["name"]),
                accession,
                None,
                (str(ratio["numerator_evidence_id"]), str(ratio["denominator_evidence_id"])),
            )


def collect_comparison(data: SeedData, document: dict[str, Any]) -> None:
    current = str(document["current_accession_number"])
    previous = str(document["previous_accession_number"])
    comparison_id = f"{document['ticker']}-{current}-vs-{previous}"
    data.comparisons[comparison_id] = {**document, "comparison_id": comparison_id}
    for change in document.get("changes", []):
        evidence_id = str(change["evidence_id"])
        data.comparison_changes[evidence_id] = {**change, "comparison_id": comparison_id}
        if evidence_id not in data.evidence:
            data.add_evidence(
                evidence_id,
                "derived_comparison",
                str(change["name"]),
                current,
                None,
                (str(change["current"]["evidence_id"]), str(change["previous"]["evidence_id"])),
            )


def add_passage(data: SeedData, passage: dict[str, Any], section: str = "Item 1A. Risk Factors") -> None:
    evidence_id = str(passage["evidence_id"])
    data.risk_passages[evidence_id] = {**passage, "section": section}
    if evidence_id not in data.evidence:
        data.add_evidence(
            evidence_id,
            "risk_passage",
            f"Item 1A passage {passage['passage_number']}",
            str(passage["accession_number"]),
            passage.get("source_url") or passage.get("filing_url"),
        )


def collect_risk_passages(data: SeedData, document: dict[str, Any]) -> None:
    section = str(document.get("section", "Item 1A. Risk Factors"))
    for passage in document.get("passages", []):
        add_passage(data, passage, section)


def collect_risk_changes(data: SeedData, document: dict[str, Any]) -> None:
    current = str(document["current_accession_number"])
    previous = str(document["previous_accession_number"])
    comparison_id = f"{document['ticker']}-{current}-risk-vs-{previous}"
    data.risk_comparisons[comparison_id] = {**document, "comparison_id": comparison_id}
    for change in document.get("changes", []):
        current_passage = change.get("current")
        previous_passage = change.get("previous")
        if isinstance(current_passage, dict):
            add_passage(data, current_passage)
        if isinstance(previous_passage, dict):
            add_passage(data, previous_passage)
        evidence_id = str(change["evidence_id"])
        source_ids = tuple(
            str(item["evidence_id"])
            for item in (current_passage, previous_passage)
            if isinstance(item, dict)
        )
        data.risk_changes[evidence_id] = {
            **change,
            "comparison_id": comparison_id,
            "current_passage_id": current_passage.get("evidence_id") if isinstance(current_passage, dict) else None,
            "previous_passage_id": previous_passage.get("evidence_id") if isinstance(previous_passage, dict) else None,
        }
        if evidence_id not in data.evidence:
            data.add_evidence(evidence_id, "derived_risk_change", str(change["change_type"]).replace("_", " ").title(), current, None, source_ids)


def validate_graph(
    data: SeedData,
    *,
    required_tickers: frozenset[str] | set[str] | None = PILOT_TICKERS,
) -> None:
    if required_tickers is not None and set(data.companies) != set(required_tickers):
        raise ValueError(
            f"Expected companies {sorted(required_tickers)}; "
            f"found {sorted(data.companies)}"
        )
    for filing in data.filings.values():
        for field in ("form", "filing_date", "report_date", "official_url", "filing_index_url"):
            if not filing.get(field):
                raise ValueError(f"Filing {filing['accession_number']} is missing {field}.")
    for evidence_id, evidence in data.evidence.items():
        if evidence["filing_accession"] not in data.filings:
            raise ValueError(f"Evidence {evidence_id} cites an unimported filing.")
        if evidence["source_url"] is None and not any(item[0] == evidence_id for item in data.evidence_sources):
            raise ValueError(f"Derived evidence {evidence_id} has no source facts.")
    for evidence_id, source_id in data.evidence_sources:
        if source_id not in data.evidence:
            raise ValueError(f"Evidence {evidence_id} cites missing evidence {source_id}.")


def render_sql(data: SeedData) -> str:
    statements = ["PRAGMA foreign_keys = ON;"]
    for ticker, company in sorted(data.companies.items()):
        statements.append(insert("companies", ("schema_version", "cik", "ticker", "name"), (SCHEMA_VERSION, company["cik"], ticker, company["name"])))
    for accession, filing in sorted(data.filings.items()):
        statements.append(
            "INSERT OR IGNORE INTO filings (accession_number, company_id, schema_version, form, filing_date, report_date, primary_document, official_url, filing_index_url, downloaded_at) "
            f"SELECT {sql_value(accession)}, id, {sql_value(SCHEMA_VERSION)}, {sql_value(filing['form'])}, {sql_value(filing['filing_date'])}, {sql_value(filing['report_date'])}, {sql_value(filing['primary_document'])}, {sql_value(filing['official_url'])}, {sql_value(filing['filing_index_url'])}, {sql_value(filing['downloaded_at'])} FROM companies WHERE ticker = {sql_value(filing['ticker'])};"
        )
    for item in sorted(data.evidence.values(), key=lambda row: row["evidence_id"]):
        statements.append(insert("evidence_links", item.keys(), item.values()))
    for fact in sorted(data.facts.values(), key=lambda row: row["evidence_id"]):
        columns = ("evidence_id", "filing_accession", "fact_key", "name", "value", "formatted_value", "unit", "taxonomy", "concept", "sec_label", "period_type", "period_start", "period_end", "fiscal_year", "fiscal_period", "filed", "sec_concept_url")
        values = (fact["evidence_id"], fact["accession_number"], fact["key"], fact["name"], fact["value"], fact["formatted_value"], fact["unit"], fact["taxonomy"], fact["concept"], fact["sec_label"], fact["period_type"], fact.get("period_start"), fact["period_end"], fact.get("fiscal_year"), fact.get("fiscal_period"), fact["filed"], sec_url(fact["sec_concept_url"]))
        statements.append(insert("financial_facts", columns, values))
    for ratio in sorted(data.ratios.values(), key=lambda row: row["evidence_id"]):
        columns = ("evidence_id", "filing_accession", "ratio_key", "name", "value", "percentage", "formatted_value", "formula", "calculation", "numerator_evidence_id", "denominator_evidence_id")
        values = (ratio["evidence_id"], ratio["accession_number"], ratio["key"], ratio["name"], ratio["value"], ratio["percentage"], ratio["formatted_value"], ratio["formula"], ratio["calculation"], ratio["numerator_evidence_id"], ratio["denominator_evidence_id"])
        statements.append(insert("ratios", columns, values))
    for item in sorted(data.comparisons.values(), key=lambda row: row["comparison_id"]):
        statements.append(
            "INSERT OR IGNORE INTO filing_comparisons (comparison_id, company_id, schema_version, current_accession, previous_accession, form, comparison_basis, fiscal_period, calculated_at, warnings_json) "
            f"SELECT {sql_value(item['comparison_id'])}, id, {sql_value(SCHEMA_VERSION)}, {sql_value(item['current_accession_number'])}, {sql_value(item['previous_accession_number'])}, {sql_value(item['form'])}, {sql_value(item['comparison_basis'])}, {sql_value(item.get('fiscal_period'))}, {sql_value(item['calculated_at'])}, {sql_value(json.dumps(item.get('warnings', [])))} FROM companies WHERE ticker = {sql_value(item['ticker'])};"
        )
    for change in sorted(data.comparison_changes.values(), key=lambda row: row["evidence_id"]):
        columns = ("evidence_id", "comparison_id", "change_key", "name", "comparison_type", "direction", "change_value", "formatted_change", "formula", "current_evidence_id", "previous_evidence_id")
        values = (change["evidence_id"], change["comparison_id"], change["key"], change["name"], change["comparison_type"], change["direction"], change["change_value"], change["formatted_change"], change["formula"], change["current"]["evidence_id"], change["previous"]["evidence_id"])
        statements.append(insert("comparison_changes", columns, values))
    for passage in sorted(data.risk_passages.values(), key=lambda row: row["evidence_id"]):
        columns = ("evidence_id", "filing_accession", "passage_number", "section", "text", "report_date", "anchor", "source_url")
        values = (passage["evidence_id"], passage["accession_number"], passage["passage_number"], passage["section"], passage["text"], passage["report_date"], passage.get("anchor"), sec_url(passage.get("source_url") or passage["filing_url"]))
        statements.append(insert("risk_passages", columns, values))
    for item in sorted(data.risk_comparisons.values(), key=lambda row: row["comparison_id"]):
        statements.append(
            "INSERT OR IGNORE INTO risk_comparisons (comparison_id, company_id, schema_version, current_accession, previous_accession, compared_at, methodology, added_count, removed_count, materially_changed_count) "
            f"SELECT {sql_value(item['comparison_id'])}, id, {sql_value(SCHEMA_VERSION)}, {sql_value(item['current_accession_number'])}, {sql_value(item['previous_accession_number'])}, {sql_value(item['compared_at'])}, {sql_value(item['methodology'])}, {sql_value(item['added_count'])}, {sql_value(item['removed_count'])}, {sql_value(item['materially_changed_count'])} FROM companies WHERE ticker = {sql_value(item['ticker'])};"
        )
    for change in sorted(data.risk_changes.values(), key=lambda row: row["evidence_id"]):
        columns = ("evidence_id", "comparison_id", "change_type", "similarity", "current_passage_id", "previous_passage_id")
        values = (change["evidence_id"], change["comparison_id"], change["change_type"], change.get("similarity"), change.get("current_passage_id"), change.get("previous_passage_id"))
        statements.append(insert("risk_changes", columns, values))
    for evidence_id, source_id in sorted(data.evidence_sources):
        statements.append(insert("evidence_sources", ("evidence_id", "source_evidence_id"), (evidence_id, source_id)))
    return "\n".join(statements) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", action="append", type=Path, required=True, help="Processed filing-data root; repeat as needed.")
    parser.add_argument("--output", type=Path, required=True, help="Destination SQL file.")
    parser.add_argument("--manifest", type=Path, help="Optional JSON import manifest.")
    args = parser.parse_args()

    documents = read_documents(args.input)
    data = collect(documents)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(render_sql(data), encoding="utf-8")
    counts = {
        "companies": len(data.companies),
        "filings": len(data.filings),
        "financial_facts": len(data.facts),
        "ratios": len(data.ratios),
        "comparisons": len(data.comparisons),
        "comparison_changes": len(data.comparison_changes),
        "risk_passages": len(data.risk_passages),
        "risk_comparisons": len(data.risk_comparisons),
        "risk_changes": len(data.risk_changes),
        "evidence_links": len(data.evidence),
        "evidence_sources": len(data.evidence_sources),
    }
    if args.manifest:
        args.manifest.parent.mkdir(parents=True, exist_ok=True)
        args.manifest.write_text(
            json.dumps({"schema_version": SCHEMA_VERSION, "generated_at": datetime.now(UTC).isoformat(), "inputs": [str(path) for path in args.input], "counts": counts}, indent=2) + "\n",
            encoding="utf-8",
        )
    print(json.dumps(counts, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
