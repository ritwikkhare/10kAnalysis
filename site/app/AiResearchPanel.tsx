'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError, directEvidence, filingLensApi, type AiClaim, type AiResponse } from '../lib/api';
import { TurnstileWidget } from './TurnstileWidget';

function ClaimCard({ claim, response }: { claim: AiClaim; response: AiResponse }) {
  const sources = claim.evidence_ids.flatMap((id) => directEvidence(response.evidence, id));
  const unique = [...new Map(sources.map((source) => [source.evidence_id, source])).values()];
  return <article className={`ai-claim ${claim.kind}`}><span>{claim.kind}</span><p>{claim.text}</p><div className="ai-citations">{unique.map((source) => <a href={source.source_url!} target="_blank" rel="noreferrer" key={source.evidence_id}>{source.label} · SEC ↗</a>)}</div></article>;
}

function Result({ response }: { response: AiResponse }) {
  if (response.refused) return <div className="ai-refusal" role="status"><strong>Filing evidence is insufficient</strong><p>{response.refusal_reason}</p></div>;
  return <><div className="ai-score"><div><span>Filing sentiment</span><strong className={response.sentiment}>{response.sentiment}</strong></div><div><span>Confidence</span><strong>{Math.round(response.confidence * 100)}%</strong></div><div><span>Validation</span><strong>Evidence passed</strong></div></div><div className="ai-claims">{response.claims.map((claim) => <ClaimCard claim={claim} response={response} key={claim.claim_id} />)}</div><details className="method-note"><summary>Model and audit record</summary><p>{response.model} · prompt {response.prompt_version} · generated {new Date(response.generated_at).toLocaleString()}</p></details></>;
}

export function AiResearchPanel({ ticker }: { ticker: string }) {
  const [analysis, setAnalysis] = useState<AiResponse | null>(null);
  const [answer, setAnswer] = useState<AiResponse | null>(null);
  const [question, setQuestion] = useState('');
  const [token, setToken] = useState('');
  const [reset, setReset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clearChallenge = () => { setToken(''); setReset((value) => value + 1); };
  useEffect(() => {
    const controller = new AbortController();
    filingLensApi.getAiAnalysis(ticker, controller.signal)
      .then(setAnalysis)
      .catch((reason: ApiError) => { if (reason.name !== 'AbortError' && reason.code !== 'AI_ANALYSIS_NOT_FOUND') setError(reason.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [ticker]);
  const generate = useCallback(async () => {
    if (!token) return;
    setSubmitting(true); setError(null);
    try { setAnalysis(await filingLensApi.generateAiAnalysis(ticker, token)); }
    catch (reason) { setError(reason instanceof ApiError ? reason.message : 'AI filing analysis is unavailable.'); }
    finally { setSubmitting(false); clearChallenge(); }
  }, [ticker, token]);
  const ask = useCallback(async () => {
    if (!token || !question.trim()) return;
    setSubmitting(true); setError(null); setAnswer(null);
    try { setAnswer(await filingLensApi.askAiQuestion(ticker, question.trim(), token)); }
    catch (reason) { setError(reason instanceof ApiError ? reason.message : 'The filing question could not be answered.'); }
    finally { setSubmitting(false); clearChallenge(); }
  }, [question, ticker, token]);
  if (loading) return <div className="state-panel"><span className="spinner" aria-hidden="true" /><div><strong>Loading validated AI research</strong><p>Checking for a cached, evidence-grounded response…</p></div></div>;
  return <div className="ai-panel"><div className="ai-warning"><strong>Filing interpretation—not a stock forecast.</strong><p>Sentiment describes disclosed business conditions. It is not investment advice, a price target, or a buy/sell recommendation.</p></div>{analysis ? <Result response={analysis} /> : <div className="ai-generate"><h4>Create a grounded filing brief</h4><p>The model receives only a bounded packet of validated FilingLens facts and risk changes. Any uncited output is rejected.</p><TurnstileWidget onToken={setToken} resetNonce={reset} /><button type="button" className="analyze-button" disabled={!token || submitting} onClick={generate}>{submitting ? 'Validating…' : 'Generate filing analysis'}</button></div>}{analysis && <section className="ai-qa"><h4>Ask the filings</h4><p>Questions are answered only from the company’s stored SEC evidence.</p><textarea aria-label="Ask a filing question" maxLength={500} value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="What changed in revenue and disclosed risks?" /><TurnstileWidget onToken={setToken} resetNonce={reset} /><button type="button" className="analyze-button" disabled={!token || !question.trim() || submitting} onClick={ask}>{submitting ? 'Checking evidence…' : 'Ask question'}</button>{answer && <div className="ai-answer"><Result response={answer} /></div>}</section>}{error && <p className="analysis-error" role="alert">{error}</p>}</div>;
}
