import { all, evidenceFor, first, parseJsonColumn, type Row } from "./db.js";
import { apiError, cleanAccession, cleanTicker, json, pagination } from "./http.js";

function route(pathname: string): string[] {
  return pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
}

async function tickerSearch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const query = (url.searchParams.get("q") ?? "").trim();
  const { limit, offset } = pagination(url);
  const like = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
  const rows = await all(
    env.DB,
    `SELECT ticker, cik, name FROM companies
      WHERE ? = '' OR ticker LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\'
      ORDER BY CASE WHEN ticker = UPPER(?) THEN 0 ELSE 1 END, ticker LIMIT ? OFFSET ?`,
    [query, like, like, query, limit, offset],
  );
  return json(rows, { query, limit, offset, count: rows.length });
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
  return company ? json(company) : apiError(404, "COMPANY_NOT_FOUND", `No pilot company found for ${ticker}.`);
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
  if (!exists) return apiError(404, "COMPANY_NOT_FOUND", `No pilot company found for ${ticker}.`);
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

async function handle(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") return apiError(405, "METHOD_NOT_ALLOWED", "This API is read-only and accepts GET requests only.");
  const parts = route(new URL(request.url).pathname);
  if (parts[0] !== "api" || parts[1] !== "v1") return apiError(404, "NOT_FOUND", "Use an /api/v1 endpoint.");
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
} satisfies ExportedHandler<Env>;
