import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, DEFAULT_API_BASE, directEvidence, filingLensApi, loadFilingData, type Evidence } from './api';

function reply(data: unknown, status = 200, schemaVersion = '1.0.0') {
  return new Response(JSON.stringify({ schema_version: schemaVersion, data, meta: {} }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('FilingLens API client', () => {
  it('loads and validates the versioned ticker response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply([{ ticker: 'AAPL', cik: '0000320193', name: 'Apple Inc.' }]));
    vi.stubGlobal('fetch', fetchMock);
    await expect(filingLensApi.companies()).resolves.toEqual([{ ticker: 'AAPL', cik: '0000320193', name: 'Apple Inc.' }]);
    expect(fetchMock).toHaveBeenCalledWith(`${DEFAULT_API_BASE}/tickers?q=`, expect.objectContaining({ headers: { accept: 'application/json' } }));
  });

  it('searches the complete SEC directory with an encoded query', async () => {
    const result = [{
      ticker: 'GOOG', cik: '0001652044', name: 'Alphabet Inc.',
      is_processed: false, availability: 'requires_analysis', filing_count: 0,
    }];
    const fetchMock = vi.fn().mockResolvedValue(reply(result));
    vi.stubGlobal('fetch', fetchMock);
    await expect(filingLensApi.searchTickers('alpha bet')).resolves.toEqual(result);
    expect(fetchMock).toHaveBeenCalledWith(
      `${DEFAULT_API_BASE}/tickers?q=alpha%20bet&limit=10`,
      expect.objectContaining({ headers: { accept: 'application/json' } }),
    );
  });

  it('loads all four evidence-bearing filing datasets together', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => reply({ accession_number: '0000320193-26-000020', evidence: [], facts: [], ratios: [], comparisons: [], risks: [] }));
    vi.stubGlobal('fetch', fetchMock);
    await loadFilingData('0000320193-26-000020');
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(expect.arrayContaining([
      `${DEFAULT_API_BASE}/filings/0000320193-26-000020/financials`,
      `${DEFAULT_API_BASE}/filings/0000320193-26-000020/ratios`,
      `${DEFAULT_API_BASE}/filings/0000320193-26-000020/comparisons`,
      `${DEFAULT_API_BASE}/filings/0000320193-26-000020/risks`,
    ]));
  });

  it('submits and polls an asynchronous analysis job without blocking the data client', async () => {
    const job = {
      job_id: '11111111-1111-4111-8111-111111111111', ticker: 'AMZN', cik: '0001018724',
      company_name: 'Amazon.com, Inc.', status: 'queued', attempt_count: 0, max_attempts: 3,
      requested_at: '2026-08-31T12:00:00Z', started_at: null, completed_at: null,
      updated_at: '2026-08-31T12:00:00Z', message: 'Queued.', error_code: null, can_retry: false,
    } as const;
    const fetchMock = vi.fn().mockResolvedValue(reply(job, 202)).mockResolvedValueOnce(reply(job, 202));
    vi.stubGlobal('fetch', fetchMock);
    await expect(filingLensApi.requestAnalysis('AMZN', 'one-time-token')).resolves.toEqual(job);
    expect(fetchMock).toHaveBeenNthCalledWith(1, `${DEFAULT_API_BASE}/companies/AMZN/analysis`, expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ turnstile_token: 'one-time-token' }),
    }));
    await expect(filingLensApi.analysisStatus(job.job_id)).resolves.toEqual(job);
    expect(fetchMock).toHaveBeenNthCalledWith(2, `${DEFAULT_API_BASE}/analysis-jobs/${job.job_id}`, expect.objectContaining({ cache: 'no-store' }));
  });

  it('surfaces API errors and rejects an unknown schema', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(reply({ error: { code: 'FILING_NOT_FOUND', message: 'No filing' } }, 404)).mockResolvedValueOnce(reply([], 200, '2.0.0')));
    await expect(filingLensApi.filings('NONE')).rejects.toEqual(expect.objectContaining({ name: 'ApiError', message: 'No filing', status: 404, code: 'FILING_NOT_FOUND' }));
    await expect(filingLensApi.companies()).rejects.toThrow('unsupported schema');
  });

  it('uses a clear unavailable message for network failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(filingLensApi.company('AAPL')).rejects.toEqual(expect.any(ApiError));
    await expect(filingLensApi.company('AAPL')).rejects.toThrow('unavailable');
  });
});

describe('evidence traversal', () => {
  it('resolves a derived conclusion to its direct SEC facts without loops', () => {
    const evidence: Evidence[] = [
      { evidence_id: 'change', evidence_type: 'derived_comparison', label: 'Revenue change', accession_number: 'a', source_url: null, source_evidence_ids: ['ratio', 'fact-b'] },
      { evidence_id: 'ratio', evidence_type: 'derived_ratio', label: 'Margin', accession_number: 'a', source_url: null, source_evidence_ids: ['fact-a', 'change'] },
      { evidence_id: 'fact-a', evidence_type: 'xbrl_fact', label: 'Revenue', accession_number: 'a', source_url: 'https://data.sec.gov/a', source_evidence_ids: [] },
      { evidence_id: 'fact-b', evidence_type: 'xbrl_fact', label: 'Revenue', accession_number: 'b', source_url: 'https://data.sec.gov/b', source_evidence_ids: [] },
    ];
    expect(directEvidence(evidence, 'change').map((item) => item.evidence_id)).toEqual(['fact-a', 'fact-b']);
  });
});
