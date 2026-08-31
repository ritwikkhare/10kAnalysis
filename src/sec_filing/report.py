"""Render a self-contained, evidence-linked HTML intelligence report."""

from __future__ import annotations

from html import escape
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from .client import FilingMetadata
from .comparison import YearOverYearComparison
from .financials import FinancialExtraction
from .ratios import RatioExtraction
from .risks import RiskComparison, RiskPassage
from .schema import validate_document


def _e(value: object) -> str:
    return escape(str(value), quote=True)


def _objectify(value: Any) -> Any:
    if isinstance(value, dict):
        return SimpleNamespace(**{key: _objectify(item) for key, item in value.items()})
    if isinstance(value, list):
        return tuple(_objectify(item) for item in value)
    return value


def build_html_report_from_files(filing_dir: Path, output_dir: Path) -> Path:
    """Build the report directly from the generated JSON evidence files."""

    required = {
        "metadata": filing_dir / "metadata.json",
        "financials": filing_dir / "financials.json",
        "ratios": filing_dir / "ratios.json",
        "comparison": filing_dir / "comparison.json",
        "risks": filing_dir / "risk_changes.json",
    }
    missing = [str(path) for path in required.values() if not path.exists()]
    if missing:
        raise FileNotFoundError("Missing report input files: " + ", ".join(missing))
    record_types = {
        "metadata": "filing_metadata",
        "financials": "financial_facts",
        "ratios": "financial_ratios",
        "comparison": "filing_comparison",
        "risks": "risk_changes",
    }
    values = {}
    for name, path in required.items():
        document = json.loads(path.read_text(encoding="utf-8"))
        if "schema_version" in document:
            validate_document(
                document,
                expected_record_type=record_types[name],
            )
        values[name] = _objectify(document)
    return build_html_report(
        values["metadata"],
        values["financials"],
        values["ratios"],
        values["comparison"],
        values["risks"],
        output_dir,
    )


def _source_link(url: str, label: str = "View SEC evidence") -> str:
    return (
        f'<a href="{_e(url)}" target="_blank" rel="noopener noreferrer">'
        f"{_e(label)}</a>"
    )


def _passage_panel(passage: RiskPassage | None, label: str) -> str:
    if passage is None:
        return (
            '<section class="passage empty">'
            f'<div class="passage-label">{_e(label)}</div>'
            '<p>Not present in this filing.</p>'
            "</section>"
        )
    return (
        '<section class="passage">'
        f'<div class="passage-label">{_e(label)} · {_e(passage.report_date)}</div>'
        f'<blockquote>{_e(passage.text)}</blockquote>'
        '<div class="evidence-row">'
        f'{_source_link(passage.source_url, "Open cited passage")}'
        f'<span>{_e(passage.accession_number)}</span>'
        "</div></section>"
    )


def build_html_report(
    metadata: FilingMetadata,
    financials: FinancialExtraction,
    ratios: RatioExtraction,
    comparison: YearOverYearComparison,
    risks: RiskComparison,
    output_dir: Path,
) -> Path:
    fact_cards = []
    for fact in financials.facts:
        fact_cards.append(
            '<article class="metric-card">'
            f'<div class="metric-name">{_e(fact.name)}</div>'
            f'<div class="metric-value">{_e(fact.formatted_value)}</div>'
            f'<div class="metric-period">Period ending {_e(fact.period_end)}</div>'
            '<div class="metric-links">'
            f'{_source_link(fact.sec_concept_url, "XBRL fact")}'
            f'{_source_link(fact.filing_url, metadata.form)}'
            "</div></article>"
        )

    ratio_cards = []
    for ratio in ratios.ratios:
        inputs = "".join(
            '<li>'
            f'{_source_link(item.sec_concept_url, item.name)}: '
            f'<strong>{_e(item.formatted_value)}</strong>'
            "</li>"
            for item in ratio.input_facts
        )
        ratio_cards.append(
            '<article class="ratio-card">'
            f'<div class="metric-name">{_e(ratio.name)}</div>'
            f'<div class="metric-value">{_e(ratio.formatted_value)}</div>'
            f'<code>{_e(ratio.formula)}</code>'
            f'<ul class="input-list">{inputs}</ul>'
            "</article>"
        )

    comparison_rows = []
    for change in comparison.changes:
        current_link = change.current.source_facts[0].sec_concept_url
        previous_link = change.previous.source_facts[0].sec_concept_url
        tone = "positive" if change.change_value > 0 else "negative" if change.change_value < 0 else "neutral"
        comparison_rows.append(
            "<tr>"
            f'<th scope="row">{_e(change.name)}</th>'
            f'<td>{_source_link(previous_link, change.previous.formatted_value)}</td>'
            f'<td>{_source_link(current_link, change.current.formatted_value)}</td>'
            f'<td><span class="change {tone}">{_e(change.formatted_change)}</span></td>'
            "</tr>"
        )

    risk_cards = []
    labels = {
        "added": "Added",
        "removed": "Removed",
        "materially_changed": "Materially changed",
    }
    for change in risks.changes:
        similarity = (
            f'<span>Text similarity: {change.similarity * 100:.1f}%</span>'
            if change.similarity is not None
            else ""
        )
        risk_cards.append(
            f'<article class="risk-card" data-risk-type="{_e(change.change_type)}">'
            '<div class="risk-card-header">'
            f'<span class="risk-badge {_e(change.change_type)}">'
            f'{_e(labels[change.change_type])}</span>{similarity}'
            "</div>"
            '<div class="passage-grid">'
            f'{_passage_panel(change.previous, "Previous filing")}'
            f'{_passage_panel(change.current, "Current filing")}'
            "</div></article>"
        )

    html = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="Evidence-linked {_e(metadata.company_name)} SEC filing intelligence report">
  <title>{_e(metadata.company_name)} SEC Filing Intelligence</title>
  <style>
    :root {{
      --ink: #17241e; --muted: #647069; --paper: #f3f5f1; --card: #ffffff;
      --line: #dce2dc; --green: #176b4d; --green-soft: #e5f2eb;
      --red: #a33e3e; --red-soft: #f8e9e7; --amber: #9a6418; --amber-soft: #fbf0d9;
      --navy: #122820; --shadow: 0 14px 40px rgba(23, 36, 30, .08);
    }}
    * {{ box-sizing: border-box; }}
    html {{ scroll-behavior: smooth; }}
    body {{ margin: 0; color: var(--ink); background: var(--paper); font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.55; }}
    a {{ color: var(--green); text-underline-offset: 3px; }}
    a:hover {{ color: #0d4d35; }}
    .hero {{ color: white; background: radial-gradient(circle at 85% 10%, #275d49 0, transparent 34%), var(--navy); padding: 72px 24px 58px; }}
    .hero-inner, main, .nav-inner {{ width: min(1180px, 100%); margin: 0 auto; }}
    .eyebrow {{ color: #9ed5bc; font-size: .78rem; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; }}
    h1 {{ max-width: 820px; margin: 12px 0 18px; font-family: Georgia, "Times New Roman", serif; font-size: clamp(2.5rem, 7vw, 5.6rem); line-height: .98; letter-spacing: -.045em; }}
    .hero p {{ max-width: 760px; color: #dbe9e1; font-size: 1.08rem; }}
    .hero-meta {{ display: flex; flex-wrap: wrap; gap: 12px; margin-top: 28px; }}
    .hero-meta span, .hero-meta a {{ border: 1px solid rgba(255,255,255,.22); border-radius: 999px; padding: 7px 12px; color: #eef8f2; text-decoration: none; font-size: .88rem; }}
    nav {{ position: sticky; top: 0; z-index: 10; border-bottom: 1px solid var(--line); background: rgba(243,245,241,.94); backdrop-filter: blur(14px); }}
    .nav-inner {{ display: flex; gap: 22px; overflow-x: auto; padding: 13px 24px; }}
    nav a {{ color: var(--ink); font-size: .88rem; font-weight: 750; text-decoration: none; white-space: nowrap; }}
    main {{ padding: 32px 24px 80px; }}
    section.report-section {{ scroll-margin-top: 70px; margin-top: 64px; }}
    .section-head {{ display: flex; justify-content: space-between; gap: 24px; align-items: end; margin-bottom: 22px; }}
    .section-head h2 {{ margin: 0; font-family: Georgia, "Times New Roman", serif; font-size: clamp(2rem, 4vw, 3.2rem); letter-spacing: -.025em; }}
    .section-head p {{ max-width: 580px; margin: 0; color: var(--muted); }}
    .metric-grid {{ display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 14px; }}
    .metric-card, .ratio-card, .table-wrap, .risk-card, .method-card {{ border: 1px solid var(--line); border-radius: 18px; background: var(--card); box-shadow: var(--shadow); }}
    .metric-card, .ratio-card {{ padding: 22px; }}
    .metric-name {{ min-height: 2.4em; color: var(--muted); font-size: .82rem; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; }}
    .metric-value {{ margin: 8px 0; font-family: Georgia, "Times New Roman", serif; font-size: clamp(1.75rem, 3vw, 2.55rem); line-height: 1.05; }}
    .metric-period {{ color: var(--muted); font-size: .82rem; }}
    .metric-links {{ display: flex; flex-wrap: wrap; gap: 10px; margin-top: 18px; font-size: .82rem; }}
    .ratio-grid {{ display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }}
    code {{ display: inline-block; margin: 5px 0 10px; padding: 5px 8px; border-radius: 7px; background: #edf0ec; color: #34463d; font-size: .78rem; }}
    .input-list {{ margin: 10px 0 0; padding-left: 18px; color: var(--muted); font-size: .85rem; }}
    .input-list li + li {{ margin-top: 6px; }}
    .table-wrap {{ overflow-x: auto; }}
    table {{ width: 100%; border-collapse: collapse; min-width: 720px; }}
    th, td {{ padding: 16px 18px; border-bottom: 1px solid var(--line); text-align: right; }}
    th:first-child, td:first-child {{ text-align: left; }}
    thead th {{ color: var(--muted); background: #f8faf7; font-size: .76rem; letter-spacing: .07em; text-transform: uppercase; }}
    tbody tr:last-child th, tbody tr:last-child td {{ border-bottom: 0; }}
    .change {{ display: inline-block; border-radius: 999px; padding: 5px 9px; font-weight: 800; }}
    .change.positive {{ color: var(--green); background: var(--green-soft); }}
    .change.negative {{ color: var(--red); background: var(--red-soft); }}
    .change.neutral {{ color: var(--muted); background: #edf0ec; }}
    .risk-summary {{ display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; margin-bottom: 20px; }}
    .risk-stat {{ padding: 20px; border-radius: 16px; }}
    .risk-stat strong {{ display: block; font: 700 2.7rem/1 Georgia, serif; }}
    .risk-stat.added {{ background: var(--green-soft); color: var(--green); }}
    .risk-stat.removed {{ background: var(--red-soft); color: var(--red); }}
    .risk-stat.materially_changed {{ background: var(--amber-soft); color: var(--amber); }}
    .filters {{ display: flex; flex-wrap: wrap; gap: 9px; margin: 20px 0; }}
    .filter-button {{ cursor: pointer; border: 1px solid var(--line); border-radius: 999px; padding: 9px 14px; color: var(--ink); background: white; font: inherit; font-size: .86rem; font-weight: 750; }}
    .filter-button:hover, .filter-button.active {{ color: white; background: var(--navy); border-color: var(--navy); }}
    .risk-list {{ display: grid; gap: 18px; }}
    .risk-card {{ overflow: hidden; }}
    .risk-card[hidden] {{ display: none; }}
    .risk-card-header {{ display: flex; justify-content: space-between; gap: 12px; align-items: center; padding: 13px 18px; border-bottom: 1px solid var(--line); color: var(--muted); font-size: .8rem; }}
    .risk-badge {{ border-radius: 999px; padding: 5px 9px; font-weight: 850; }}
    .risk-badge.added {{ color: var(--green); background: var(--green-soft); }}
    .risk-badge.removed {{ color: var(--red); background: var(--red-soft); }}
    .risk-badge.materially_changed {{ color: var(--amber); background: var(--amber-soft); }}
    .passage-grid {{ display: grid; grid-template-columns: 1fr 1fr; }}
    .passage {{ min-width: 0; padding: 20px; }}
    .passage + .passage {{ border-left: 1px solid var(--line); }}
    .passage.empty {{ color: var(--muted); background: #f8faf7; }}
    .passage-label {{ margin-bottom: 12px; color: var(--muted); font-size: .76rem; font-weight: 850; letter-spacing: .07em; text-transform: uppercase; }}
    blockquote {{ margin: 0; white-space: pre-wrap; font-family: Georgia, "Times New Roman", serif; font-size: 1rem; line-height: 1.62; }}
    .evidence-row {{ display: flex; flex-wrap: wrap; justify-content: space-between; gap: 10px; margin-top: 18px; color: var(--muted); font-size: .78rem; }}
    .method-card {{ padding: 22px; color: var(--muted); }}
    .method-card strong {{ color: var(--ink); }}
    footer {{ padding: 32px 24px 52px; color: var(--muted); text-align: center; font-size: .82rem; }}
    @media (max-width: 980px) {{ .metric-grid {{ grid-template-columns: repeat(2, 1fr); }} .ratio-grid {{ grid-template-columns: 1fr; }} }}
    @media (max-width: 700px) {{ .hero {{ padding-top: 52px; }} .section-head {{ display: block; }} .section-head p {{ margin-top: 10px; }} .metric-grid, .risk-summary, .passage-grid {{ grid-template-columns: 1fr; }} .passage + .passage {{ border-left: 0; border-top: 1px solid var(--line); }} }}
    @media print {{ nav, .filters {{ display: none; }} body {{ background: white; }} .hero {{ padding: 30px; }} .risk-card, .metric-card, .ratio-card {{ break-inside: avoid; box-shadow: none; }} }}
  </style>
</head>
<body>
  <header class="hero">
    <div class="hero-inner">
      <div class="eyebrow">SEC Filing Intelligence · Evidence-linked</div>
      <h1>{_e(metadata.company_name)} annual filing change report</h1>
      <p>A deterministic comparison of {_e(metadata.company_name)}’s two latest Form {_e(metadata.form)} filings. Every displayed value and passage links to its SEC source; no investment recommendation is generated here.</p>
      <div class="hero-meta">
        <span>Current FY: {_e(comparison.current_report_date)}</span>
        <span>Previous FY: {_e(comparison.previous_report_date)}</span>
        <span>CIK {_e(metadata.cik)}</span>
        {_source_link(metadata.official_url, f"Open current {metadata.form}")}
        {_source_link(risks.previous_filing_url, f"Open previous {metadata.form}")}
      </div>
    </div>
  </header>
  <nav aria-label="Report sections"><div class="nav-inner">
    <a href="#financials">Financials</a><a href="#ratios">Ratios</a>
    <a href="#year-over-year">Year over year</a><a href="#risk-changes">Risk changes</a>
    <a href="#methodology">Methodology</a>
  </div></nav>
  <main>
    <section class="report-section" id="financials">
      <div class="section-head"><h2>Financial snapshot</h2><p>Headline US-GAAP facts matched to accession {_e(metadata.accession_number)} and the fiscal year ending {_e(metadata.report_date)}.</p></div>
      <div class="metric-grid">{''.join(fact_cards)}</div>
    </section>
    <section class="report-section" id="ratios">
      <div class="section-head"><h2>Deterministic ratios</h2><p>Calculated in Python from the cited facts. Each input remains visible and independently verifiable.</p></div>
      <div class="ratio-grid">{''.join(ratio_cards)}</div>
    </section>
    <section class="report-section" id="year-over-year">
      <div class="section-head"><h2>Year-over-year movement</h2><p>Dollar facts use percentage change; ratios use percentage-point change. Green and red indicate direction, not investment sentiment.</p></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Measure</th><th>{_e(comparison.previous_report_date)}</th><th>{_e(comparison.current_report_date)}</th><th>Change</th></tr></thead>
        <tbody>{''.join(comparison_rows)}</tbody>
      </table></div>
    </section>
    <section class="report-section" id="risk-changes">
      <div class="section-head"><h2>Risk-factor language</h2><p>Exact Item 1A passages shown side by side. Use the filters to focus on additions, removals, or matched rewrites.</p></div>
      <div class="risk-summary">
        <div class="risk-stat added"><strong>{risks.added_count}</strong>Added passages</div>
        <div class="risk-stat removed"><strong>{risks.removed_count}</strong>Removed passages</div>
        <div class="risk-stat materially_changed"><strong>{risks.materially_changed_count}</strong>Materially changed matches</div>
      </div>
      <div class="filters" role="group" aria-label="Filter risk changes">
        <button class="filter-button active" data-filter="all" type="button">All changes</button>
        <button class="filter-button" data-filter="added" type="button">Added</button>
        <button class="filter-button" data-filter="removed" type="button">Removed</button>
        <button class="filter-button" data-filter="materially_changed" type="button">Changed</button>
      </div>
      <div class="risk-list">{''.join(risk_cards)}</div>
    </section>
    <section class="report-section" id="methodology">
      <div class="section-head"><h2>Methodology and limits</h2></div>
      <div class="method-card"><strong>Risk classification:</strong> {_e(risks.methodology)} “Materially changed” describes textual distance under this rule; it is not a legal-materiality determination. Financial figures come from SEC XBRL data matched by CIK, accession number, form, and reporting period. This report is research software, not financial advice.</div>
    </section>
  </main>
  <footer>Generated from public SEC EDGAR filings · {_e(metadata.company_name)} · {_e(metadata.accession_number)}</footer>
  <script>
    const buttons = document.querySelectorAll('.filter-button');
    const cards = document.querySelectorAll('.risk-card');
    buttons.forEach((button) => button.addEventListener('click', () => {{
      const filter = button.dataset.filter;
      buttons.forEach((item) => item.classList.toggle('active', item === button));
      cards.forEach((card) => {{ card.hidden = filter !== 'all' && card.dataset.riskType !== filter; }});
    }}));
  </script>
</body>
</html>
"""
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / f"{metadata.ticker.lower()}-sec-intelligence-report.html"
    output_path.write_text(html, encoding="utf-8")
    return output_path
