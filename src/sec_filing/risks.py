"""Extract and compare Item 1A risk-factor passages from SEC filing HTML."""

from __future__ import annotations

from collections import Counter, defaultdict, deque
from dataclasses import dataclass
from datetime import UTC, datetime
from difflib import SequenceMatcher
from html.parser import HTMLParser
from pathlib import Path
import re

from .client import FilingMetadata, SecError
from .schema import (
    CompanyReference,
    EvidenceReference,
    FilingReference,
    write_document,
)


ITEM_1A = re.compile(r"\bItem\s+1A[.\s:–—-]+Risk\s+Factors\b", re.IGNORECASE)
ITEM_1A_HEADING = re.compile(
    r"^(?:Part\s+I[.\s:–—-]+)?Item\s+1A[.\s:–—-]+Risk\s+Factors[.\s]*$",
    re.IGNORECASE,
)
ITEM_1B = re.compile(r"\bItem\s+1B[.\s:–—-]+", re.IGNORECASE)
ITEM_2 = re.compile(r"\bItem\s+2[.\s:–—-]+Properties\b", re.IGNORECASE)
FOOTER = re.compile(r"^.+\|.*Form 10-K\s*\|\s*\d+$", re.IGNORECASE)
BLOCK_TAGS = {"div", "p", "li", "td"}
MAX_APPROXIMATE_CANDIDATES = 12
POSITIONAL_NEIGHBORS = 2


def _clean_text(value: str) -> str:
    return re.sub(r"\s+", " ", value.replace("\xa0", " ")).strip()


def _comparison_text(value: str) -> str:
    return re.sub(r"[^a-z0-9 ]", "", _clean_text(value).lower())


def _comparison_tokens(value: str) -> frozenset[str]:
    """Return useful tokens for bounded candidate generation."""

    return frozenset(re.findall(r"[a-z0-9]{4,}", value))


def _risk_candidate_pairs(
    current_text: list[str],
    previous_text: list[str],
    *,
    match_threshold: float,
) -> list[tuple[float, int, int]]:
    """Generate plausible passage matches without an all-pairs comparison.

    Large filings can expose thousands of HTML blocks. Comparing every current
    block with every prior block makes processing quadratic and caused real
    onboarding jobs to run for minutes. Exact text is paired first. Remaining
    passages are compared only with a small set selected by uncommon shared
    tokens and nearby document position.
    """

    if not current_text or not previous_text:
        return []

    pairs: list[tuple[float, int, int]] = []
    exact_previous: dict[str, deque[int]] = defaultdict(deque)
    for previous_index, value in enumerate(previous_text):
        exact_previous[value].append(previous_index)
    exact_current: set[int] = set()
    exact_matched_previous: set[int] = set()
    for current_index, value in enumerate(current_text):
        matches = exact_previous.get(value)
        if matches:
            previous_index = matches.popleft()
            exact_current.add(current_index)
            exact_matched_previous.add(previous_index)
            pairs.append((1.0, current_index, previous_index))

    previous_tokens = [_comparison_tokens(value) for value in previous_text]
    token_frequency = Counter(
        token for tokens in previous_tokens for token in tokens
    )
    # Very common boilerplate words do not identify a plausible paragraph.
    common_limit = max(10, len(previous_text) // 5)
    token_index: dict[str, list[int]] = defaultdict(list)
    for previous_index, tokens in enumerate(previous_tokens):
        if previous_index in exact_matched_previous:
            continue
        for token in tokens:
            if token_frequency[token] <= common_limit:
                token_index[token].append(previous_index)

    for current_index, value in enumerate(current_text):
        if current_index in exact_current:
            continue
        hits: Counter[int] = Counter()
        for token in _comparison_tokens(value):
            for previous_index in token_index.get(token, ()):
                hits[previous_index] += 1

        expected = round(
            current_index * (len(previous_text) - 1) / max(len(current_text) - 1, 1)
        )
        positional = {
            index
            for index in range(
                max(0, expected - POSITIONAL_NEIGHBORS),
                min(len(previous_text), expected + POSITIONAL_NEIGHBORS + 1),
            )
            if index not in exact_matched_previous
        }
        ranked = sorted(
            hits,
            key=lambda index: (-hits[index], abs(index - expected), index),
        )[:MAX_APPROXIMATE_CANDIDATES]
        candidates = set(ranked) | positional
        for previous_index in candidates:
            similarity = SequenceMatcher(
                None, value, previous_text[previous_index]
            ).ratio()
            if similarity >= match_threshold:
                pairs.append((similarity, current_index, previous_index))
    return pairs


@dataclass
class _Block:
    text: str
    element_id: str | None
    order: int


@dataclass
class _Frame:
    tag: str
    element_id: str | None
    parts: list[str]
    order: int


class _BlockParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.frames: list[_Frame] = []
        self.blocks: list[_Block] = []
        self.next_order = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        lowered = tag.lower()
        if lowered in BLOCK_TAGS:
            attributes = dict(attrs)
            self.frames.append(
                _Frame(lowered, attributes.get("id"), [], self.next_order)
            )
            self.next_order += 1
        elif lowered == "br" and self.frames:
            self.frames[-1].parts.append(" ")

    def handle_data(self, data: str) -> None:
        if self.frames:
            self.frames[-1].parts.append(data)

    def handle_endtag(self, tag: str) -> None:
        lowered = tag.lower()
        if lowered not in BLOCK_TAGS or not self.frames:
            return
        matching_index = next(
            (
                index
                for index in range(len(self.frames) - 1, -1, -1)
                if self.frames[index].tag == lowered
            ),
            None,
        )
        if matching_index is None:
            return
        frame = self.frames.pop(matching_index)
        text = _clean_text("".join(frame.parts))
        if text or frame.element_id:
            self.blocks.append(_Block(text, frame.element_id, frame.order))


@dataclass(frozen=True)
class RiskPassage:
    evidence_id: str
    passage_number: int
    text: str
    accession_number: str
    report_date: str
    filing_url: str
    anchor: str | None
    source_url: str


@dataclass(frozen=True)
class RiskSection:
    company_name: str
    ticker: str
    cik: str
    form: str
    filing_date: str
    report_date: str
    accession_number: str
    filing_url: str
    filing_index_url: str
    section: str
    extracted_at: str
    passages: tuple[RiskPassage, ...]


@dataclass(frozen=True)
class RiskChange:
    evidence_id: str
    change_type: str
    similarity: float | None
    current: RiskPassage | None
    previous: RiskPassage | None


@dataclass(frozen=True)
class RiskComparison:
    company_name: str
    ticker: str
    current_accession_number: str
    previous_accession_number: str
    current_filing_url: str
    previous_filing_url: str
    compared_at: str
    methodology: str
    added_count: int
    removed_count: int
    materially_changed_count: int
    changes: tuple[RiskChange, ...]


def extract_risk_section(
    html_path: Path,
    metadata: FilingMetadata,
    destination: Path,
) -> tuple[RiskSection, Path]:
    parser = _BlockParser()
    parser.feed(html_path.read_text(encoding="utf-8", errors="replace"))
    # HTML elements close from the inside out.  Without restoring their opening
    # order, a large outer <div> is emitted after all of its descendants and can
    # move headings and boundary markers out of document order.
    parser.blocks.sort(key=lambda block: block.order)

    # Filings often repeat Item 1A in the table of contents.  Build every
    # candidate section and select the substantial one instead of assuming the
    # first heading is the report body.
    candidates: list[list[tuple[str, str | None]]] = []
    raw_passages: list[tuple[str, str | None]] | None = None
    current_anchor: str | None = None
    for block in parser.blocks:
        if block.element_id:
            current_anchor = block.element_id
        normalized = _clean_text(block.text)
        if ITEM_1A_HEADING.fullmatch(normalized):
            raw_passages = []
            candidates.append(raw_passages)
            continue
        if raw_passages is None:
            continue
        if (ITEM_1B.search(normalized) or ITEM_2.search(normalized)) and len(normalized) <= 160:
            raw_passages = None
            continue
        if (
            len(normalized) >= 40
            and not FOOTER.match(normalized)
            and not ITEM_1A.search(normalized)
        ):
            raw_passages.append((normalized, current_anchor))

    if not candidates:
        raise SecError(f"Could not locate Item 1A in {html_path}.")
    raw_passages = max(candidates, key=lambda items: sum(len(text) for text, _ in items))
    if not raw_passages:
        raise SecError(f"Item 1A contained no extractable passages in {html_path}.")

    # Inline XBRL filings frequently repeat the same text through nested table,
    # div, and paragraph nodes. Preserve the first source anchor and remove only
    # exact normalized duplicates so they do not inflate the dashboard or the
    # comparison workload.
    deduplicated: list[tuple[str, str | None]] = []
    seen_passages: set[str] = set()
    for text, anchor in raw_passages:
        identity = _comparison_text(text)
        if not identity or identity in seen_passages:
            continue
        seen_passages.add(identity)
        deduplicated.append((text, anchor))
    raw_passages = deduplicated

    passages = tuple(
        RiskPassage(
            evidence_id=(
                f"{metadata.ticker}-{metadata.accession_number}-risk-{index:03d}"
            ),
            passage_number=index,
            text=text,
            accession_number=metadata.accession_number,
            report_date=metadata.report_date,
            filing_url=metadata.official_url,
            anchor=anchor,
            source_url=(
                f"{metadata.official_url}#{anchor}" if anchor else metadata.official_url
            ),
        )
        for index, (text, anchor) in enumerate(raw_passages, start=1)
    )
    result = RiskSection(
        company_name=metadata.company_name,
        ticker=metadata.ticker,
        cik=metadata.cik,
        form=metadata.form,
        filing_date=metadata.filing_date,
        report_date=metadata.report_date,
        accession_number=metadata.accession_number,
        filing_url=metadata.official_url,
        filing_index_url=metadata.filing_index_url,
        section="Item 1A. Risk Factors",
        extracted_at=datetime.now(UTC).isoformat(),
        passages=passages,
    )
    output_path = destination / "risk_factors.json"
    write_document(
        output_path,
        record_type="risk_passages",
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
                evidence_id=passage.evidence_id,
                evidence_type="risk_passage",
                label=f"Item 1A passage {passage.passage_number}",
                accession_number=passage.accession_number,
                source_url=passage.source_url,
            )
            for passage in result.passages
        ),
        payload=result,
    )
    return result, output_path


def compare_risk_sections(
    current: RiskSection,
    previous: RiskSection,
    destination: Path,
    *,
    match_threshold: float = 0.55,
    material_change_threshold: float = 0.92,
) -> tuple[RiskComparison, Path]:
    """Match similar passages and classify deterministic year-over-year changes."""

    if current.ticker != previous.ticker:
        raise SecError("Cannot compare risk factors from different companies.")
    current_text = [_comparison_text(item.text) for item in current.passages]
    previous_text = [_comparison_text(item.text) for item in previous.passages]

    candidate_pairs = _risk_candidate_pairs(
        current_text,
        previous_text,
        match_threshold=match_threshold,
    )
    candidate_pairs.sort(reverse=True)

    matched_current: set[int] = set()
    matched_previous: set[int] = set()
    matches: list[tuple[float, int, int]] = []
    for similarity, current_index, previous_index in candidate_pairs:
        if current_index in matched_current or previous_index in matched_previous:
            continue
        matched_current.add(current_index)
        matched_previous.add(previous_index)
        matches.append((similarity, current_index, previous_index))

    changes: list[RiskChange] = []
    sequence = 1
    for similarity, current_index, previous_index in sorted(
        matches, key=lambda item: item[1]
    ):
        if similarity < material_change_threshold:
            changes.append(
                RiskChange(
                    evidence_id=(
                        f"{current.ticker}-{current.accession_number}-risk-change-{sequence:03d}"
                    ),
                    change_type="materially_changed",
                    similarity=round(similarity, 4),
                    current=current.passages[current_index],
                    previous=previous.passages[previous_index],
                )
            )
            sequence += 1

    for current_index, passage in enumerate(current.passages):
        if current_index not in matched_current:
            changes.append(
                RiskChange(
                    evidence_id=(
                        f"{current.ticker}-{current.accession_number}-risk-change-{sequence:03d}"
                    ),
                    change_type="added",
                    similarity=None,
                    current=passage,
                    previous=None,
                )
            )
            sequence += 1

    for previous_index, passage in enumerate(previous.passages):
        if previous_index not in matched_previous:
            changes.append(
                RiskChange(
                    evidence_id=(
                        f"{current.ticker}-{current.accession_number}-risk-change-{sequence:03d}"
                    ),
                    change_type="removed",
                    similarity=None,
                    current=None,
                    previous=passage,
                )
            )
            sequence += 1

    added_count = sum(item.change_type == "added" for item in changes)
    removed_count = sum(item.change_type == "removed" for item in changes)
    changed_count = sum(item.change_type == "materially_changed" for item in changes)
    result = RiskComparison(
        company_name=current.company_name,
        ticker=current.ticker,
        current_accession_number=current.accession_number,
        previous_accession_number=previous.accession_number,
        current_filing_url=current.filing_url,
        previous_filing_url=previous.filing_url,
        compared_at=datetime.now(UTC).isoformat(),
        methodology=(
            "Paragraphs are normalized, exact matches are paired first, and remaining "
            "candidates are bounded by uncommon shared tokens and nearby document position "
            "before greedy SequenceMatcher pairing. "
            f"Pairs below {material_change_threshold:.2f} but at or above "
            f"{match_threshold:.2f} are materially changed; unmatched passages are added "
            "or removed. This is deterministic text analysis, not an AI conclusion."
        ),
        added_count=added_count,
        removed_count=removed_count,
        materially_changed_count=changed_count,
        changes=tuple(changes),
    )
    output_path = destination / "risk_changes.json"
    cited_passages = []
    for change in result.changes:
        if change.current is not None:
            cited_passages.append(change.current)
        if change.previous is not None:
            cited_passages.append(change.previous)
    passage_evidence = [
        EvidenceReference(
            evidence_id=passage.evidence_id,
            evidence_type="risk_passage",
            label=f"Item 1A passage {passage.passage_number}",
            accession_number=passage.accession_number,
            source_url=passage.source_url,
        )
        for passage in cited_passages
    ]
    change_evidence = [
        EvidenceReference(
            evidence_id=change.evidence_id,
            evidence_type="derived_risk_change",
            label=change.change_type.replace("_", " ").title(),
            accession_number=current.accession_number,
            source_url=None,
            source_evidence_ids=tuple(
                passage.evidence_id
                for passage in (change.current, change.previous)
                if passage is not None
            ),
        )
        for change in result.changes
    ]
    write_document(
        output_path,
        record_type="risk_changes",
        company=CompanyReference(
            cik=current.cik,
            ticker=current.ticker,
            name=current.company_name,
        ),
        filings=(
            FilingReference(
                accession_number=current.accession_number,
                form=current.form,
                filing_date=current.filing_date,
                report_date=current.report_date,
                official_url=current.filing_url,
                filing_index_url=current.filing_index_url,
            ),
            FilingReference(
                accession_number=previous.accession_number,
                form=previous.form,
                filing_date=previous.filing_date,
                report_date=previous.report_date,
                official_url=previous.filing_url,
                filing_index_url=previous.filing_index_url,
                role="comparison",
            ),
        ),
        evidence=(
            EvidenceReference(
                evidence_id=(
                    f"{current.ticker}-{current.accession_number}-filing-document"
                ),
                evidence_type="filing_document",
                # Filing-document evidence is shared across metadata, financial,
                # and risk documents. Keep its definition canonical so merging
                # independently generated schema files cannot create a false
                # evidence collision.
                label=f"{current.company_name} {current.form}",
                accession_number=current.accession_number,
                source_url=current.filing_url,
            ),
            EvidenceReference(
                evidence_id=(
                    f"{previous.ticker}-{previous.accession_number}-filing-document"
                ),
                evidence_type="filing_document",
                label=f"{previous.company_name} {previous.form}",
                accession_number=previous.accession_number,
                source_url=previous.filing_url,
            ),
            *passage_evidence,
            *change_evidence,
        ),
        payload=result,
    )
    return result, output_path
