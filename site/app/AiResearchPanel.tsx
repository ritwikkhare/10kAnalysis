'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError, directEvidence, filingLensApi, type AiClaim, type AiResponse } from '../lib/api';
import { TurnstileWidget } from './TurnstileWidget';

const EXAMPLE_QUESTIONS = [
  'How did revenue change from the prior year?',
  'How profitable is the company?',
  'How much debt does it carry relative to assets?',
  'Which risk factors changed?',
];

export type ResultLabels = { score?: string; kinds?: Partial<Record<AiClaim['kind'], string>> };

export function ClaimCard({ claim, response, labels }: { claim: AiClaim; response: AiResponse; labels?: ResultLabels }) {
  const sources = claim.evidence_ids.flatMap((id) => directEvidence(response.evidence, id));
  const unique = [...new Map(sources.map((source) => [source.evidence_id, source])).values()];
  return <article className={`ai-claim ${claim.kind}`}><span>{labels?.kinds?.[claim.kind] ?? claim.kind}</span><p>{claim.text}</p><div className="ai-citations">{unique.map((source) => <a href={source.source_url ?? source.external_url ?? undefined} target="_blank" rel="noreferrer noopener" key={source.evidence_id}>{source.label} · {source.source_url ? 'SEC' : 'source'} ↗</a>)}</div></article>;
}

export function Result({ response, labels }: { response: AiResponse; labels?: ResultLabels }) {
  if (response.refused) return <div className="ai-refusal" role="status"><strong>Filing evidence is insufficient</strong><p>{response.refusal_reason}</p></div>;
  const removed = Number(response.validation_details.rejected_claim_count ?? 0);
  const isAnswer = response.response_type === 'qa';
  return <>
    {!isAnswer && <div className="ai-score"><div><span>{labels?.score ?? 'Filing sentiment'}</span><strong className={response.sentiment}>{response.sentiment}</strong></div><div><span>Confidence</span><strong>{Math.round(response.confidence * 100)}%</strong></div><div><span>Validation</span><strong>Evidence passed</strong></div></div>}
    <div className="ai-claims">{response.claims.map((claim) => <ClaimCard claim={claim} response={response} labels={labels} key={claim.claim_id} />)}</div>
    {removed > 0 && <p className="ai-removed-note">{removed === 1 ? 'One generated statement was' : `${removed} generated statements were`} left out because {removed === 1 ? 'it' : 'they'} could not be verified against the cited {response.response_type === 'qa' || response.response_type === 'analysis' ? 'SEC evidence' : 'sources'}.</p>}
    <details className="method-note"><summary>Model and audit record</summary><p>{response.model} · prompt {response.prompt_version} · generated {new Date(response.generated_at).toLocaleString()}</p></details>
  </>;
}

export function AiResearchPanel({ ticker }: { ticker: string }) {
  const [analysis, setAnalysis] = useState<AiResponse | null>(null);
  const [answer, setAnswer] = useState<AiResponse | null>(null);
  const [question, setQuestion] = useState('');
  const [token, setToken] = useState('');
  const [reset, setReset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState<'analysis' | 'question' | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [questionError, setQuestionError] = useState<string | null>(null);
  const clearChallenge = () => { setToken(''); setReset((value) => value + 1); };
  useEffect(() => {
    const controller = new AbortController();
    filingLensApi.getAiAnalysis(ticker, controller.signal)
      .then(setAnalysis)
      .catch((reason: ApiError) => { if (reason.name !== 'AbortError' && reason.code !== 'AI_ANALYSIS_NOT_FOUND') setAnalysisError(reason.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [ticker]);
  const generate = useCallback(async () => {
    if (!token) return;
    setSubmitting('analysis'); setAnalysisError(null);
    try { setAnalysis(await filingLensApi.generateAiAnalysis(ticker, token)); }
    catch (reason) { setAnalysisError(reason instanceof ApiError ? reason.message : 'AI filing analysis is unavailable.'); }
    finally { setSubmitting(null); clearChallenge(); }
  }, [ticker, token]);
  const ask = useCallback(async () => {
    if (!token || !question.trim()) return;
    setSubmitting('question'); setQuestionError(null); setAnswer(null);
    try { setAnswer(await filingLensApi.askAiQuestion(ticker, question.trim(), token)); }
    catch (reason) { setQuestionError(reason instanceof ApiError ? reason.message : 'The filing question could not be answered.'); }
    finally { setSubmitting(null); clearChallenge(); }
  }, [question, ticker, token]);
  if (loading) return <div className="state-panel"><span className="spinner" aria-hidden="true" /><div><strong>Loading validated AI research</strong><p>Checking for a cached, evidence-grounded response…</p></div></div>;
  const busy = submitting !== null;
  return <div className="ai-panel">
    <div className="ai-warning"><strong>Filing interpretation—not a stock forecast.</strong><p>Sentiment describes disclosed business conditions. It is not investment advice, a price target, or a buy/sell recommendation.</p></div>
    <div className="ai-verify"><p>Verify once to generate the brief or ask a question. Each request uses a fresh check.</p><TurnstileWidget onToken={setToken} resetNonce={reset} /></div>
    {analysis ? <Result response={analysis} /> : <div className="ai-generate"><h4>Create a grounded filing brief</h4><p>The model receives only a bounded packet of validated FilingLens facts and risk changes. Any uncited output is rejected.</p><button type="button" className="analyze-button" disabled={!token || busy} onClick={generate}>{submitting === 'analysis' ? 'Validating…' : 'Generate filing analysis'}</button>{analysisError && <p className="analysis-error" role="alert">{analysisError}</p>}</div>}
    {analysis && analysisError && <p className="analysis-error" role="alert">{analysisError}</p>}
    <section className="ai-qa">
      <h4>Ask the filings</h4>
      <p>Answers use only this company’s stored SEC evidence. Each statement is checked against its citation, and anything that can’t be verified is left out.</p>
      <div className="ai-examples" aria-label="Example questions">{EXAMPLE_QUESTIONS.map((example) => <button type="button" key={example} onClick={() => setQuestion(example)}>{example}</button>)}</div>
      <textarea aria-label="Ask a filing question" maxLength={500} value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) ask(); }} placeholder="What changed in revenue and disclosed risks?" />
      <button type="button" className="analyze-button" disabled={!token || !question.trim() || busy} onClick={ask}>{submitting === 'question' ? 'Checking evidence…' : 'Ask question'}</button>
      {!token && question.trim() && <p className="challenge-note">Complete the verification above to ask.</p>}
      {questionError && <p className="analysis-error" role="alert">{questionError}</p>}
      {answer && <div className="ai-answer">{answer.question && <p className="ai-asked">“{answer.question}”</p>}<Result response={answer} /></div>}
    </section>
  </div>;
}
