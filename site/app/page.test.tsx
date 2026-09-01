import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Home from './page';
import { filingLensApi, loadFilingData } from '../lib/api';

vi.mock('../lib/api', async (loadOriginal) => {
  const original = await loadOriginal<typeof import('../lib/api')>();
  return {
    ...original,
    filingLensApi: { companies: vi.fn(), company: vi.fn(), filings: vi.fn() },
    loadFilingData: vi.fn(),
  };
});

const companies = [
  { ticker: 'AAPL', cik: '0000320193', name: 'Apple Inc.' },
  { ticker: 'MSFT', cik: '0000789019', name: 'MICROSOFT CORP' },
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

  it('searches and switches to another pilot ticker', async () => {
    render(<Home />);
    await screen.findByRole('heading', { name: 'Apple' });
    fireEvent.change(screen.getByLabelText('Search the pilot'), { target: { value: 'micro' } });
    fireEvent.click(screen.getByRole('button', { name: /MSFTMICROSOFT/i }));
    await waitFor(() => expect(filingLensApi.company).toHaveBeenCalledWith('MSFT', expect.any(AbortSignal)));
    expect(await screen.findByRole('heading', { name: 'MICROSOFT' })).toBeInTheDocument();
  });
});
