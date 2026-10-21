import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IndustryPanel, NewsPanel } from './MarketPanels';
import { ApiError, filingLensApi, type AiResponse, type IndustryData, type NewsFeed } from '../lib/api';

vi.mock('../lib/api', async (loadOriginal) => {
  const original = await loadOriginal<typeof import('../lib/api')>();
  return { ...original, filingLensApi: { news: vi.fn(), industry: vi.fn(), getBrief: vi.fn(), generateBrief: vi.fn(), getStrategy: vi.fn(), generateStrategy: vi.fn() } };
});
vi.mock('./TurnstileWidget', () => ({
  TurnstileWidget: ({ onToken }: { onToken: (token: string) => void }) => <button type="button" onClick={() => onToken('verified')}>Verify</button>,
}));

const feed: NewsFeed = {
  ticker: 'TEST', press_enabled: true, fetched_at: '2026-10-21T15:00:00Z', stale: false,
  items: [
    { id: 'press-1', kind: 'press', headline: 'Test Corp raises outlook', summary: 'Sales rose 20%.', source: 'Wire', url: 'https://news.example.com/a', published_at: '2026-10-20T12:00:00Z' },
    { id: 'sec-0000000001-26-000050', kind: 'sec_8k', headline: '8-K: Results of operations and financial condition', summary: 'SEC current report items 2.02, 9.01.', source: 'SEC EDGAR', url: 'https://www.sec.gov/Archives/edgar/data/1/000000000126000050/a.htm', published_at: '2026-10-01T00:00:00Z' },
  ],
};

const industry: IndustryData = {
  ticker: 'TEST', sic: '3571', sic_description: 'Electronic Computers', calendar_year: 2025, sample_size: 4,
  fetched_at: '2026-10-21T15:00:00Z', stale: false, peer_headlines: [],
  metrics: [
    { key: 'revenue', name: 'Revenue', company_value: 120e9, company_display: '$120.00 billion', industry_median: 85e9, median_display: '$85.00 billion', percentile: 72, sample_size: 4 },
    { key: 'net_margin', name: 'Net margin', company_value: 0.25, company_display: '25.00%', industry_median: 0.15, median_display: '15.00%', percentile: 1, sample_size: 4 },
  ],
  peers: [
    { ticker: 'BIG', cik: '0000000102', name: 'Big Peer Inc', is_subject: false, revenue: 200e9, revenue_growth: 0.25, net_margin: 0.1, operating_cash_flow_margin: null, liabilities_to_assets: 0.4, filing_url: 'https://www.sec.gov/Archives/edgar/data/102/x/' },
    { ticker: 'TEST', cik: '0000000001', name: 'Test Corp', is_subject: true, revenue: 120e9, revenue_growth: 0.2, net_margin: 0.25, operating_cash_flow_margin: 0.3, liabilities_to_assets: 0.75, filing_url: null },
  ],
  sources: [{ label: 'SEC XBRL frames, revenue 2025', source_url: 'https://data.sec.gov/api/xbrl/frames/us-gaap/Revenues/USD/CY2025.json' }],
};

const brief: AiResponse = {
  response_id: 'brief-1', ticker: 'TEST', response_type: 'news', question: null, model: 'mock', prompt_version: 'filinglens-market-v1',
  generated_at: '2026-10-21T15:00:00Z', sentiment: 'bullish', confidence: 0.7, refused: false, refusal_reason: null,
  validation_status: 'passed', validation_details: {}, disclaimer: 'Not investment advice.', is_current: true,
  claims: [
    { claim_id: 'c1', claim_order: 0, kind: 'summary', text: 'Test Corp raised its outlook.', evidence_ids: ['news-press-1'] },
    { claim_id: 'c2', claim_order: 1, kind: 'supporting', text: 'Sales rose 20%.', evidence_ids: ['news-press-1'] },
  ],
  evidence: [{ evidence_id: 'news-press-1', evidence_type: 'press_headline', label: 'Wire: Test Corp raises outlook', accession_number: '', source_url: null, external_url: 'https://news.example.com/a', source_evidence_ids: [] }],
};

describe('market panels', () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(filingLensApi.getStrategy).mockRejectedValue(new ApiError('none', 404, 'BRIEF_NOT_FOUND'));
  });

  it('lists press and SEC 8-K news and filters by source', async () => {
    vi.mocked(filingLensApi.news).mockResolvedValue(feed);
    vi.mocked(filingLensApi.getBrief).mockRejectedValue(new ApiError('none', 404, 'BRIEF_NOT_FOUND'));
    render(<NewsPanel ticker="TEST" />);
    expect(await screen.findByRole('link', { name: /Test Corp raises outlook/ })).toHaveAttribute('href', 'https://news.example.com/a');
    expect(screen.getByText(/Press headlines via/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'SEC 8-K' }));
    expect(screen.queryByRole('link', { name: /Test Corp raises outlook/ })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Results of operations/ })).toHaveAttribute('href', feed.items[1].url);
  });

  it('explains when press headlines are not connected', async () => {
    vi.mocked(filingLensApi.news).mockResolvedValue({ ...feed, press_enabled: false, items: [feed.items[1]] });
    vi.mocked(filingLensApi.getBrief).mockRejectedValue(new ApiError('none', 404, 'BRIEF_NOT_FOUND'));
    render(<NewsPanel ticker="TEST" />);
    expect(await screen.findByText(/Press headlines aren’t connected yet/)).toBeInTheDocument();
  });

  it('generates a news summary after verification with news-specific labels and source links', async () => {
    vi.mocked(filingLensApi.news).mockResolvedValue(feed);
    vi.mocked(filingLensApi.getBrief).mockRejectedValue(new ApiError('none', 404, 'BRIEF_NOT_FOUND'));
    vi.mocked(filingLensApi.generateBrief).mockResolvedValue(brief);
    render(<NewsPanel ticker="TEST" />);
    const button = await screen.findByRole('button', { name: 'Generate summary' });
    expect(button).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    fireEvent.click(button);
    await waitFor(() => expect(filingLensApi.generateBrief).toHaveBeenCalledWith('TEST', 'news', 'verified'));
    expect(await screen.findByText('Sales rose 20%.', { selector: '.ai-claim p' })).toBeInTheDocument();
    expect(screen.getByText('positive')).toBeInTheDocument();
    expect(screen.getByText('News tone')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /Wire: Test Corp raises outlook · source/ })[0]).toHaveAttribute('href', 'https://news.example.com/a');
  });

  it('flags a saved summary that predates new data and offers a refresh', async () => {
    vi.mocked(filingLensApi.news).mockResolvedValue(feed);
    vi.mocked(filingLensApi.getBrief).mockResolvedValue({ ...brief, is_current: false });
    render(<NewsPanel ticker="TEST" />);
    expect(await screen.findByText(/New data has arrived since this summary was generated/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh summary' })).toBeInTheDocument();
  });

  it('shows the industry benchmark, percentile ranks, and the peer table', async () => {
    vi.mocked(filingLensApi.industry).mockResolvedValue(industry);
    vi.mocked(filingLensApi.getBrief).mockRejectedValue(new ApiError('none', 404, 'BRIEF_NOT_FOUND'));
    render(<IndustryPanel ticker="TEST" />);
    expect(await screen.findByRole('heading', { name: 'Electronic Computers' })).toBeInTheDocument();
    expect(screen.getByText('72nd pct')).toBeInTheDocument();
    expect(screen.getByText('1st pct')).toBeInTheDocument();
    expect(screen.getByText(/Industry median \$85.00 billion/)).toBeInTheDocument();
    const table = screen.getByRole('table');
    const subjectRow = within(table).getByText('TEST').closest('tr');
    expect(subjectRow).toHaveClass('subject');
    expect(within(table).getByText('$200.0B')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /SEC XBRL frames, revenue 2025/ })).toHaveAttribute('href', industry.sources[0].source_url);
  });

  it('shows the API message when industry data is unavailable', async () => {
    vi.mocked(filingLensApi.industry).mockRejectedValue(new ApiError('Live market data is temporarily unavailable.', 503, 'MARKET_DATA_UNAVAILABLE'));
    render(<IndustryPanel ticker="TEST" />);
    expect(await screen.findByText('Live market data is temporarily unavailable.')).toBeInTheDocument();
  });
});
