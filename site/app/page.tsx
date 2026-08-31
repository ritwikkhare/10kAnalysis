'use client';

import { useMemo, useState } from 'react';
import metadataJson from './data/metadata.json';
import financialsJson from './data/financials.json';
import ratiosJson from './data/ratios.json';
import comparisonJson from './data/comparison.json';
import riskChangesJson from './data/risk-changes.json';

type SourceFact = {
  evidence_id: string;
  name: string;
  formatted_value: string;
  filing_url: string;
  sec_concept_url: string;
};

type Fact = SourceFact & {
  key: string;
  concept: string;
  period_start: string | null;
  period_end: string;
};

type RatioInput = SourceFact & { fact_key: string };
type Ratio = {
  evidence_id: string;
  key: string;
  name: string;
  formatted_value: string;
  formula: string;
  calculation: string;
  input_facts: RatioInput[];
};

type ComparisonSide = {
  accession_number: string;
  report_date: string;
  value: number;
  formatted_value: string;
  filing_url: string;
  source_facts: SourceFact[];
};

type Change = {
  evidence_id: string;
  key: string;
  name: string;
  direction: 'increased' | 'decreased' | 'unchanged';
  change_value: number;
  formatted_change: string;
  formula: string;
  current: ComparisonSide;
  previous: ComparisonSide;
};

type Passage = {
  evidence_id: string;
  passage_number: number;
  text: string;
  accession_number: string;
  report_date: string;
  source_url: string;
};

type RiskChange = {
  evidence_id: string;
  change_type: 'added' | 'removed' | 'materially_changed';
  similarity: number | null;
  current: Passage | null;
  previous: Passage | null;
};

const metadata = metadataJson;
const facts = financialsJson.facts as Fact[];
const ratios = ratiosJson.ratios as Ratio[];
const comparisons = comparisonJson.changes as Change[];
const risks = riskChangesJson;
const riskChanges = riskChangesJson.changes as RiskChange[];

const previousFilingUrl = risks.previous_filing_url;
const labels = {
  all: 'All changes',
  materially_changed: 'Changed',
  added: 'Added',
  removed: 'Removed',
};

function EvidenceLink({ href, children = 'SEC evidence' }: { href: string; children?: React.ReactNode }) {
  return (
    <a className="evidence-link" href={href} target="_blank" rel="noreferrer">
      <span aria-hidden="true">↗</span> {children}
    </a>
  );
}

function EvidenceId({ value }: { value: string }) {
  return <span className="evidence-id" title={value}>Evidence ID · {value}</span>;
}

function PassagePanel({ passage, label }: { passage: Passage | null; label: string }) {
  if (!passage) {
    return (
      <div className="passage-panel empty-panel">
        <span className="passage-label">{label}</span>
        <p>No corresponding passage in this filing.</p>
      </div>
    );
  }

  return (
    <div className="passage-panel">
      <div className="passage-topline">
        <span className="passage-label">{label}</span>
        <span>Passage {passage.passage_number}</span>
      </div>
      <blockquote>{passage.text}</blockquote>
      <div className="passage-evidence">
        <EvidenceLink href={passage.source_url}>Open cited passage</EvidenceLink>
        <EvidenceId value={passage.evidence_id} />
      </div>
    </div>
  );
}

export default function Home() {
  const [riskFilter, setRiskFilter] = useState<keyof typeof labels>('all');
  const [query, setQuery] = useState('');
  const [visibleCount, setVisibleCount] = useState(8);

  const comparisonByKey = useMemo(
    () => Object.fromEntries(comparisons.map((item) => [item.key, item])),
    [],
  );

  const filteredRisks = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return riskChanges.filter((item) => {
      const matchesType = riskFilter === 'all' || item.change_type === riskFilter;
      const text = `${item.current?.text ?? ''} ${item.previous?.text ?? ''}`.toLowerCase();
      return matchesType && (!normalized || text.includes(normalized));
    });
  }, [query, riskFilter]);

  const updateFilter = (filter: keyof typeof labels) => {
    setRiskFilter(filter);
    setVisibleCount(8);
  };

  return (
    <main>
      <header className="topbar">
        <a className="brand" href="#top" aria-label="FilingLens home">
          <span className="brand-mark">FL</span>
          <span>FilingLens</span>
        </a>
        <nav aria-label="Dashboard sections">
          <a href="#financials">Financials</a>
          <a href="#ratios">Ratios</a>
          <a href="#comparison">Comparison</a>
          <a href="#risks">Risk factors</a>
        </nav>
        <a className="header-source" href={metadata.official_url} target="_blank" rel="noreferrer">
          SEC filing ↗
        </a>
      </header>

      <section className="hero" id="top">
        <div className="hero-copy">
          <p className="eyebrow">Apple Inc. · AAPL · Form 10-K</p>
          <h1>See what changed.<br />Verify every claim.</h1>
          <p className="lede">
            Financial performance and risk-language changes from Apple&apos;s two
            latest annual filings, grounded in official SEC evidence.
          </p>
          <div className="hero-actions">
            <a className="primary-button" href="#financials">Explore the filing</a>
            <EvidenceLink href={metadata.official_url}>Open official 10-K</EvidenceLink>
          </div>
          <div className="trust-row" aria-label="Method summary">
            <span>Official SEC data</span>
            <span>Deterministic calculations</span>
            <span>93 surfaced risk changes</span>
          </div>
        </div>
        <aside className="filing-card" aria-label="Current filing details">
          <div className="filing-card-head">
            <div>
              <p className="card-kicker">Current filing</p>
              <strong>FY 2025</strong>
            </div>
            <span className="verified">● Verified</span>
          </div>
          <dl>
            <div><dt>Filed</dt><dd>{metadata.filing_date}</dd></div>
            <div><dt>Period ended</dt><dd>{metadata.report_date}</dd></div>
            <div><dt>Accession</dt><dd>{metadata.accession_number}</dd></div>
            <div><dt>Compared with</dt><dd>{comparisonJson.previous_report_date}</dd></div>
          </dl>
          <div className="filing-links">
            <EvidenceLink href={metadata.official_url}>Current filing</EvidenceLink>
            <EvidenceLink href={previousFilingUrl}>Previous filing</EvidenceLink>
          </div>
        </aside>
      </section>

      <div className="report-shell">
        <section className="report-section" id="financials">
          <div className="section-heading">
            <div><p className="eyebrow dark">Financial snapshot</p><h2>The year at a glance</h2></div>
            <p>Five headline US-GAAP facts matched to the exact accession and fiscal period.</p>
          </div>
          <div className="metric-grid">
            {facts.map((fact) => {
              const change = comparisonByKey[fact.key];
              return (
                <article className="metric-card" key={fact.key}>
                  <div className="metric-heading"><p>{fact.name}</p><span>USD</span></div>
                  <strong>{fact.formatted_value.replace(' billion', 'B')}</strong>
                  <span className={`movement ${change.direction}`}>
                    {change.formatted_change} year over year
                  </span>
                  <div className="fact-meta">
                    <span>{fact.concept}</span>
                    <span>{fact.period_start ? `${fact.period_start} – ` : 'As of '}{fact.period_end}</span>
                  </div>
                  <div className="card-evidence">
                    <EvidenceLink href={fact.sec_concept_url}>XBRL fact</EvidenceLink>
                    <EvidenceLink href={fact.filing_url}>10-K</EvidenceLink>
                  </div>
                  <EvidenceId value={fact.evidence_id} />
                </article>
              );
            })}
          </div>
        </section>

        <section className="report-section muted-section" id="ratios">
          <div className="section-heading">
            <div><p className="eyebrow dark">Transparent ratios</p><h2>Calculated, not guessed</h2></div>
            <p>Every ratio exposes its formula, raw calculation, and both SEC-sourced input facts.</p>
          </div>
          <div className="ratio-grid">
            {ratios.map((ratio) => (
              <article className="ratio-card" key={ratio.key}>
                <div className="ratio-number">{ratio.formatted_value}</div>
                <h3>{ratio.name}</h3>
                <code>{ratio.formula}</code>
                <p className="calculation">{ratio.calculation}</p>
                <details>
                  <summary>Inspect input evidence</summary>
                  <div className="input-facts">
                    {ratio.input_facts.map((input) => (
                      <div key={input.evidence_id}>
                        <span><strong>{input.name}</strong>{input.formatted_value}</span>
                        <EvidenceLink href={input.sec_concept_url}>SEC fact</EvidenceLink>
                      </div>
                    ))}
                  </div>
                </details>
                <EvidenceId value={ratio.evidence_id} />
              </article>
            ))}
          </div>
        </section>

        <section className="report-section" id="comparison">
          <div className="section-heading">
            <div><p className="eyebrow dark">Year over year</p><h2>Two filings, one clear view</h2></div>
            <p>Dollar facts use percent change. Ratios use percentage-point change.</p>
          </div>
          <div className="comparison-table-wrap">
            <table className="comparison-table">
              <thead>
                <tr>
                  <th>Measure</th>
                  <th>FY 2024</th>
                  <th>FY 2025</th>
                  <th>Movement</th>
                  <th>Evidence</th>
                </tr>
              </thead>
              <tbody>
                {comparisons.map((change) => (
                  <tr key={change.key}>
                    <th scope="row">{change.name}</th>
                    <td>{change.previous.formatted_value}</td>
                    <td>{change.current.formatted_value}</td>
                    <td><span className={`change-pill ${change.direction}`}>{change.formatted_change}</span></td>
                    <td className="table-links">
                      <EvidenceLink href={change.previous.filing_url}>2024</EvidenceLink>
                      <EvidenceLink href={change.current.filing_url}>2025</EvidenceLink>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="direction-note">Color shows numeric direction only—not whether a movement is favorable or unfavorable.</p>
        </section>

        <section className="report-section risk-section" id="risks">
          <div className="section-heading risk-heading">
            <div><p className="eyebrow light">Item 1A · Risk Factors</p><h2>Language worth reviewing</h2></div>
            <p>Exact passages are shown side by side and linked to their nearest available SEC anchors.</p>
          </div>
          <div className="risk-stats">
            <article><strong>{risks.materially_changed_count}</strong><span>Changed matches</span></article>
            <article><strong>{risks.added_count}</strong><span>Added passages</span></article>
            <article><strong>{risks.removed_count}</strong><span>Removed passages</span></article>
          </div>
          <div className="risk-controls">
            <div className="filter-group" role="group" aria-label="Filter risk changes">
              {(Object.keys(labels) as (keyof typeof labels)[]).map((filter) => (
                <button
                  className={riskFilter === filter ? 'active' : ''}
                  key={filter}
                  onClick={() => updateFilter(filter)}
                  type="button"
                >
                  {labels[filter]}
                </button>
              ))}
            </div>
            <label className="risk-search">
              <span className="sr-only">Search risk passages</span>
              <input
                type="search"
                placeholder="Search passages…"
                value={query}
                onChange={(event) => { setQuery(event.target.value); setVisibleCount(8); }}
              />
            </label>
          </div>
          <p className="result-count">Showing {Math.min(visibleCount, filteredRisks.length)} of {filteredRisks.length} matching changes</p>
          <div className="risk-list">
            {filteredRisks.slice(0, visibleCount).map((item) => (
              <article className="risk-card" key={item.evidence_id}>
                <div className="risk-card-head">
                  <span className={`risk-badge ${item.change_type}`}>{labels[item.change_type]}</span>
                  {item.similarity !== null && <span>{(item.similarity * 100).toFixed(1)}% text similarity</span>}
                </div>
                <div className="passage-grid">
                  <PassagePanel passage={item.previous} label="Previous filing · FY 2024" />
                  <PassagePanel passage={item.current} label="Current filing · FY 2025" />
                </div>
              </article>
            ))}
          </div>
          {visibleCount < filteredRisks.length && (
            <button className="load-more" type="button" onClick={() => setVisibleCount((count) => count + 8)}>
              Load 8 more changes
            </button>
          )}
          {filteredRisks.length === 0 && <p className="no-results">No passages match this search.</p>}
        </section>

        <section className="report-section methodology" id="methodology">
          <div className="section-heading">
            <div><p className="eyebrow dark">Methodology</p><h2>What this analysis means</h2></div>
          </div>
          <div className="method-grid">
            <article><span>01</span><h3>Official acquisition</h3><p>Filing identity and HTML come directly from SEC EDGAR using the company CIK and accession number.</p></article>
            <article><span>02</span><h3>Exact fact matching</h3><p>XBRL values are matched by accession, form, report date, period type, and US-GAAP concept.</p></article>
            <article><span>03</span><h3>Deterministic analysis</h3><p>Ratios and comparisons are calculated in Python. Risk passages use reproducible text-similarity thresholds.</p></article>
          </div>
          <div className="limits-card">
            <strong>Important limits</strong>
            <p>{risks.methodology} “Changed” is a text-analysis label, not a legal-materiality conclusion. This dashboard is research software and does not provide investment advice.</p>
          </div>
        </section>
      </div>

      <footer>
        <div><span className="brand-mark dark-mark">FL</span><strong>FilingLens</strong></div>
        <p>Built from public SEC EDGAR data · Apple Inc. · {metadata.accession_number}</p>
        <div className="footer-links"><a href="#top">Back to top ↑</a><EvidenceLink href={metadata.filing_index_url}>Filing index</EvidenceLink></div>
      </footer>
    </main>
  );
}
