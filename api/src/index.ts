import { all, evidenceFor, first, parseJsonColumn, type Row } from "./db.js";
import { apiError, cleanAccession, cleanSearchQuery, cleanTicker, json, pagination } from "./http.js";
import {
  analysisJobStatus,
  consumeAnalysisQueue,
  createAnalysisJob,
  retryAnalysisJob,
  type AnalysisQueueMessage,
} from "./onboarding.js";

const SEC_DIRECTORY_URL = "https://www.sec.gov/files/company_tickers.json";
const TICKER_CACHE_CONTROL = "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400";

function route(pathname: string): string[] {
  return pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
}

async function tickerSearch(request: Request, env: Env): Promise<Response> {
  const limited = await enforceTickerSearchLimit(request, env.TICKER_SEARCH_RATE_LIMITER);
  if (limited) return limited;
  const url = new URL(request.url);
  const query = cleanSearchQuery(url.searchParams.get("q") ?? "");
  if (query === null) {
    return apiError(400, "INVALID_SEARCH_QUERY", "Search must be 64 characters or fewer and cannot contain control characters.");
  }
  const { limit, offset } = pagination(url);
  const like = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
  const directory = await first(
    env.DB,
    "SELECT source_url, fetched_at, row_count, sha256 FROM sec_directory_sync WHERE singleton_id = 1",
  );
  let rows: Row[];
  if (query && directory) {
    rows = await all(
      env.DB,
      `SELECT d.ticker, d.cik, d.name,
        CASE WHEN c.id IS NULL THEN 0 ELSE 1 END AS is_processed,
        COUNT(f.accession_number) AS filing_count
        FROM sec_company_directory d
        LEFT JOIN companies c ON c.ticker = d.ticker
        LEFT JOIN filings f ON f.company_id = c.id
        WHERE d.ticker LIKE ? ESCAPE '\\' OR d.name LIKE ? ESCAPE '\\'
        GROUP BY d.ticker, d.cik, d.name, c.id
        ORDER BY
          CASE WHEN d.ticker = UPPER(?) THEN 0
               WHEN d.ticker LIKE UPPER(?) || '%' THEN 1
               WHEN d.name LIKE ? || '%' THEN 2 ELSE 3 END,
          is_processed DESC, d.ticker
        LIMIT ? OFFSET ?`,
      [like, like, query, query, query, limit, offset],
    );
  } else {
    rows = await all(
      env.DB,
      `SELECT c.ticker, c.cik, c.name, 1 AS is_processed,
        COUNT(f.accession_number) AS filing_count
        FROM companies c LEFT JOIN filings f ON f.company_id = c.id
        WHERE ? = '' OR c.ticker LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\'
        GROUP BY c.id
        ORDER BY CASE WHEN c.ticker = UPPER(?) THEN 0 ELSE 1 END, c.ticker
        LIMIT ? OFFSET ?`,
      [query, like, like, query, limit, offset],
    );
  }
  const results = rows.map((row) => {
    const isProcessed = Boolean(row.is_processed);
    return {
      ticker: String(row.ticker),
      cik: String(row.cik),
      name: String(row.name),
      is_processed: isProcessed,
      availability: isProcessed ? "available" : "requires_analysis",
      filing_count: Number(row.filing_count ?? 0),
    };
  });
  return json(
    results,
    {
      query,
      limit,
      offset,
      count: results.length,
      directory_status: directory ? "ready" : "unavailable",
      directory_source_url: directory?.source_url ?? SEC_DIRECTORY_URL,
      directory_fetched_at: directory?.fetched_at ?? null,
      directory_row_count: directory?.row_count ?? 0,
      directory_sha256: directory?.sha256 ?? null,
    },
    200,
    { "cache-control": TICKER_CACHE_CONTROL },
  );
}

export async function enforceTickerSearchLimit(
  request: Request,
  limiter: RateLimit,
): Promise<Response | null> {
  const clientKey = request.headers.get("CF-Connecting-IP") ?? "unknown-client";
  const outcome = await limiter.limit({ key: `ticker-search:${clientKey}` });
  if (outcome.success) return null;
  return apiError(
    429,
    "RATE_LIMITED",
    "Ticker search is temporarily rate limited. Please wait a minute and try again.",
    { "retry-after": "60" },
  );
}

async function companyDetails(tickerValue: string, env: Env): Promise<Response> {
  const ticker = cleanTicker(tickerValue);
  if (!ticker) return apiError(400, "INVALID_TICKER", "Ticker format is invalid.");
  const company = await first(
    env.DB,
    `SELECT c.ticker, c.cik, c.name,
      COUNT(f.accession_number) AS filing_count,
      MAX(f.filing_date) AS latest_filing_date,
      s.status AS refresh_status, s.last_checked_at, s.last_success_at,
      s.latest_accession AS latest_refresh_accession, s.message AS refresh_message
      FROM companies c
      LEFT JOIN filings f ON f.company_id = c.id
      LEFT JOIN company_refresh_status s ON s.company_id = c.id
      WHERE c.ticker = ? GROUP BY c.id`,
    [ticker],
  );
  if (company) return json(company);
  const directoryCompany = await first(
    env.DB,
    "SELECT ticker FROM sec_company_directory WHERE ticker = ?",
    [ticker],
  );
  return directoryCompany
    ? apiError(404, "COMPANY_NOT_ANALYZED", `${ticker} is in the SEC directory but has not been analyzed yet.`)
    : apiError(404, "COMPANY_NOT_FOUND", `${ticker} was not found in the synchronized SEC directory.`);
}

async function refreshStatus(env: Env): Promise<Response> {
  const run = await first(
    env.DB,
    `SELECT run_id, trigger_type, status, started_at, completed_at,
      companies_checked, filings_discovered, filings_imported, error_count,
      error_summary FROM refresh_runs ORDER BY started_at DESC LIMIT 1`,
  );
  const companies = await all(
    env.DB,
    `SELECT c.ticker, s.status, s.last_checked_at, s.last_success_at,
      s.latest_accession, s.message
      FROM companies c LEFT JOIN company_refresh_status s ON s.company_id = c.id
      ORDER BY c.ticker`,
  );
  return json({ run, companies });
}

async function filingHistory(request: Request, tickerValue: string, env: Env): Promise<Response> {
  const ticker = cleanTicker(tickerValue);
  if (!ticker) return apiError(400, "INVALID_TICKER", "Ticker format is invalid.");
  const url = new URL(request.url);
  const form = url.searchParams.get("form");
  if (form !== null && form !== "10-K" && form !== "10-Q") {
    return apiError(400, "INVALID_FORM", "form must be 10-K or 10-Q.");
  }
  const { limit, offset } = pagination(url);
  const rows = await all(
    env.DB,
    `SELECT f.accession_number, f.form, f.filing_date, f.report_date,
      f.primary_document, f.official_url, f.filing_index_url
      FROM filings f JOIN companies c ON c.id = f.company_id
      WHERE c.ticker = ? AND (? IS NULL OR f.form = ?)
      ORDER BY f.filing_date DESC LIMIT ? OFFSET ?`,
    [ticker, form, form, limit, offset],
  );
  const exists = await first(env.DB, "SELECT 1 AS found FROM companies WHERE ticker = ?", [ticker]);
  if (!exists) return apiError(404, "COMPANY_NOT_ANALYZED", `${ticker} has not been analyzed yet.`);
  return json(rows, { ticker, form, limit, offset, count: rows.length });
}

async function financials(accessionValue: string, env: Env): Promise<Response> {
  const accession = cleanAccession(accessionValue);
  if (!accession) return apiError(400, "INVALID_ACCESSION", "Accession number format is invalid.");
  const rows = await all(
    env.DB,
    `SELECT fact_key AS key, name, value, formatted_value, unit, taxonomy, concept,
      sec_label, period_type, period_start, period_end, fiscal_year, fiscal_period,
      filed, sec_concept_url, evidence_id
      FROM financial_facts WHERE filing_accession = ? ORDER BY fact_key`,
    [accession],
  );
  return linkedRows(accession, rows, env, "facts");
}

async function ratios(accessionValue: string, env: Env): Promise<Response> {
  const accession = cleanAccession(accessionValue);
  if (!accession) return apiError(400, "INVALID_ACCESSION", "Accession number format is invalid.");
  const rows = await all(
    env.DB,
    `SELECT ratio_key AS key, name, value, percentage, formatted_value, formula,
      calculation, numerator_evidence_id, denominator_evidence_id, evidence_id
      FROM ratios WHERE filing_accession = ? ORDER BY ratio_key`,
    [accession],
  );
  const ids = rows.flatMap((row) => [row.evidence_id, row.numerator_evidence_id, row.denominator_evidence_id].map(String));
  return collectionOrMissing(accession, "ratios", rows, await evidenceFor(env.DB, ids), env);
}

async function comparisons(accessionValue: string, env: Env): Promise<Response> {
  const accession = cleanAccession(accessionValue);
  if (!accession) return apiError(400, "INVALID_ACCESSION", "Accession number format is invalid.");
  const headers = await all(
    env.DB,
    `SELECT comparison_id, current_accession, previous_accession, form, comparison_basis,
      fiscal_period, calculated_at, warnings_json FROM filing_comparisons
      WHERE current_accession = ? OR previous_accession = ? ORDER BY calculated_at DESC`,
    [accession, accession],
  );
  const output: Row[] = [];
  const evidenceIds: string[] = [];
  for (const header of headers) {
    const changes = await all(
      env.DB,
      `SELECT evidence_id, change_key AS key, name, comparison_type, direction,
        change_value, formatted_change, formula, current_evidence_id, previous_evidence_id
        FROM comparison_changes WHERE comparison_id = ? ORDER BY change_key`,
      [header.comparison_id],
    );
    changes.forEach((item) => evidenceIds.push(String(item.evidence_id), String(item.current_evidence_id), String(item.previous_evidence_id)));
    output.push({ ...header, warnings: parseJsonColumn(header.warnings_json, []), warnings_json: undefined, changes });
  }
  return collectionOrMissing(accession, "comparisons", output, await evidenceFor(env.DB, evidenceIds), env);
}

async function risks(accessionValue: string, env: Env): Promise<Response> {
  const accession = cleanAccession(accessionValue);
  if (!accession) return apiError(400, "INVALID_ACCESSION", "Accession number format is invalid.");
  const passages = await all(
    env.DB,
    `SELECT evidence_id, passage_number, section, text, report_date, anchor, source_url
      FROM risk_passages WHERE filing_accession = ? ORDER BY passage_number`,
    [accession],
  );
  const comparisons = await all(
    env.DB,
    `SELECT comparison_id, current_accession, previous_accession, compared_at, methodology,
      added_count, removed_count, materially_changed_count FROM risk_comparisons
      WHERE current_accession = ? OR previous_accession = ? ORDER BY compared_at DESC`,
    [accession, accession],
  );
  const evidenceIds = passages.map((item) => String(item.evidence_id));
  const enriched: Row[] = [];
  for (const comparison of comparisons) {
    const changes = await all(
      env.DB,
      `SELECT evidence_id, change_type, similarity, current_passage_id, previous_passage_id
        FROM risk_changes WHERE comparison_id = ? ORDER BY evidence_id`,
      [comparison.comparison_id],
    );
    changes.forEach((item) => evidenceIds.push(String(item.evidence_id), ...[item.current_passage_id, item.previous_passage_id].filter(Boolean).map(String)));
    enriched.push({ ...comparison, changes });
  }
  return collectionOrMissing(accession, "risks", [{ passages, comparisons: enriched }], await evidenceFor(env.DB, evidenceIds), env);
}

async function oneEvidence(id: string, env: Env): Promise<Response> {
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(id)) return apiError(400, "INVALID_EVIDENCE_ID", "Evidence ID format is invalid.");
  const evidence = await evidenceFor(env.DB, [id]);
  if (evidence.length === 0) return apiError(404, "EVIDENCE_NOT_FOUND", `No evidence found for ${id}.`);
  const sourceIds = evidence[0].source_evidence_ids as string[];
  return json({ ...evidence[0], sources: await evidenceFor(env.DB, sourceIds) });
}

async function linkedRows(accession: string, rows: Row[], env: Env, name: string): Promise<Response> {
  return collectionOrMissing(accession, name, rows, await evidenceFor(env.DB, rows.map((row) => String(row.evidence_id))), env);
}

async function collectionOrMissing(accession: string, name: string, rows: Row[], evidence: Row[], env: Env): Promise<Response> {
  const filing = await first(env.DB, "SELECT accession_number FROM filings WHERE accession_number = ?", [accession]);
  if (!filing) return apiError(404, "FILING_NOT_FOUND", `No pilot filing found for ${accession}.`);
  return json({ accession_number: accession, [name]: rows, evidence });
}

export async function handle(request: Request, env: Env): Promise<Response> {
  const parts = route(new URL(request.url).pathname);
  if (parts[0] !== "api" || parts[1] !== "v1") return apiError(404, "NOT_FOUND", "Use an /api/v1 endpoint.");
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "content-type",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-max-age": "86400",
      },
    });
  }
  if (request.method === "POST" && parts.length === 5 && parts[2] === "companies" && parts[4] === "analysis") {
    return createAnalysisJob(request, parts[3], env);
  }
  if (request.method === "POST" && parts.length === 5 && parts[2] === "analysis-jobs" && parts[4] === "retry") {
    return retryAnalysisJob(request, parts[3], env);
  }
  if (request.method !== "GET") return apiError(405, "METHOD_NOT_ALLOWED", "This endpoint does not accept that method.");
  if (parts.length === 3 && parts[2] === "health") return json({ status: "ok", storage: "d1" });
  if (parts.length === 3 && parts[2] === "refresh-status") return refreshStatus(env);
  if (parts.length === 3 && parts[2] === "tickers") return tickerSearch(request, env);
  if (parts.length === 4 && parts[2] === "companies") return companyDetails(parts[3], env);
  if (parts.length === 5 && parts[2] === "companies" && parts[4] === "filings") return filingHistory(request, parts[3], env);
  if (parts.length === 5 && parts[2] === "filings" && parts[4] === "financials") return financials(parts[3], env);
  if (parts.length === 5 && parts[2] === "filings" && parts[4] === "ratios") return ratios(parts[3], env);
  if (parts.length === 5 && parts[2] === "filings" && parts[4] === "comparisons") return comparisons(parts[3], env);
  if (parts.length === 5 && parts[2] === "filings" && parts[4] === "risks") return risks(parts[3], env);
  if (parts.length === 4 && parts[2] === "evidence") return oneEvidence(decodeURIComponent(parts[3]), env);
  if (parts.length === 4 && parts[2] === "analysis-jobs") return analysisJobStatus(parts[3], env);
  return apiError(404, "NOT_FOUND", "API endpoint not found.");
}

export default {
  async fetch(request, env): Promise<Response> {
    try {
      return await handle(request, env);
    } catch (error) {
      console.error(
        JSON.stringify({
          message: "request_failed",
          method: request.method,
          path: new URL(request.url).pathname,
          error: error instanceof Error ? error.message : "unknown_error",
        }),
      );
      return apiError(500, "INTERNAL_ERROR", "The API could not complete this request.");
    }
  },
  async queue(batch, env): Promise<void> {
    await consumeAnalysisQueue(batch, env);
  },
} satisfies ExportedHandler<Env, AnalysisQueueMessage>;
