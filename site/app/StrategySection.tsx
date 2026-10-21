'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError, directEvidence, filingLensApi, type Evidence, type ForceRating, type StrategyBrief, type StrategyClaim } from '../lib/api';
import { TurnstileWidget } from './TurnstileWidget';

const RATING_LABELS: Record<ForceRating, string> = {
  low: 'Low pressure',
  medium: 'Medium pressure',
  high: 'High pressure',
  unclear: 'Not enough evidence',
};

function CitedClaim({ claim, evidence }: { claim: StrategyClaim; evidence: Evidence[] }) {
  const sources = [...new Map(claim.evidence_ids.flatMap((id) => directEvidence(evidence, id)).map((source) => [source.evidence_id, source])).values()];
  return <li className="strategy-claim">
    <p>{claim.text}</p>
    <div className="ai-citations">{sources.map((source) => <a href={source.source_url ?? source.external_url ?? undefined} target="_blank" rel="noreferrer noopener" key={source.evidence_id}>{source.label} · {source.source_url ? 'SEC' : 'source'} ↗</a>)}</div>
  </li>;
}

function Claims({ claims, evidence, empty }: { claims: StrategyClaim[]; evidence: Evidence[]; empty: string }) {
  if (!claims.length) return <p className="strategy-empty">{empty}</p>;
  return <ul className="strategy-claims">{claims.map((claim, index) => <CitedClaim claim={claim} evidence={evidence} key={`${index}-${claim.text.slice(0, 24)}`} />)}</ul>;
}

function Analysis({ brief }: { brief: StrategyBrief }) {
  const { analysis, evidence } = brief;
  const removed = Number(brief.validation_details.rejected_claim_count ?? 0);
  return <div className="strategy-body">
    <section className="strategy-block">
      <h5>Industry overview</h5>
      <Claims claims={analysis.overview} evidence={evidence} empty="No verified overview statements." />
    </section>
    <section className="strategy-block">
      <h5>Porter’s Five Forces</h5>
      <div className="forces-grid">{analysis.five_forces.map((force) => <article className={`force-card ${force.rating}`} key={force.key}>
        <div className="force-head"><h6>{force.name}</h6><span className={`force-rating ${force.rating}`}>{RATING_LABELS[force.rating]}</span></div>
        <Claims claims={force.claims} evidence={evidence} empty="No recent source speaks to this force." />
      </article>)}</div>
    </section>
    <section className="strategy-block">
      <h5>PEST analysis</h5>
      <div className="pest-grid">{analysis.pest.map((factor) => <article className="pest-card" key={factor.key}>
        <h6>{factor.name}</h6>
        <Claims claims={factor.claims} evidence={evidence} empty="No recent source speaks to this factor." />
      </article>)}</div>
    </section>
    {removed > 0 && <p className="ai-removed-note">{removed === 1 ? 'One generated statement was' : `${removed} generated statements were`} left out because {removed === 1 ? 'it' : 'they'} could not be verified against the cited sources.</p>}
    <details className="method-note"><summary>Method and audit record</summary><p>Built from the most recent company and peer headlines, recent 8-K filings, the company’s latest 10-K risk factors, and the SEC peer benchmark above. Ratings describe pressure on the company’s profitability and appear only when a verified statement supports them. {brief.model} · prompt {brief.prompt_version} · generated {new Date(brief.generated_at).toLocaleString()}</p></details>
  </div>;
}

export function StrategySection({ ticker }: { ticker: string }) {
  const [brief, setBrief] = useState<StrategyBrief | null>(null);
  const [loading, setLoading] = useState(true);
  const [token, setToken] = useState('');
  const [reset, setReset] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    filingLensApi.getStrategy(ticker, controller.signal)
      .then(setBrief)
      .catch((reason: ApiError) => { if (reason.name !== 'AbortError' && reason.code !== 'BRIEF_NOT_FOUND') setError(reason.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [ticker]);
  const generate = useCallback(async () => {
    if (!token) return;
    setSubmitting(true); setError(null);
    try { setBrief(await filingLensApi.generateStrategy(ticker, token)); }
    catch (reason) { setError(reason instanceof ApiError ? reason.message : 'The industry analysis is unavailable right now.'); }
    finally { setSubmitting(false); setToken(''); setReset((value) => value + 1); }
  }, [ticker, token]);
  return <section className="strategy-section" aria-label="Industry analysis and strategic frameworks">
    <div className="market-brief-head"><div><p className="eyebrow">AI industry analysis</p><h4>Industry analysis, Five Forces &amp; PEST</h4></div><p>Written from the latest headlines, 8-K filings, 10-K risk factors, and the peer benchmark. Each statement links to its source, and anything that can’t be verified is left out.</p></div>
    {loading
      ? <div className="state-panel" role="status"><span className="spinner" aria-hidden="true" /><div><strong>Checking for a saved analysis</strong><p>Looking for a validated analysis over the current data…</p></div></div>
      : brief && <>
        {!brief.is_current && <p className="market-note" role="status">Newer headlines or data have arrived since this analysis was generated. Refresh it below.</p>}
        <Analysis brief={brief} />
      </>}
    {!loading && (!brief || !brief.is_current) && <div className="market-brief-generate">
      <TurnstileWidget onToken={setToken} resetNonce={reset} />
      <button type="button" className="analyze-button" disabled={!token || submitting} onClick={generate}>{submitting ? 'Analyzing… this can take up to 30 seconds' : brief ? 'Refresh analysis' : 'Generate industry analysis'}</button>
    </div>}
    {error && <p className="analysis-error" role="alert">{error}</p>}
  </section>;
}
