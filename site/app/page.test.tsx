import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Home from './page';
import { filingLensApi, loadFilingData } from '../lib/api';

vi.mock('../lib/api', async (loadOriginal) => {
  const original = await loadOriginal<typeof import('../lib/api')>();
  return {
    ...original,
    filingLensApi: { companies: vi.fn(), searchTickers: vi.fn(), company: vi.fn(), filings: vi.fn(), requestAnalysis: vi.fn(), analysisStatus: vi.fn(), retryAnalysis: vi.fn() },
    loadFilingData: vi.fn(),
  };
});
vi.mock('./TurnstileWidget', () => ({
  TurnstileWidget: ({ onToken }: { onToken: (token: string) => void }) =>
    <button type="button" onClick={() => onToken('verified-token')}>Complete verification</button>,
}));

const companies = [
  { ticker: 'AAPL', cik: '0000320193', name: 'Apple Inc.', availability: 'available' as const, is_processed: true },
  { ticker: 'MSFT', cik: '0000789019', name: 'MICROSOFT CORP', availability: 'available' as const, is_processed: true },
];
const filings = [{
  accession_number: '0000320193-26-000020', form: '10-Q' as const,
  filing_date: '2026-07-31', report_date: '2026-06-27', primary_document: 'aapl.htm',
  official_url: 'https://www.sec.gov/aapl.htm', filing_index_url: 'https://www.sec.gov/aapl-index.htm',
}];
const data = {
  financials: { accession_number: filings[0].accession_number, facts: [{ key: 'revenue', name: 'Revenue', value: 1, formatted_value: '$1.00 billion', unit: 'USD', taxonomy: 'us-gaap', concept: 'Revenues', sec_label: 'Revenue', period_type: 'duration' as const, period_start: '2026-01-01', period_end: '2026-06-27', fiscal_year: 2026, fiscal_period: 'Q2', filed: '2026-07-31', sec_concept_url: 'https://data.sec.gov/revenue', evidence_id: 'fact' }], evidence: [{ evidence_id: 'fact', evidence_type: 'xbrl_fact', label: 'Revenue', accession_number: filings[0].accession_number, source_url: 'https://data.sec.gov/revenue', source_evidence_ids: [] }] },
  ratios: { accession_number: filings[0].accession_number, ratios: [], evidence: [] },
  comparisons: { accession_number: filings[0].accession_number, comparisons: [], evidence: [] },
  risks: { accession_number: filings[0].accession_number, risks: [{ passages: [], comparisons: [] }], evidence: [] },
};

describe('multi-company dashboard', () => {
  afterEach(cleanup);

  beforeEach(() => {
    vi.mocked(filingLensApi.companies).mockResolvedValue(companies);
    vi.mocked(filingLensApi.searchTickers).mockImplementation(async (query) =>
      companies.filter((item) => `${item.ticker} ${item.name}`.toLowerCase().includes(query.toLowerCase())),
    );
    vi.mocked(filingLensApi.company).mockImplementation(async (ticker) => ({
      ...companies.find((item) => item.ticker === ticker)!,
      filing_count: 1,
      latest_filing_date: '2026-07-31',
      refresh_status: 'up_to_date',
      last_checked_at: '2026-08-31T12:00:00Z',
      last_success_at: '2026-08-31T12:00:00Z',
      latest_refresh_accession: filings[0].accession_number,
      refresh_message: 'Stored filings match the latest SEC submissions.',
    }));
    vi.mocked(filingLensApi.filings).mockResolvedValue(filings);
    vi.mocked(loadFilingData).mockResolvedValue(data);
  });

  it('renders a live company filing with inspectable SEC evidence', async () => {
    render(<Home />);
    expect(await screen.findByRole('heading', { name: 'Apple' })).toBeInTheDocument();
    expect(await screen.findByText('$1.00B')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Inspect evidence'));
    expect(screen.getByRole('link', { name: /Revenue/ })).toHaveAttribute('href', 'https://data.sec.gov/revenue');
    expect(screen.getByText('Up to date')).toBeInTheDocument();
  });

  it('searches the SEC directory and switches to an analyzed ticker', async () => {
    render(<Home />);
    await screen.findByRole('heading', { name: 'Apple' });
    fireEvent.change(screen.getByLabelText('Search any SEC ticker'), { target: { value: 'micro' } });
    fireEvent.click(await screen.findByRole('button', { name: /MSFT.*available/i }));
    await waitFor(() => expect(filingLensApi.company).toHaveBeenCalledWith('MSFT', expect.any(AbortSignal)));
    expect(await screen.findByRole('heading', { name: 'MICROSOFT' })).toBeInTheDocument();
  });

  it('clearly marks a discovered company that still requires analysis', async () => {
    vi.mocked(filingLensApi.searchTickers).mockResolvedValue([{
      ticker: 'AMZN', cik: '0001018724', name: 'Amazon.com, Inc.',
      availability: 'requires_analysis', is_processed: false, filing_count: 0,
    }]);
    render(<Home />);
    await screen.findByRole('heading', { name: 'Apple' });
    fireEvent.change(screen.getByLabelText('Search any SEC ticker'), { target: { value: 'AMZN' } });
    fireEvent.click(await screen.findByRole('button', { name: /AMZN.*analysis required/i }));
    expect(await screen.findByText(/has not published analysis for this company/i)).toBeInTheDocument();
    expect(filingLensApi.company).not.toHaveBeenCalledWith('AMZN', expect.anything());
  });

  it('submits a protected analysis request and shows non-blocking progress', async () => {
    vi.mocked(filingLensApi.searchTickers).mockResolvedValue([{
      ticker: 'AMZN', cik: '0001018724', name: 'Amazon.com, Inc.',
      availability: 'requires_analysis', is_processed: false, filing_count: 0,
    }]);
    vi.mocked(filingLensApi.requestAnalysis).mockResolvedValue({
      job_id: '11111111-1111-4111-8111-111111111111', ticker: 'AMZN', cik: '0001018724',
      company_name: 'Amazon.com, Inc.', status: 'queued', attempt_count: 0, max_attempts: 3,
      requested_at: '2026-08-31T12:00:00Z', started_at: null, completed_at: null,
      updated_at: '2026-08-31T12:00:00Z', message: 'Waiting for background processing.',
      error_code: null, can_retry: false,
    });
    render(<Home />);
    await screen.findByRole('heading', { name: 'Apple' });
    fireEvent.change(screen.getByLabelText('Search any SEC ticker'), { target: { value: 'AMZN' } });
    fireEvent.click(await screen.findByRole('button', { name: /AMZN.*analysis required/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Complete verification' }));
    fireEvent.click(screen.getByRole('button', { name: 'Analyze AMZN' }));
    expect(await screen.findByText('Queued')).toBeInTheDocument();
    expect(screen.getByText('Waiting for background processing.')).toBeInTheDocument();
    expect(filingLensApi.requestAnalysis).toHaveBeenCalledWith('AMZN', 'verified-token');
  });
});
