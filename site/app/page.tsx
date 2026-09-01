'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ApiError, type AnalysisJob, type Company, type Comparison, type Evidence, type Fact, type Filing,
  type FilingData, type Ratio, type RiskChange, type RiskComparison, type RiskPassage,
  directEvidence, filingLensApi, loadFilingData,
} from '../lib/api';
import { TurnstileWidget } from './TurnstileWidget';

type View = 'overview' | 'ratios' | 'comparison' | 'risks';
type RiskFilter = 'all' | RiskChange['change_type'];
const riskLabels: Record<RiskFilter, string> = { all: 'All changes', materially_changed: 'Changed', added: 'Added', removed: 'Removed' };

function shortName(company: Company | null): string {
  if (!company) return '';
  return company.name.replace(/\b(?:INC|CORP|CORPORATION|LTD)\b\.?/gi, '').replace(/[,.]+\s*$/, '').replace(/\s+/g, ' ').trim();
}
function formatDate(value?: string | null): string {
  if (!value) return 'Not available';
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${value}T00:00:00Z`));
}
function formatTimestamp(value?: string | null): string {
  if (!value) return 'Not checked yet';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(new Date(value));
}
function refreshLabel(status?: Company['refresh_status']): string {
  if (status === 'imported') return 'New filing imported';
  if (status === 'failed') return 'Refresh needs attention';
  return 'Up to date';
}
function compactValue(value: string): string {
  return value.replace(' billion', 'B').replace(' million', 'M').replace(' thousand', 'K');
}
function EvidenceLink({ href, children = 'SEC source' }: { href: string; children?: React.ReactNode }) {
  return <a className="evidence-link" href={href} target="_blank" rel="noreferrer">{children}<span aria-hidden="true"> ↗</span></a>;
}
function EvidenceSources({ evidence, evidenceId }: { evidence: Evidence[]; evidenceId: string }) {
  const sources = directEvidence(evidence, evidenceId);
  if (!sources.length) return <span className="source-unavailable">Source unavailable</span>;
  return <div className="source-list" aria-label="SEC evidence sources">{sources.map((source) => <EvidenceLink href={source.source_url!} key={source.evidence_id}>{source.label} · {source.accession_number.slice(-9)}</EvidenceLink>)}</div>;
}
function LoadingState() {
  return <div className="state-panel loading-panel" role="status" aria-live="polite"><span className="spinner" aria-hidden="true" /><div><strong>Loading SEC intelligence</strong><p>Retrieving filings and evidence from the read-only API…</p></div></div>;
}
function EmptyState({ title, body }: { title: string; body: string }) {
  return <div className="empty-state"><span aria-hidden="true">—</span><div><strong>{title}</strong><p>{body}</p></div></div>;
}
function FilingPicker({ filings, selected, onSelect }: { filings: Filing[]; selected: string; onSelect: (accession: string) => void }) {
  return <div className="filing-picker"><label htmlFor="filing-select">Selected filing</label><select id="filing-select" value={selected} onChange={(event) => onSelect(event.target.value)}>{filings.map((filing) => <option value={filing.accession_number} key={filing.accession_number}>{filing.form} · period {filing.report_date} · filed {filing.filing_date}</option>)}</select></div>;
}

function Financials({ facts, evidence }: { facts: Fact[]; evidence: Evidence[] }) {
  if (!facts.length) return <EmptyState title="No financial facts" body="This filing has no supported financial facts in the pilot dataset." />;
  return <div className="metric-grid">{facts.map((fact) => <article className="metric-card" key={fact.evidence_id}>
    <div className="metric-top"><span>{fact.name}</span><span className="unit-chip">{fact.unit}</span></div><strong>{compactValue(fact.formatted_value)}</strong>
    <p>{fact.period_start ? `${formatDate(fact.period_start)}–${formatDate(fact.period_end)}` : `As of ${formatDate(fact.period_end)}`}</p>
    <details className="evidence-details"><summary>Inspect evidence</summary><dl><div><dt>Concept</dt><dd>{fact.taxonomy}:{fact.concept}</dd></div><div><dt>Fiscal period</dt><dd>{fact.fiscal_period ?? 'Not supplied'}</dd></div><div><dt>Evidence ID</dt><dd>{fact.evidence_id}</dd></div></dl><EvidenceSources evidence={evidence} evidenceId={fact.evidence_id} /></details>
  </article>)}</div>;
}
function Ratios({ ratios, evidence }: { ratios: Ratio[]; evidence: Evidence[] }) {
  if (!ratios.length) return <EmptyState title="No calculated ratios" body="Required inputs were unavailable, so the pipeline did not estimate a value." />;
  return <div className="ratio-grid">{ratios.map((ratio) => <article className="ratio-card" key={ratio.evidence_id}><span className="ratio-index">Derived metric</span><strong>{ratio.formatted_value}</strong><h3>{ratio.name}</h3><code>{ratio.formula}</code><details className="evidence-details"><summary>Show calculation &amp; sources</summary><p className="calculation">{ratio.calculation}</p><EvidenceSources evidence={evidence} evidenceId={ratio.evidence_id} /></details></article>)}</div>;
}
function findMetric(key: string, accession: string, current: FilingData, previous: FilingData | null): Fact | Ratio | undefined {
  const source = accession === current.financials.accession_number ? current : previous;
  return source?.financials.facts.find((item) => item.key === key) ?? source?.ratios.ratios.find((item) => item.key === key);
}
function ComparisonView({ comparison, current, previous }: { comparison: Comparison | null; current: FilingData; previous: FilingData | null }) {
  if (!comparison) return <EmptyState title="No valid comparison" body="A matching prior-year filing is not stored for this selection. FilingLens will not compare unrelated periods." />;
  const evidence = [...current.comparisons.evidence, ...(previous?.financials.evidence ?? []), ...(previous?.ratios.evidence ?? [])];
  return <><div className="comparison-context"><span>Matched period</span><strong>{comparison.form} · {comparison.fiscal_period ?? 'FY'}</strong><p>{comparison.comparison_basis.replaceAll('_', ' ')}</p></div><div className="comparison-table-wrap"><table className="comparison-table"><thead><tr><th>Measure</th><th>Prior year</th><th>Current</th><th>Change</th><th>SEC evidence</th></tr></thead><tbody>{comparison.changes.map((change) => {
    const currentMetric = findMetric(change.key, comparison.current_accession, current, previous);
    const previousMetric = findMetric(change.key, comparison.previous_accession, current, previous);
    return <tr key={change.evidence_id}><th scope="row">{change.name}</th><td>{previousMetric ? compactValue(previousMetric.formatted_value) : 'Unavailable'}</td><td>{currentMetric ? compactValue(currentMetric.formatted_value) : 'Unavailable'}</td><td><span className={`movement ${change.direction}`}>{change.formatted_change}</span></td><td><EvidenceSources evidence={evidence} evidenceId={change.evidence_id} /></td></tr>;
  })}</tbody></table></div><p className="direction-note">Direction describes the number only. It is not a bullish or bearish judgment.</p></>;
}
function Passage({ passage, label }: { passage?: RiskPassage; label: string }) {
  if (!passage) return <div className="passage empty-passage"><span>{label}</span><p>No corresponding passage in this filing.</p></div>;
  return <div className="passage"><div className="passage-heading"><span>{label}</span><small>Passage {passage.passage_number}</small></div><blockquote>{passage.text}</blockquote><EvidenceLink href={passage.source_url}>Open cited passage</EvidenceLink></div>;
}
function RisksView({ comparison, currentPassages, previousPassages }: { comparison: RiskComparison | null; currentPassages: RiskPassage[]; previousPassages: RiskPassage[] }) {
  const [filter, setFilter] = useState<RiskFilter>('all');
  const [query, setQuery] = useState('');
  const [visible, setVisible] = useState(6);
  const currentById = useMemo(() => new Map(currentPassages.map((item) => [item.evidence_id, item])), [currentPassages]);
  const previousById = useMemo(() => new Map(previousPassages.map((item) => [item.evidence_id, item])), [previousPassages]);
  const filtered = (comparison?.changes ?? []).filter((change) => {
    if (filter !== 'all' && change.change_type !== filter) return false;
    const text = `${currentById.get(change.current_passage_id ?? '')?.text ?? ''} ${previousById.get(change.previous_passage_id ?? '')?.text ?? ''}`.toLowerCase();
    return !query.trim() || text.includes(query.trim().toLowerCase());
  });
  if (!comparison) return <EmptyState title="No risk comparison for this filing" body="Item 1A comparison is currently available for Apple’s paired 10-K filings. Quarterly filings and unsupported annual filings are shown without invented conclusions." />;
  return <><div className="risk-stats"><article><strong>{comparison.materially_changed_count}</strong><span>Changed</span></article><article><strong>{comparison.added_count}</strong><span>Added</span></article><article><strong>{comparison.removed_count}</strong><span>Removed</span></article></div>
    <div className="risk-controls"><div className="segmented" role="group" aria-label="Filter risk changes">{(Object.keys(riskLabels) as RiskFilter[]).map((item) => <button className={filter === item ? 'active' : ''} type="button" key={item} onClick={() => { setFilter(item); setVisible(6); }}>{riskLabels[item]}</button>)}</div><label className="risk-search"><span className="sr-only">Search risk language</span><input type="search" placeholder="Search risk language" value={query} onChange={(event) => { setQuery(event.target.value); setVisible(6); }} /></label></div>
    <p className="result-count">Showing {Math.min(visible, filtered.length)} of {filtered.length} matching changes</p><div className="risk-list">{filtered.slice(0, visible).map((change) => <article className="risk-card" key={change.evidence_id}><div className="risk-card-heading"><span className={`risk-badge ${change.change_type}`}>{riskLabels[change.change_type]}</span>{change.similarity !== null && <span>{(change.similarity * 100).toFixed(1)}% text similarity</span>}</div><div className="passage-grid"><Passage passage={previousById.get(change.previous_passage_id ?? '')} label="Prior filing" /><Passage passage={currentById.get(change.current_passage_id ?? '')} label="Current filing" /></div></article>)}</div>
    {!filtered.length && <EmptyState title="No matching passages" body="Try another keyword or change the filter." />}{visible < filtered.length && <button className="load-more" type="button" onClick={() => setVisible((count) => count + 6)}>Load 6 more changes</button>}<details className="method-note"><summary>How risk changes are classified</summary><p>{comparison.methodology}</p></details></>;
}

export default function Home() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [ticker, setTicker] = useState('AAPL');
  const [company, setCompany] = useState<Company | null>(null);
  const [filings, setFilings] = useState<Filing[]>([]);
  const [accession, setAccession] = useState('');
  const [data, setData] = useState<FilingData | null>(null);
  const [previousData, setPreviousData] = useState<FilingData | null>(null);
  const [view, setView] = useState<View>('overview');
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState<Company[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [discoveredCompany, setDiscoveredCompany] = useState<Company | null>(null);
  const [analysisJob, setAnalysisJob] = useState<AnalysisJob | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [analysisSubmitting, setAnalysisSubmitting] = useState(false);
  const [challengeToken, setChallengeToken] = useState('');
  const [challengeReset, setChallengeReset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const selectedFiling = filings.find((filing) => filing.accession_number === accession) ?? null;
  const comparison = data?.comparisons.comparisons.find((item) => item.current_accession === accession) ?? null;
  const riskBundle = data?.risks.risks[0];
  const riskComparison = riskBundle?.comparisons.find((item) => item.current_accession === accession) ?? null;
  const chooseTicker = useCallback((nextTicker: string) => {
    setLoading(true); setError(null); setData(null); setPreviousData(null);
    setTicker(nextTicker); setSearch(''); setSearchResults([]); setDiscoveredCompany(null); setView('overview'); setAccession('');
  }, []);
  const chooseSearchResult = useCallback((item: Company) => {
    if (item.availability === 'requires_analysis') {
      setDiscoveredCompany(item); setAnalysisJob(null); setAnalysisError(null); setChallengeToken(''); setSearch(''); setSearchResults([]);
      return;
    }
    chooseTicker(item.ticker);
  }, [chooseTicker]);
  const chooseAccession = useCallback((nextAccession: string) => {
    setLoading(true); setError(null); setPreviousData(null);
    setAccession(nextAccession); setView('overview');
  }, []);
  const retry = useCallback(() => {
    setLoading(true); setError(null); setData(null); setPreviousData(null);
    setReloadKey((key) => key + 1);
  }, []);
  const submitAnalysis = useCallback(async () => {
    if (!discoveredCompany || !challengeToken) return;
    setAnalysisSubmitting(true); setAnalysisError(null);
    try {
      setAnalysisJob(await filingLensApi.requestAnalysis(discoveredCompany.ticker, challengeToken));
    } catch (reason) {
      setAnalysisError(reason instanceof ApiError ? reason.message : 'The analysis request could not be submitted.');
    } finally {
      setAnalysisSubmitting(false); setChallengeToken(''); setChallengeReset((value) => value + 1);
    }
  }, [challengeToken, discoveredCompany]);
  const retryAnalysis = useCallback(async () => {
    if (!analysisJob || !challengeToken) return;
    setAnalysisSubmitting(true); setAnalysisError(null);
    try {
      setAnalysisJob(await filingLensApi.retryAnalysis(analysisJob.job_id, challengeToken));
    } catch (reason) {
      setAnalysisError(reason instanceof ApiError ? reason.message : 'The analysis retry could not be submitted.');
    } finally {
      setAnalysisSubmitting(false); setChallengeToken(''); setChallengeReset((value) => value + 1);
    }
  }, [analysisJob, challengeToken]);

  useEffect(() => {
    const controller = new AbortController();
    filingLensApi.companies(controller.signal).then(setCompanies).catch((reason: ApiError) => { if (reason.name !== 'AbortError') setError(reason.message); });
    return () => controller.abort();
  }, [reloadKey]);
  useEffect(() => {
    const query = search.trim();
    if (!query) {
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setSearching(true); setSearchError(null);
      filingLensApi.searchTickers(query, controller.signal)
        .then(setSearchResults)
        .catch((reason: ApiError) => { if (reason.name !== 'AbortError') setSearchError(reason.message); })
        .finally(() => { if (!controller.signal.aborted) setSearching(false); });
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [search]);
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([filingLensApi.company(ticker, controller.signal), filingLensApi.filings(ticker, controller.signal)]).then(([nextCompany, nextFilings]) => {
      setCompany(nextCompany); setFilings(nextFilings); setAccession((current) => current && nextFilings.some((item) => item.accession_number === current) ? current : (nextFilings[0]?.accession_number ?? '')); if (!nextFilings.length) setLoading(false);
    }).catch((reason: ApiError) => { if (reason.name !== 'AbortError') { setError(reason.message); setLoading(false); } });
    return () => controller.abort();
  }, [ticker, reloadKey]);
  useEffect(() => {
    if (!accession) return;
    const controller = new AbortController();
    loadFilingData(accession, controller.signal).then(async (nextData) => {
      setData(nextData);
      const nextComparison = nextData.comparisons.comparisons.find((item) => item.current_accession === accession);
      const nextRisk = nextData.risks.risks[0]?.comparisons.find((item) => item.current_accession === accession);
      const previousAccession = nextComparison?.previous_accession ?? nextRisk?.previous_accession;
      if (previousAccession) setPreviousData(await loadFilingData(previousAccession, controller.signal));
    }).catch((reason: ApiError) => { if (reason.name !== 'AbortError') setError(reason.message); }).finally(() => setLoading(false));
    return () => controller.abort();
  }, [accession, reloadKey]);
  useEffect(() => {
    if (!analysisJob || !['queued', 'processing'].includes(analysisJob.status)) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      filingLensApi.analysisStatus(analysisJob.job_id, controller.signal)
        .then((nextJob) => {
          setAnalysisJob(nextJob);
          if (nextJob.status === 'completed') chooseTicker(nextJob.ticker);
        })
        .catch((reason: ApiError) => { if (reason.name !== 'AbortError') setAnalysisError(reason.message); });
    }, 3000);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [analysisJob, chooseTicker]);

  return <main id="top"><header className="topbar"><a className="brand" href="#top"><span className="brand-mark">FL</span><span>FilingLens</span></a><nav aria-label="Primary navigation"><a href="#dashboard">Dashboard</a><a href="#filings">Filings</a><a href="#methodology">Methodology</a></nav><span className="api-status"><i aria-hidden="true" /> Live SEC data</span></header>
    <section className="hero"><div className="hero-copy"><p className="eyebrow">SEC filing intelligence · Universal ticker discovery</p><h1>Research the filing.<br />Trace every number.</h1><p className="lede">Search the official SEC company directory, open analyzed companies, and see which companies still require filing processing.</p><div className="ticker-search"><label htmlFor="ticker-search">Search any SEC ticker</label><div className="search-box"><span aria-hidden="true">⌕</span><input id="ticker-search" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Try GOOG, AMZN, or a company name" autoComplete="off" aria-describedby="ticker-search-help" /></div><span className="search-help" id="ticker-search-help">Directory discovery does not start analysis.</span>{search && <div className="search-results" aria-live="polite">{searching ? <p>Searching the official SEC directory…</p> : searchError ? <p>{searchError}</p> : searchResults.length ? searchResults.map((item) => <button type="button" key={item.ticker} aria-label={`${item.ticker} ${item.name} ${item.availability === 'requires_analysis' ? 'analysis required' : 'available'}`} onClick={() => chooseSearchResult(item)}><strong>{item.ticker}</strong><span className="search-company-name">{shortName(item)}</span><span className={`availability ${item.availability ?? 'available'}`}>{item.availability === 'requires_analysis' ? 'Analysis required' : 'Available'}</span></button>) : <p>No SEC company matches “{search}”.</p>}</div>}</div><div className="company-pills" aria-label="Analyzed companies">{companies.map((item) => <button type="button" className={ticker === item.ticker ? 'active' : ''} onClick={() => chooseTicker(item.ticker)} key={item.ticker}>{item.ticker}</button>)}</div></div>
      <aside className="proof-card"><span className="proof-kicker">Evidence standard</span><strong>Every claim has a trail.</strong><ul><li><span>01</span>Official EDGAR filings</li><li><span>02</span>Exact XBRL concepts</li><li><span>03</span>Deterministic calculations</li></ul><p>No generated sentiment. No unsupported estimates.</p></aside></section>
    <section className="dashboard" id="dashboard">{discoveredCompany && <div className="discovery-panel" role="status"><div className="discovery-copy"><span>Official SEC directory match</span><strong>{discoveredCompany.ticker} · {discoveredCompany.name}</strong><p>CIK {discoveredCompany.cik}. FilingLens has not published analysis for this company, so no financial conclusions are shown yet.</p>{analysisJob ? <div className={`analysis-progress ${analysisJob.status}`} aria-live="polite"><span className="spinner" aria-hidden="true" /><div><strong>{analysisJob.status === 'queued' ? 'Queued' : analysisJob.status === 'processing' ? 'Processing SEC filings' : analysisJob.status === 'completed' ? 'Analysis complete' : analysisJob.status === 'unsupported' ? 'Unsupported company' : 'Analysis failed'}</strong><p>{analysisJob.message}</p><small>Attempt {analysisJob.attempt_count} of {analysisJob.max_attempts} · updated {formatTimestamp(analysisJob.updated_at)}</small></div></div> : <><TurnstileWidget onToken={setChallengeToken} resetNonce={challengeReset} /><button className="analyze-button" type="button" disabled={!challengeToken || analysisSubmitting} onClick={submitAnalysis}>{analysisSubmitting ? 'Submitting…' : `Analyze ${discoveredCompany.ticker}`}</button></>}{analysisJob?.can_retry && <><TurnstileWidget onToken={setChallengeToken} resetNonce={challengeReset} /><button className="analyze-button" type="button" disabled={!challengeToken || analysisSubmitting} onClick={retryAnalysis}>{analysisSubmitting ? 'Retrying…' : 'Retry analysis'}</button></>}{analysisError && <p className="analysis-error" role="alert">{analysisError}</p>}</div><button type="button" onClick={() => { setDiscoveredCompany(null); setAnalysisJob(null); }}>Continue viewing {ticker}</button></div>}{error && <div className="state-panel error-panel" role="alert"><div><strong>We couldn’t load this dashboard</strong><p>{error}</p></div><button type="button" onClick={retry}>Try again</button></div>}{!error && !company && loading && <LoadingState />}{!error && company && <><div className="company-heading"><div><p className="eyebrow dark">{company.ticker} · CIK {company.cik}</p><h2>{shortName(company)}</h2><p>{company.filing_count} processed filings · latest filed {formatDate(company.latest_filing_date)}</p>{company.refresh_status && <p className="refresh-freshness"><span className={`refresh-badge ${company.refresh_status}`}>{refreshLabel(company.refresh_status)}</span>Checked {formatTimestamp(company.last_checked_at)} · {company.refresh_message}</p>}</div>{selectedFiling && <div className="filing-actions"><span className="form-badge">{selectedFiling.form}</span><EvidenceLink href={selectedFiling.official_url}>Open official filing</EvidenceLink></div>}</div>
      <div className="workspace" id="filings"><aside className="filing-sidebar"><span className="sidebar-label">Filing history</span>{filings.map((filing) => <button type="button" className={filing.accession_number === accession ? 'active' : ''} onClick={() => chooseAccession(filing.accession_number)} key={filing.accession_number}><span className="form-badge">{filing.form}</span><strong>{formatDate(filing.report_date)}</strong><small>Filed {formatDate(filing.filing_date)}</small></button>)}</aside>
        <div className="workspace-main"><FilingPicker filings={filings} selected={accession} onSelect={chooseAccession} />{selectedFiling && <div className="filing-summary"><div><span>Reporting period</span><strong>{formatDate(selectedFiling.report_date)}</strong></div><div><span>Filed</span><strong>{formatDate(selectedFiling.filing_date)}</strong></div><div><span>Accession</span><strong>{selectedFiling.accession_number}</strong></div><EvidenceLink href={selectedFiling.filing_index_url}>SEC filing index</EvidenceLink></div>}
          <div className="view-tabs" role="tablist" aria-label="Filing analysis views">{([['overview', 'Financials'], ['ratios', 'Ratios'], ['comparison', 'Year over year'], ['risks', 'Risk changes']] as Array<[View, string]>).map(([key, label]) => <button role="tab" aria-selected={view === key} className={view === key ? 'active' : ''} type="button" onClick={() => setView(key)} key={key}>{label}</button>)}</div>{loading && <LoadingState />}{!loading && data && <section className="analysis-panel"><div className="section-heading"><div><p className="eyebrow dark">{view === 'overview' ? 'Reported facts' : view === 'ratios' ? 'Transparent calculations' : view === 'comparison' ? 'Matched-period analysis' : 'Item 1A language'}</p><h3>{view === 'overview' ? 'Financial snapshot' : view === 'ratios' ? 'Calculated ratios' : view === 'comparison' ? 'Year-over-year movement' : 'Risk-factor changes'}</h3></div><p>{view === 'overview' ? 'Values are matched to this exact accession and reporting period.' : view === 'ratios' ? 'Every formula exposes the SEC facts used as inputs.' : view === 'comparison' ? 'Quarterly filings match the same fiscal quarter in the prior year.' : 'Changed passages appear side by side with their filing anchors.'}</p></div>{view === 'overview' && <Financials facts={data.financials.facts} evidence={data.financials.evidence} />}{view === 'ratios' && <Ratios ratios={data.ratios.ratios} evidence={data.ratios.evidence} />}{view === 'comparison' && <ComparisonView comparison={comparison} current={data} previous={previousData} />}{view === 'risks' && <RisksView comparison={riskComparison} currentPassages={riskBundle?.passages ?? []} previousPassages={previousData?.risks.risks[0]?.passages ?? []} />}</section>}{!loading && !data && !error && <EmptyState title="No filing selected" body="Choose a filing from the history to inspect its evidence." />}</div></div></>}</section>
    <section className="methodology" id="methodology"><div className="method-heading"><p className="eyebrow">Built for verification</p><h2>From filing to finding,<br />without losing the source.</h2></div><div className="method-grid"><article><span>01</span><h3>Acquire</h3><p>Download official filing identities, HTML documents, and structured XBRL facts from SEC EDGAR.</p></article><article><span>02</span><h3>Normalize</h3><p>Map company-specific concepts and fiscal calendars into a versioned, validated schema.</p></article><article><span>03</span><h3>Compare</h3><p>Calculate ratios and compare annual filings or the same fiscal quarter—never unrelated periods.</p></article><article><span>04</span><h3>Cite</h3><p>Carry SEC URLs and evidence IDs through every fact, calculation, and language change.</p></article></div><p className="disclaimer">Research software, not investment advice. Numeric direction and text-change labels are not stock recommendations or legal-materiality conclusions.</p></section>
    <footer><a className="brand footer-brand" href="#top"><span className="brand-mark">FL</span><span>FilingLens</span></a><p>Official SEC directory discovery · asynchronous validation-gated analysis · Schema 1.0.0</p><a href="#top">Back to top ↑</a></footer></main>;
}
