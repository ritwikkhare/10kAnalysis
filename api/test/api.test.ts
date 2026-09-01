import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import migrationSql from "../migrations/0001_initial.sql?raw";
import refreshMigrationSql from "../migrations/0002_refresh_status.sql?raw";
import { evidenceFor } from "../src/db.js";

const CURRENT = "0000000001-26-000001";
const PREVIOUS = "0000000001-25-000001";
const FACT = `TEST-${CURRENT}-revenue`;
const PREVIOUS_FACT = `TEST-${PREVIOUS}-revenue`;
const RATIO = `TEST-${CURRENT}-net_margin`;
const CHANGE = `TEST-${CURRENT}-vs-${PREVIOUS}-revenue`;
const CURRENT_RISK = `TEST-${CURRENT}-risk-001`;
const PREVIOUS_RISK = `TEST-${PREVIOUS}-risk-001`;
const RISK_CHANGE = `TEST-${CURRENT}-risk-change-001`;

const migrationQueries = migrationSql
  .split(";")
  .map((query) => query.trim())
  .filter(Boolean);
const refreshMigrationQueries = refreshMigrationSql
  .split(";")
  .map((query) => query.trim())
  .filter(Boolean);

async function seed(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO companies (schema_version, cik, ticker, name) VALUES (?, ?, ?, ?)").bind("1.0.0", "0000000001", "TEST", "Test Corporation"),
    env.DB.prepare("INSERT INTO filings (accession_number, company_id, schema_version, form, filing_date, report_date, official_url, filing_index_url) SELECT ?, id, ?, ?, ?, ?, ?, ? FROM companies WHERE ticker = ?").bind(CURRENT, "1.0.0", "10-K", "2026-02-01", "2025-12-31", "https://www.sec.gov/Archives/test-current.htm", "https://www.sec.gov/Archives/test-current-index.html", "TEST"),
    env.DB.prepare("INSERT INTO filings (accession_number, company_id, schema_version, form, filing_date, report_date, official_url, filing_index_url) SELECT ?, id, ?, ?, ?, ?, ?, ? FROM companies WHERE ticker = ?").bind(PREVIOUS, "1.0.0", "10-K", "2025-02-01", "2024-12-31", "https://www.sec.gov/Archives/test-previous.htm", "https://www.sec.gov/Archives/test-previous-index.html", "TEST"),
  ]);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO refresh_runs (run_id, trigger_type, status, started_at, completed_at, companies_checked, filings_discovered, filings_imported, error_count) VALUES (?, 'test', 'succeeded', ?, ?, 1, 1, 1, 0)",
    ).bind("test-refresh-run", "2026-08-31T12:00:00Z", "2026-08-31T12:01:00Z"),
    env.DB.prepare(
      "INSERT INTO company_refresh_status (company_id, run_id, status, last_checked_at, last_success_at, latest_accession, message) SELECT id, ?, 'imported', ?, ?, ?, 'Imported one new filing.' FROM companies WHERE ticker = 'TEST'",
    ).bind("test-refresh-run", "2026-08-31T12:01:00Z", "2026-08-31T12:01:00Z", CURRENT),
  ]);
  const evidence = [
    [FACT, "xbrl_fact", "Revenue", CURRENT, "https://data.sec.gov/api/xbrl/current.json"],
    [PREVIOUS_FACT, "xbrl_fact", "Revenue", PREVIOUS, "https://data.sec.gov/api/xbrl/previous.json"],
    [RATIO, "derived_ratio", "Net margin", CURRENT, null],
    [CHANGE, "derived_comparison", "Revenue change", CURRENT, null],
    [CURRENT_RISK, "risk_passage", "Current risk", CURRENT, "https://www.sec.gov/Archives/test-current.htm#risk"],
    [PREVIOUS_RISK, "risk_passage", "Previous risk", PREVIOUS, "https://www.sec.gov/Archives/test-previous.htm#risk"],
    [RISK_CHANGE, "derived_risk_change", "Risk change", CURRENT, null],
  ];
  await env.DB.batch(evidence.map((row) => env.DB.prepare("INSERT INTO evidence_links (evidence_id, schema_version, evidence_type, label, filing_accession, source_url) VALUES (?, '1.0.0', ?, ?, ?, ?)").bind(...row)));
  await env.DB.batch([
    env.DB.prepare("INSERT INTO evidence_sources VALUES (?, ?)").bind(RATIO, FACT),
    env.DB.prepare("INSERT INTO evidence_sources VALUES (?, ?)").bind(CHANGE, FACT),
    env.DB.prepare("INSERT INTO evidence_sources VALUES (?, ?)").bind(CHANGE, PREVIOUS_FACT),
    env.DB.prepare("INSERT INTO evidence_sources VALUES (?, ?)").bind(RISK_CHANGE, CURRENT_RISK),
    env.DB.prepare("INSERT INTO evidence_sources VALUES (?, ?)").bind(RISK_CHANGE, PREVIOUS_RISK),
    env.DB.prepare("INSERT INTO financial_facts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(FACT, CURRENT, "revenue", "Revenue", 120, "$120", "USD", "us-gaap", "Revenues", "Revenue", "duration", "2025-01-01", "2025-12-31", 2025, "FY", "2026-02-01", "https://data.sec.gov/api/xbrl/current.json"),
    env.DB.prepare("INSERT INTO financial_facts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(PREVIOUS_FACT, PREVIOUS, "revenue", "Revenue", 100, "$100", "USD", "us-gaap", "Revenues", "Revenue", "duration", "2024-01-01", "2024-12-31", 2024, "FY", "2025-02-01", "https://data.sec.gov/api/xbrl/previous.json"),
    env.DB.prepare("INSERT INTO ratios VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(RATIO, CURRENT, "net_margin", "Net margin", 0.2, 20, "20.00%", "net_income / revenue", "24 / 120", FACT, FACT),
    env.DB.prepare("INSERT INTO filing_comparisons (comparison_id, company_id, schema_version, current_accession, previous_accession, form, comparison_basis, calculated_at) SELECT ?, id, '1.0.0', ?, ?, '10-K', 'year_over_year', '2026-02-01' FROM companies WHERE ticker = 'TEST'").bind("TEST-comparison", CURRENT, PREVIOUS),
    env.DB.prepare("INSERT INTO comparison_changes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(CHANGE, "TEST-comparison", "revenue", "Revenue", "percent_change", "increased", 20, "+20.00%", "((current - previous) / abs(previous)) * 100", FACT, PREVIOUS_FACT),
    env.DB.prepare("INSERT INTO risk_passages VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(CURRENT_RISK, CURRENT, 1, "Item 1A. Risk Factors", "Current risk language.", "2025-12-31", "risk", "https://www.sec.gov/Archives/test-current.htm#risk"),
    env.DB.prepare("INSERT INTO risk_passages VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(PREVIOUS_RISK, PREVIOUS, 1, "Item 1A. Risk Factors", "Previous risk language.", "2024-12-31", "risk", "https://www.sec.gov/Archives/test-previous.htm#risk"),
    env.DB.prepare("INSERT INTO risk_comparisons (comparison_id, company_id, schema_version, current_accession, previous_accession, compared_at, methodology, added_count, removed_count, materially_changed_count) SELECT ?, id, '1.0.0', ?, ?, '2026-02-01', 'Deterministic test', 0, 0, 1 FROM companies WHERE ticker = 'TEST'").bind("TEST-risk-comparison", CURRENT, PREVIOUS),
    env.DB.prepare("INSERT INTO risk_changes VALUES (?, ?, ?, ?, ?, ?)").bind(RISK_CHANGE, "TEST-risk-comparison", "materially_changed", 0.8, CURRENT_RISK, PREVIOUS_RISK),
  ]);
}

async function get(path: string): Promise<{ response: Response; body: any }> {
  const response = await SELF.fetch(`https://api.example.test${path}`);
  return { response, body: await response.json() };
}

function expectEnvelope(body: any): void {
  expect(body.schema_version).toBe("1.0.0");
  expect(body).toHaveProperty("data");
  expect(body).toHaveProperty("meta");
}

describe("read-only SEC intelligence API", () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, [
      { name: "0001_initial.sql", queries: migrationQueries },
      { name: "0002_refresh_status.sql", queries: refreshMigrationQueries },
    ]);
    await seed();
  });

  it.each([
    "/api/v1/health",
    "/api/v1/refresh-status",
    "/api/v1/tickers?q=tes",
    "/api/v1/companies/TEST",
    "/api/v1/companies/TEST/filings?form=10-K",
    `/api/v1/filings/${CURRENT}/financials`,
    `/api/v1/filings/${CURRENT}/ratios`,
    `/api/v1/filings/${CURRENT}/comparisons`,
    `/api/v1/filings/${CURRENT}/risks`,
    `/api/v1/evidence/${encodeURIComponent(CHANGE)}`,
  ])("returns a validated envelope for %s", async (path) => {
    const { response, body } = await get(path);
    expect(response.status).toBe(200);
    expectEnvelope(body);
  });

  it("keeps SEC evidence clickable", async () => {
    const { body } = await get(`/api/v1/filings/${CURRENT}/financials`);
    expect(body.data.evidence[0].source_url).toMatch(/^https:\/\/(www|data)\.sec\.gov\//);
  });

  it("reports refresh freshness without exposing failure internals", async () => {
    const { body } = await get("/api/v1/refresh-status");
    expect(body.data.run.status).toBe("succeeded");
    expect(body.data.companies[0]).toMatchObject({
      ticker: "TEST",
      status: "imported",
      latest_accession: CURRENT,
    });
    expect(JSON.stringify(body)).not.toContain("stack");
  });

  it("loads production-sized evidence sets in safe D1 batches", async () => {
    const statements = Array.from({ length: 81 }, (_, index) =>
      env.DB.prepare(
        "INSERT INTO evidence_links (evidence_id, schema_version, evidence_type, label, filing_accession, source_url) VALUES (?, '1.0.0', 'risk_passage', ?, ?, ?)",
      ).bind(
        `TEST-batch-${index}`,
        `Batch passage ${index}`,
        CURRENT,
        `https://www.sec.gov/Archives/test-current.htm#batch-${index}`,
      ),
    );
    await env.DB.batch(statements);
    const evidence = await evidenceFor(
      env.DB,
      statements.map((_, index) => `TEST-batch-${index}`),
    );
    expect(evidence).toHaveLength(81);
  });

  it("rejects writes", async () => {
    const response = await SELF.fetch("https://api.example.test/api/v1/tickers", { method: "POST" });
    expect(response.status).toBe(405);
    expect((await response.json() as any).data.error.code).toBe("METHOD_NOT_ALLOWED");
  });
});
