'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, filingLensApi, type AiResponse, type BriefType, type IndustryData, type IndustryPeer, type NewsFeed, type NewsItem } from '../lib/api';
import { Result, type ResultLabels } from './AiResearchPanel';
import { TurnstileWidget } from './TurnstileWidget';

type NewsFilter = 'all' | 'press' | 'sec_8k';
const newsFilterLabels: Record<NewsFilter, string> = { all: 'All', press: 'Press', sec_8k: 'SEC 8-K' };

const NEWS_LABELS: ResultLabels = { score: 'News tone', kinds: { supporting: 'positive', opposing: 'negative', uncertainty: 'open question' } };
const INDUSTRY_LABELS: ResultLabels = { score: 'Industry standing', kinds: { supporting: 'strength', opposing: 'weakness', uncertainty: 'watch' } };

function formatDay(value: string): string {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(value));
}
function formatUpdated(value: string): string {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(value));
}
function compactUsd(value: number | null): string {
  if (value === null) return '—';
  const absolute = Math.abs(value);
  if (absolute >= 1e12) return `$${(value / 1e12).toFixed(2)}T`;
  if (absolute >= 1e9) return `$${(value / 1e9).toFixed(1)}B`;
  if (absolute >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  return `$${Math.round(value).toLocaleString('en-US')}`;
}
function ordinal(value: number): string {
  const tens = value % 100;
  if (tens >= 11 && tens <= 13) return `${value}th`;
  return `${value}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[value % 10] ?? 'th'}`;
}
function percent(value: number | null, signed = false): string {
  if (value === null) return '—';
  const text = `${(value * 100).toFixed(1)}%`;
  return signed && value > 0 ? `+${text}` : text;
}

function Loading({ title, body }: { title: string; body: string }) {
  return <div className="state-panel" role="status" aria-live="polite"><span className="spinner" aria-hidden="true" /><div><strong>{title}</strong><p>{body}</p></div></div>;
}
function Empty({ title, body }: { title: string; body: string }) {
  return <div className="empty-state"><span aria-hidden="true">—</span><div><strong>{title}</strong><p>{body}</p></div></div>;
}

function BriefSection({ ticker, type, title, description, labels, available }: { ticker: string; type: BriefType; title: string; description: string; labels: ResultLabels; available: boolean }) {
  const [brief, setBrief] = useState<AiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [token, setToken] = useState('');
  const [reset, setReset] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    filingLensApi.getBrief(ticker, type, controller.signal)
      .then(setBrief)
      .catch((reason: ApiError) => { if (reason.name !== 'AbortError' && reason.code !== 'BRIEF_NOT_FOUND') setError(reason.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [ticker, type]);
  const generate = useCallback(async () => {
    if (!token) return;
    setSubmitting(true); setError(null);
    try { setBrief(await filingLensApi.generateBrief(ticker, type, token)); }
    catch (reason) { setError(reason instanceof ApiError ? reason.message : 'The AI summary is unavailable right now.'); }
    finally { setSubmitting(false); setToken(''); setReset((value) => value + 1); }
  }, [ticker, type, token]);
  const needsGeneration = !brief || brief.is_current === false;
  return <section className="market-brief" aria-label={title}>
    <div className="market-brief-head"><div><p className="eyebrow">AI summary</p><h4>{title}</h4></div><p>{description}</p></div>
    {loading ? <Loading title="Checking for a saved summary" body="Looking for a validated brief over the current data…" /> : brief && <>
      {brief.is_current === false && <p className="market-note" role="status">New data has arrived since this summary was generated {formatUpdated(brief.generated_at)}. Refresh it below.</p>}
      <Result response={brief} labels={labels} />
    </>}
    {!loading && available && needsGeneration && <div className="market-brief-generate">
      <TurnstileWidget onToken={setToken} resetNonce={reset} />
      <button type="button" className="analyze-button" disabled={!token || submitting} onClick={generate}>{submitting ? 'Validating…' : brief ? 'Refresh summary' : 'Generate summary'}</button>
    </div>}
    {error && <p className="analysis-error" role="alert">{error}</p>}
  </section>;
}

function NewsList({ items }: { items: NewsItem[] }) {
  return <ol className="news-list">{items.map((item) => <li className={`news-item ${item.kind}`} key={item.id}>
    <div className="news-meta"><span className={`news-kind ${item.kind}`}>{item.kind === 'sec_8k' ? 'SEC 8-K' : 'Press'}</span><span>{item.source}</span><time dateTime={item.published_at}>{formatDay(item.published_at)}</time></div>
    <a className="news-headline" href={item.url} target="_blank" rel="noreferrer noopener">{item.headline}<span aria-hidden="true"> ↗</span></a>
    {item.summary && item.kind === 'press' && <p>{item.summary}</p>}
  </li>)}</ol>;
}

export function NewsPanel({ ticker }: { ticker: string }) {
  const [feed, setFeed] = useState<NewsFeed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<NewsFilter>('all');
  useEffect(() => {
    const controller = new AbortController();
    filingLensApi.news(ticker, controller.signal)
      .then(setFeed)
      .catch((reason: ApiError) => { if (reason.name !== 'AbortError') setError(reason.message); });
    return () => controller.abort();
  }, [ticker]);
  const visible = useMemo(() => feed?.items.filter((item) => filter === 'all' || item.kind === filter) ?? [], [feed, filter]);
  if (error) return <Empty title="News is unavailable" body={error} />;
  if (!feed) return <Loading title="Loading recent news" body="Collecting press headlines and SEC 8-K announcements…" />;
  return <div className="market-panel">
    <div className="market-toolbar">
      <div className="segmented" role="group" aria-label="Filter news">{(Object.keys(newsFilterLabels) as NewsFilter[]).map((key) => <button type="button" key={key} className={filter === key ? 'active' : ''} onClick={() => setFilter(key)}>{newsFilterLabels[key]}</button>)}</div>
      <p className="market-updated">Updated {formatUpdated(feed.fetched_at)}{feed.stale ? ' · showing the last saved copy' : ''}</p>
    </div>
    {!feed.press_enabled && <p className="market-note">Press headlines aren’t connected yet, so this shows SEC 8-K announcements only.</p>}
    {visible.length ? <NewsList items={visible} /> : <Empty title="Nothing recent" body={filter === 'all' ? 'No headlines or 8-K filings in the recent window.' : `No ${newsFilterLabels[filter]} items in the recent window.`} />}
    {feed.press_enabled && <p className="market-attribution">Press headlines via <a href="https://finnhub.io" target="_blank" rel="noreferrer noopener">Finnhub</a>. 8-K announcements from SEC EDGAR.</p>}
    <BriefSection ticker={ticker} type="news" title="What the news says" description="A summary of these headlines and filings. Each statement links to the item it came from; anything that can’t be matched to its source is left out." labels={NEWS_LABELS} available={feed.items.length > 0} />
  </div>;
}

function PeerTable({ peers, year }: { peers: IndustryPeer[]; year: number }) {
  return <div className="comparison-table-wrap"><table className="comparison-table peer-table">
    <caption className="sr-only">Largest same-industry peers, calendar year {year}</caption>
    <thead><tr><th>Company</th><th>Revenue</th><th>Growth</th><th>Net margin</th><th>Op. cash-flow margin</th><th>Liabilities / assets</th><th>SEC filing</th></tr></thead>
    <tbody>{peers.map((peer) => <tr className={peer.is_subject ? 'subject' : ''} key={peer.ticker}>
      <th scope="row"><strong>{peer.ticker}</strong><span>{peer.name}</span></th>
      <td>{compactUsd(peer.revenue)}</td><td>{percent(peer.revenue_growth, true)}</td><td>{percent(peer.net_margin)}</td><td>{percent(peer.operating_cash_flow_margin)}</td><td>{percent(peer.liabilities_to_assets)}</td>
      <td>{peer.filing_url ? <a className="evidence-link" href={peer.filing_url} target="_blank" rel="noreferrer">Filing<span aria-hidden="true"> ↗</span></a> : '—'}</td>
    </tr>)}</tbody>
  </table></div>;
}

export function IndustryPanel({ ticker }: { ticker: string }) {
  const [data, setData] = useState<IndustryData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    filingLensApi.industry(ticker, controller.signal)
      .then(setData)
      .catch((reason: ApiError) => { if (reason.name !== 'AbortError') setError(reason.message); });
    return () => controller.abort();
  }, [ticker]);
  if (error) return <Empty title="Industry analysis is unavailable" body={error} />;
  if (!data) return <Loading title="Building the industry benchmark" body="Pulling same-industry companies and their latest annual figures from SEC EDGAR. The first load can take a few seconds." />;
  return <div className="market-panel">
    <div className="industry-header">
      <div><p className="eyebrow">SEC industry · SIC {data.sic}</p><h4>{data.sic_description}</h4></div>
      <p>Benchmarked against <strong>{data.sample_size}</strong> companies that report annual revenue to the SEC for calendar year {data.calendar_year}. Updated {formatUpdated(data.fetched_at)}{data.stale ? ' · showing the last saved copy' : ''}.</p>
    </div>
    <div className="metric-grid industry-metrics">{data.metrics.map((metric) => <article className="metric-card" key={metric.key}>
      <div className="metric-top"><span>{metric.name}</span>{metric.percentile !== null && <span className="unit-chip">{ordinal(metric.percentile)} pct</span>}</div>
      <strong>{metric.company_display ?? '—'}</strong>
      <p>Industry median {metric.median_display ?? 'not available'} · {metric.sample_size} companies</p>
      {metric.percentile !== null && <div className="percentile-bar" role="img" aria-label={`${data.ticker} is at the ${ordinal(metric.percentile)} percentile`}><i style={{ left: `${metric.percentile}%` }} /></div>}
    </article>)}</div>
    {data.peers.length > 1 ? <PeerTable peers={data.peers} year={data.calendar_year} /> : <Empty title="No listed peers found" body="The SEC lists no other companies with this industry code and a ticker, so only the industry medians are shown." />}
    <p className="direction-note">Percentile is the share of the industry sample at or below {data.ticker}. For liabilities to assets, a higher percentile means more leverage.</p>
    {data.peer_headlines.length > 0 && <section className="market-subsection"><h5>Recent peer headlines</h5><NewsList items={data.peer_headlines} /></section>}
    <details className="method-note"><summary>Sources and method</summary><p>Peers share the SEC Standard Industrial Classification code. Figures come from SEC XBRL frames, which align each company’s annual report to the calendar year. Revenue growth compares the same revenue concept year over year.</p><div className="source-list">{data.sources.map((source) => <a className="evidence-link" href={source.source_url} target="_blank" rel="noreferrer" key={source.source_url}>{source.label}<span aria-hidden="true"> ↗</span></a>)}</div></details>
    <BriefSection ticker={ticker} type="industry" title="How it stacks up" description="An AI read of the benchmark and peer news. Every number is copied from the figures above and checked before it’s shown." labels={INDUSTRY_LABELS} available={data.sample_size > 0} />
  </div>;
}
