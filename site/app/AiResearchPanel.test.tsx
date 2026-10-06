import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiResearchPanel } from './AiResearchPanel';
import { ApiError, filingLensApi, type AiResponse } from '../lib/api';

vi.mock('../lib/api', async (loadOriginal) => {
  const original = await loadOriginal<typeof import('../lib/api')>();
  return { ...original, filingLensApi: { getAiAnalysis: vi.fn(), generateAiAnalysis: vi.fn(), askAiQuestion: vi.fn() } };
});
vi.mock('./TurnstileWidget', () => ({
  TurnstileWidget: ({ onToken }: { onToken: (token: string) => void }) => <button type="button" onClick={() => onToken('verified')}>Verify</button>,
}));

const response: AiResponse = {
  response_id: 'ai-test', ticker: 'TEST', response_type: 'analysis', question: null,
  model: 'mock', prompt_version: 'v1', generated_at: '2026-09-22T12:00:00Z',
  sentiment: 'bullish', confidence: 0.8, refused: false, refusal_reason: null,
  validation_status: 'passed', validation_details: { citation_validity: 1 },
  claims: [{ claim_id: 'claim-1', claim_order: 0, kind: 'summary', text: 'Revenue increased 20%.', evidence_ids: ['fact-1'] }],
  evidence: [{ evidence_id: 'fact-1', evidence_type: 'xbrl_fact', label: 'Revenue', accession_number: '0000000001-26-000001', source_url: 'https://data.sec.gov/revenue', source_evidence_ids: [] }],
  disclaimer: 'Not investment advice.',
};

describe('AI research panel', () => {
  afterEach(cleanup);
  beforeEach(() => vi.clearAllMocks());

  it('renders cached sentiment with its clickable SEC evidence and boundary label', async () => {
    vi.mocked(filingLensApi.getAiAnalysis).mockResolvedValue(response);
    render(<AiResearchPanel ticker="TEST" />);
    expect(await screen.findByText('Revenue increased 20%.')).toBeInTheDocument();
    expect(screen.getByText('Filing interpretation—not a stock forecast.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Revenue · SEC/ })).toHaveAttribute('href', 'https://data.sec.gov/revenue');
  });

  it('generates an analysis only after verification', async () => {
    vi.mocked(filingLensApi.getAiAnalysis).mockRejectedValue(new ApiError('missing', 404, 'AI_ANALYSIS_NOT_FOUND'));
    vi.mocked(filingLensApi.generateAiAnalysis).mockResolvedValue(response);
    render(<AiResearchPanel ticker="TEST" />);
    const button = await screen.findByRole('button', { name: 'Generate filing analysis' });
    expect(button).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    fireEvent.click(button);
    await waitFor(() => expect(filingLensApi.generateAiAnalysis).toHaveBeenCalledWith('TEST', 'verified'));
    expect(await screen.findByText('Revenue increased 20%.')).toBeInTheDocument();
  });

  it('shows a grounded refusal rather than inventing an answer', async () => {
    vi.mocked(filingLensApi.getAiAnalysis).mockResolvedValue(response);
    vi.mocked(filingLensApi.askAiQuestion).mockResolvedValue({ ...response, response_type: 'qa', refused: true, sentiment: 'neutral', confidence: 0.1, claims: [], refusal_reason: 'The filings do not support that conclusion.' });
    render(<AiResearchPanel ticker="TEST" />);
    await screen.findByText('Revenue increased 20%.');
    fireEvent.change(screen.getByLabelText('Ask a filing question'), { target: { value: 'Predict the price' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ask question' }));
    expect(await screen.findByText('Filing evidence is insufficient')).toBeInTheDocument();
    expect(screen.getByText('The filings do not support that conclusion.')).toBeInTheDocument();
  });
});
