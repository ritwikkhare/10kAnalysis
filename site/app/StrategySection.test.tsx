import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrategySection } from './StrategySection';
import { ApiError, filingLensApi, type StrategyBrief } from '../lib/api';

vi.mock('../lib/api', async (loadOriginal) => {
  const original = await loadOriginal<typeof import('../lib/api')>();
  return { ...original, filingLensApi: { getStrategy: vi.fn(), generateStrategy: vi.fn() } };
});
vi.mock('./TurnstileWidget', () => ({
  TurnstileWidget: ({ onToken }: { onToken: (token: string) => void }) => <button type="button" onClick={() => onToken('verified')}>Verify</button>,
}));

const brief: StrategyBrief = {
  response_id: 'strategy-1', ticker: 'TEST', response_type: 'strategy', model: 'mock', prompt_version: 'filinglens-strategy-v1',
  generated_at: '2026-10-21T15:00:00Z', is_current: true, disclaimer: 'Not investment advice.', validation_details: { rejected_claim_count: 2 },
  analysis: {
    overview: [{ text: 'TEST leads its industry on net margin.', evidence_ids: ['industry-net_margin'] }],
    five_forces: [
      { key: 'rivalry', name: 'Competitive rivalry', rating: 'high', claims: [{ text: 'Intense competition pressures pricing.', evidence_ids: ['risk-1'] }] },
      { key: 'new_entrants', name: 'Threat of new entrants', rating: 'unclear', claims: [] },
      { key: 'substitutes', name: 'Threat of substitutes', rating: 'unclear', claims: [] },
      { key: 'supplier_power', name: 'Supplier power', rating: 'medium', claims: [{ text: 'Tariffs raise component costs.', evidence_ids: ['news-press-1'] }] },
      { key: 'buyer_power', name: 'Buyer power', rating: 'low', claims: [{ text: 'Demand stayed strong.', evidence_ids: ['news-press-1'] }] },
    ],
    pest: [
      { key: 'political', name: 'Political', claims: [{ text: 'New tariffs affect imports.', evidence_ids: ['news-press-1'] }] },
      { key: 'economic', name: 'Economic', claims: [] },
      { key: 'social', name: 'Social', claims: [] },
      { key: 'technological', name: 'Technological', claims: [] },
    ],
  },
  evidence: [
    { evidence_id: 'industry-net_margin', evidence_type: 'industry_benchmark', label: 'Net margin versus industry', accession_number: '', source_url: 'https://data.sec.gov/api/xbrl/frames/us-gaap/NetIncomeLoss/USD/CY2025.json', external_url: null, source_evidence_ids: [] },
    { evidence_id: 'risk-1', evidence_type: 'risk_factor', label: '10-K risk factor 1', accession_number: '0000000001-25-000099', source_url: 'https://www.sec.gov/Archives/edgar/data/1/x.htm#risk-1', external_url: null, source_evidence_ids: [] },
    { evidence_id: 'news-press-1', evidence_type: 'press_headline', label: 'Wire: Tariffs hit suppliers', accession_number: '', source_url: null, external_url: 'https://news.example.com/a', source_evidence_ids: [] },
  ],
};

describe('industry analysis, Five Forces, and PEST', () => {
  afterEach(cleanup);
  beforeEach(() => vi.clearAllMocks());

  it('generates the analysis after verification and renders every framework with sources', async () => {
    vi.mocked(filingLensApi.getStrategy).mockRejectedValue(new ApiError('none', 404, 'BRIEF_NOT_FOUND'));
    vi.mocked(filingLensApi.generateStrategy).mockResolvedValue(brief);
    render(<StrategySection ticker="TEST" />);
    const button = await screen.findByRole('button', { name: 'Generate industry analysis' });
    expect(button).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    fireEvent.click(button);
    await waitFor(() => expect(filingLensApi.generateStrategy).toHaveBeenCalledWith('TEST', 'verified'));
    expect(await screen.findByText('TEST leads its industry on net margin.')).toBeInTheDocument();
    const rivalry = screen.getByRole('heading', { name: 'Competitive rivalry' }).closest('article')!;
    expect(within(rivalry).getByText('High pressure')).toBeInTheDocument();
    expect(within(rivalry).getByRole('link', { name: /10-K risk factor 1 · SEC/ })).toHaveAttribute('href', 'https://www.sec.gov/Archives/edgar/data/1/x.htm#risk-1');
    const entrants = screen.getByRole('heading', { name: 'Threat of new entrants' }).closest('article')!;
    expect(within(entrants).getByText('Not enough evidence')).toBeInTheDocument();
    expect(within(entrants).getByText('No recent source speaks to this force.')).toBeInTheDocument();
    const political = screen.getByRole('heading', { name: 'Political' }).closest('article')!;
    expect(within(political).getByRole('link', { name: /Wire: Tariffs hit suppliers · source/ })).toHaveAttribute('href', 'https://news.example.com/a');
    expect(screen.getByText(/2 generated statements were left out/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Generate industry analysis|Refresh analysis/ })).not.toBeInTheDocument();
  });

  it('offers a refresh when newer headlines have arrived', async () => {
    vi.mocked(filingLensApi.getStrategy).mockResolvedValue({ ...brief, is_current: false });
    render(<StrategySection ticker="TEST" />);
    expect(await screen.findByText(/Newer headlines or data have arrived/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh analysis' })).toBeInTheDocument();
  });

  it('shows the API explanation when the analysis cannot be verified', async () => {
    vi.mocked(filingLensApi.getStrategy).mockRejectedValue(new ApiError('none', 404, 'BRIEF_NOT_FOUND'));
    vi.mocked(filingLensApi.generateStrategy).mockRejectedValue(new ApiError("FilingLens couldn't verify enough of the generated analysis.", 422, 'AI_BRIEF_UNVERIFIED'));
    render(<StrategySection ticker="TEST" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Verify' }));
    fireEvent.click(screen.getByRole('button', { name: 'Generate industry analysis' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("couldn't verify enough");
  });
});
