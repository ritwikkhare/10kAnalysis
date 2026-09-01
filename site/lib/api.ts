export const DEFAULT_API_BASE =
  'https://filinglens-sec-api.ritwikkhare10k.workers.dev/api/v1';

export type ApiEnvelope<T> = { schema_version: '1.0.0'; data: T; meta: Record<string, unknown> };
export type Company = {
  ticker: string;
  cik: string;
  name: string;
  filing_count?: number;
  latest_filing_date?: string;
  refresh_status?: 'up_to_date' | 'imported' | 'failed' | null;
  last_checked_at?: string | null;
  last_success_at?: string | null;
  latest_refresh_accession?: string | null;
  refresh_message?: string | null;
};
export type Filing = { accession_number: string; form: '10-K' | '10-Q'; filing_date: string; report_date: string; primary_document: string | null; official_url: string; filing_index_url: string };
export type Evidence = { evidence_id: string; evidence_type: string; label: string; accession_number: string; source_url: string | null; source_evidence_ids: string[] };
export type Fact = { key: string; name: string; value: number; formatted_value: string; unit: string; taxonomy: string; concept: string; sec_label: string; period_type: 'instant' | 'duration'; period_start: string | null; period_end: string; fiscal_year: number | null; fiscal_period: string | null; filed: string; sec_concept_url: string; evidence_id: string };
export type Ratio = { key: string; name: string; value: number; percentage: number; formatted_value: string; formula: string; calculation: string; numerator_evidence_id: string; denominator_evidence_id: string; evidence_id: string };
export type ComparisonChange = { evidence_id: string; key: string; name: string; comparison_type: 'percent_change' | 'percentage_point_change'; direction: 'increased' | 'decreased' | 'unchanged'; change_value: number; formatted_change: string; formula: string; current_evidence_id: string; previous_evidence_id: string };
export type Comparison = { comparison_id: string; current_accession: string; previous_accession: string; form: '10-K' | '10-Q'; comparison_basis: string; fiscal_period: string | null; calculated_at: string; warnings: string[]; changes: ComparisonChange[] };
export type RiskPassage = { evidence_id: string; passage_number: number; section: string; text: string; report_date: string; anchor: string | null; source_url: string };
export type RiskChange = { evidence_id: string; change_type: 'added' | 'removed' | 'materially_changed'; similarity: number | null; current_passage_id: string | null; previous_passage_id: string | null };
export type RiskComparison = { comparison_id: string; current_accession: string; previous_accession: string; compared_at: string; methodology: string; added_count: number; removed_count: number; materially_changed_count: number; changes: RiskChange[] };
export type LinkedCollection<T> = { accession_number: string; evidence: Evidence[] } & T;
export type FilingData = {
  financials: LinkedCollection<{ facts: Fact[] }>;
  ratios: LinkedCollection<{ ratios: Ratio[] }>;
  comparisons: LinkedCollection<{ comparisons: Comparison[] }>;
  risks: LinkedCollection<{ risks: Array<{ passages: RiskPassage[]; comparisons: RiskComparison[] }> }>;
};

export class ApiError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'ApiError';
  }
}

function apiBase(): string {
  return (process.env.NEXT_PUBLIC_API_BASE_URL ?? DEFAULT_API_BASE).replace(/\/$/, '');
}

async function request<T>(path: string, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${apiBase()}${path}`, { headers: { accept: 'application/json' }, signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError('The FilingLens data service is unavailable. Check your connection and try again.');
  }
  let envelope: ApiEnvelope<T>;
  try {
    envelope = (await response.json()) as ApiEnvelope<T>;
  } catch {
    throw new ApiError('The data service returned an unreadable response.', response.status);
  }
  if (!response.ok) {
    const payload = envelope.data as { error?: { message?: string } };
    throw new ApiError(payload?.error?.message ?? `Request failed with status ${response.status}.`, response.status);
  }
  if (envelope.schema_version !== '1.0.0' || !('data' in envelope)) {
    throw new ApiError('The data service returned an unsupported schema.');
  }
  return envelope.data;
}

export const filingLensApi = {
  companies: (signal?: AbortSignal) => request<Company[]>('/tickers?q=', signal),
  company: (ticker: string, signal?: AbortSignal) => request<Company>(`/companies/${encodeURIComponent(ticker)}`, signal),
  filings: (ticker: string, signal?: AbortSignal) => request<Filing[]>(`/companies/${encodeURIComponent(ticker)}/filings`, signal),
  financials: (accession: string, signal?: AbortSignal) => request<LinkedCollection<{ facts: Fact[] }>>(`/filings/${encodeURIComponent(accession)}/financials`, signal),
  ratios: (accession: string, signal?: AbortSignal) => request<LinkedCollection<{ ratios: Ratio[] }>>(`/filings/${encodeURIComponent(accession)}/ratios`, signal),
  comparisons: (accession: string, signal?: AbortSignal) => request<LinkedCollection<{ comparisons: Comparison[] }>>(`/filings/${encodeURIComponent(accession)}/comparisons`, signal),
  risks: (accession: string, signal?: AbortSignal) => request<LinkedCollection<{ risks: Array<{ passages: RiskPassage[]; comparisons: RiskComparison[] }> }>>(`/filings/${encodeURIComponent(accession)}/risks`, signal),
};

export async function loadFilingData(accession: string, signal?: AbortSignal): Promise<FilingData> {
  const [financials, ratios, comparisons, risks] = await Promise.all([
    filingLensApi.financials(accession, signal), filingLensApi.ratios(accession, signal),
    filingLensApi.comparisons(accession, signal), filingLensApi.risks(accession, signal),
  ]);
  return { financials, ratios, comparisons, risks };
}

export function directEvidence(evidence: Evidence[], evidenceId: string): Evidence[] {
  const byId = new Map(evidence.map((item) => [item.evidence_id, item]));
  const visited = new Set<string>();
  const sources: Evidence[] = [];
  function visit(id: string) {
    if (visited.has(id)) return;
    visited.add(id);
    const item = byId.get(id);
    if (!item) return;
    if (item.source_url) sources.push(item);
    item.source_evidence_ids.forEach(visit);
  }
  visit(evidenceId);
  return sources;
}
