import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import migrationSql from "../migrations/0001_initial.sql?raw";
import refreshMigrationSql from "../migrations/0002_refresh_status.sql?raw";
import directoryMigrationSql from "../migrations/0003_sec_company_directory.sql?raw";
import analysisMigrationSql from "../migrations/0004_analysis_jobs.sql?raw";
import { evidenceFor } from "../src/db.js";
import { enforceTickerSearchLimit } from "../src/index.js";
import {
  analysisJobStatus,
  consumeAnalysisQueue,
  createAnalysisJob,
  retryAnalysisJob,
  type AnalysisQueueMessage,
  type OnboardingEnv,
} from "../src/onboarding.js";

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
const directoryMigrationQueries = directoryMigrationSql
  .split(";")
  .map((query) => query.trim())
  .filter(Boolean);
const analysisMigrationQueries = analysisMigrationSql
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
      "INSERT INTO sec_company_directory (ticker, cik, name, source_url, source_fetched_at) VALUES (?, ?, ?, ?, ?)",
    ).bind("TEST", "0000000001", "Test Corporation", "https://www.sec.gov/files/company_tickers.json", "2026-08-31T12:00:00Z"),
    env.DB.prepare(
      "INSERT INTO sec_company_directory (ticker, cik, name, source_url, source_fetched_at) VALUES (?, ?, ?, ?, ?)",
    ).bind("FRESH", "0000000002", "Fresh Public Company", "https://www.sec.gov/files/company_tickers.json", "2026-08-31T12:00:00Z"),
    env.DB.prepare(
      "INSERT INTO sec_directory_sync (singleton_id, source_url, fetched_at, row_count, sha256) VALUES (1, ?, ?, 2, ?)",
    ).bind("https://www.sec.gov/files/company_tickers.json", "2026-08-31T12:00:00Z", "a".repeat(64)),
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

function fakeQueue(sent: AnalysisQueueMessage[]): Queue<AnalysisQueueMessage> {
  const metrics = { backlogCount: 0, backlogBytes: 0 };
  return {
    metrics: async () => metrics,
    send: async (message) => {
      sent.push(message);
      return { metadata: { metrics } };
    },
    sendBatch: async (messages) => {
      for (const message of messages) sent.push(message.body);
      return { metadata: { metrics } };
    },
  };
}

describe("SEC intelligence API", () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, [
      { name: "0001_initial.sql", queries: migrationQueries },
      { name: "0002_refresh_status.sql", queries: refreshMigrationQueries },
      { name: "0003_sec_company_directory.sql", queries: directoryMigrationQueries },
      { name: "0004_analysis_jobs.sql", queries: analysisMigrationQueries },
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

  it("searches the universal SEC directory and marks analysis availability", async () => {
    const available = await get("/api/v1/tickers?q=test");
    const pending = await get("/api/v1/tickers?q=fresh");
    expect(available.body.data[0]).toMatchObject({
      ticker: "TEST",
      is_processed: true,
      availability: "available",
      filing_count: 2,
    });
    expect(pending.body.data[0]).toMatchObject({
      ticker: "FRESH",
      is_processed: false,
      availability: "requires_analysis",
      filing_count: 0,
    });
    expect(pending.body.meta).toMatchObject({
      directory_status: "ready",
      directory_row_count: 2,
      directory_source_url: "https://www.sec.gov/files/company_tickers.json",
    });
    expect(pending.response.headers.get("cache-control")).toContain("s-maxage=3600");
  });

  it("validates search input and emits a standard rate-limit response", async () => {
    const invalid = await get(`/api/v1/tickers?q=${encodeURIComponent("x".repeat(65))}`);
    expect(invalid.response.status).toBe(400);
    expect(invalid.body.data.error.code).toBe("INVALID_SEARCH_QUERY");

    const response = await enforceTickerSearchLimit(
      new Request("https://api.example.test/api/v1/tickers?q=test", {
        headers: { "CF-Connecting-IP": "192.0.2.1" },
      }),
      { limit: async () => ({ success: false }) },
    );
    expect(response?.status).toBe(429);
    expect(response?.headers.get("retry-after")).toBe("60");
    expect((await response?.json() as any).data.error.code).toBe("RATE_LIMITED");
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

  it("rejects unrelated writes", async () => {
    const response = await SELF.fetch("https://api.example.test/api/v1/tickers", { method: "POST" });
    expect(response.status).toBe(405);
    expect((await response.json() as any).data.error.code).toBe("METHOD_NOT_ALLOWED");
  });

  it("queues one protected job, reports duplicates, processes asynchronously, and permits a bounded retry", async () => {
    const sent: AnalysisQueueMessage[] = [];
    const queue = fakeQueue(sent);
    const onboardingEnv: OnboardingEnv = {
      DB: env.DB,
      ANALYSIS_QUEUE: queue,
      TICKER_SEARCH_RATE_LIMITER: { limit: async () => ({ success: true }) },
      ONBOARDING_RATE_LIMITER: { limit: async () => ({ success: true }) },
      ONBOARDING_ENABLED: "true",
      GITHUB_REPOSITORY: "ritwikkhare/10kAnalysis",
      TURNSTILE_ACTION: "analyze_ticker",
      TURNSTILE_HOSTNAMES: "filinglens-apple-sec.ritwikkhare10k.workers.dev",
    };
    const challenge = async () => ({ ok: true } as const);
    const request = () => new Request("https://api.example.test/api/v1/companies/FRESH/analysis", {
      method: "POST",
      headers: { "content-type": "application/json", "CF-Connecting-IP": "192.0.2.3" },
      body: JSON.stringify({ turnstile_token: "fresh-token" }),
    });

    const created = await createAnalysisJob(request(), "FRESH", onboardingEnv, challenge);
    const createdBody: any = await created.json();
    expect(created.status).toBe(202);
    expect(createdBody.data).toMatchObject({ ticker: "FRESH", status: "queued", can_retry: false });
    expect(sent).toHaveLength(1);

    const duplicate = await createAnalysisJob(request(), "FRESH", onboardingEnv, challenge);
    const duplicateBody: any = await duplicate.json();
    expect(duplicate.status).toBe(202);
    expect(duplicateBody.data.job_id).toBe(createdBody.data.job_id);
    expect(duplicateBody.meta.duplicate_request).toBe(true);
    expect(sent).toHaveLength(1);

    let acknowledged = false;
    const message = {
      id: "queue-message-1",
      timestamp: new Date(),
      body: sent[0],
      attempts: 1,
      ack: () => { acknowledged = true; },
      retry: () => { throw new Error("unexpected retry"); },
    } as Message<AnalysisQueueMessage>;
    await consumeAnalysisQueue(
      { queue: "filinglens-analysis", messages: [message], metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } }, ackAll: () => {}, retryAll: () => {} },
      onboardingEnv,
      async () => new Response(null, { status: 204 }),
    );
    expect(acknowledged).toBe(true);
    const processing = await analysisJobStatus(createdBody.data.job_id, onboardingEnv);
    expect((await processing.json() as any).data).toMatchObject({ status: "processing", attempt_count: 1 });

    await env.DB.prepare(
      "UPDATE analysis_jobs SET status = 'failed', completed_at = ?, updated_at = ?, public_message = 'Safe failure.', error_code = 'PIPELINE_FAILED' WHERE job_id = ?",
    ).bind("2026-08-31T13:00:00Z", "2026-08-31T13:00:00Z", createdBody.data.job_id).run();
    const retried = await retryAnalysisJob(request(), createdBody.data.job_id, onboardingEnv, challenge);
    expect(retried.status).toBe(202);
    expect((await retried.json() as any).data.status).toBe("queued");
    expect(sent).toHaveLength(2);
  });

  it("returns safe unsupported, already-analyzed, disabled, and rate-limit states", async () => {
    const sent: AnalysisQueueMessage[] = [];
    const base = {
      DB: env.DB,
      ANALYSIS_QUEUE: fakeQueue(sent),
      TICKER_SEARCH_RATE_LIMITER: { limit: async () => ({ success: true }) },
      ONBOARDING_RATE_LIMITER: { limit: async () => ({ success: true }) },
      ONBOARDING_ENABLED: "true",
      GITHUB_REPOSITORY: "ritwikkhare/10kAnalysis",
      TURNSTILE_ACTION: "analyze_ticker",
      TURNSTILE_HOSTNAMES: "filinglens-apple-sec.ritwikkhare10k.workers.dev",
    } satisfies OnboardingEnv;
    const challenge = async () => ({ ok: true } as const);
    const makeRequest = () => new Request("https://api.example.test", { method: "POST", body: JSON.stringify({ turnstile_token: "token" }) });
    expect((await createAnalysisJob(makeRequest(), "NOPE", base, challenge)).status).toBe(404);
    expect((await createAnalysisJob(makeRequest(), "TEST", base, challenge)).status).toBe(409);
    expect((await createAnalysisJob(makeRequest(), "NOPE", { ...base, ONBOARDING_ENABLED: "false" }, challenge)).status).toBe(503);
    const rolloutBlocked = await createAnalysisJob(makeRequest(), "NOPE", {
      ...base,
      ONBOARDING_TEST_TICKER: "FRESH",
    }, challenge);
    expect(rolloutBlocked.status).toBe(503);
    expect((await rolloutBlocked.json() as any).data.error.code).toBe("CONTROLLED_ROLLOUT");
    expect((await createAnalysisJob(makeRequest(), "NOPE", {
      ...base,
      ONBOARDING_RATE_LIMITER: { limit: async () => ({ success: false }) },
    }, challenge)).status).toBe(429);
  });
});
