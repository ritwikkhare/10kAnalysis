import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import migrationSql from "../migrations/0001_initial.sql?raw";
import refreshMigrationSql from "../migrations/0002_refresh_status.sql?raw";
import directoryMigrationSql from "../migrations/0003_sec_company_directory.sql?raw";
import analysisMigrationSql from "../migrations/0004_analysis_jobs.sql?raw";
import aiMigrationSql from "../migrations/0005_ai_analysis.sql?raw";
import derivedMigrationSql from "../migrations/0006_ai_derived_values.sql?raw";
import calculationAuditMigrationSql from "../migrations/0007_ai_calculation_audit.sql?raw";
import { evidenceFor } from "../src/db.js";
import { enforceTickerSearchLimit } from "../src/rate_limit.js";
import {
  askCompanyAiQuestion,
  generateCompanyAiAnalysis,
  getCompanyAiAnalysis,
  loadGroundingPacket,
  materializeApprovedDerivedEvidence,
  providerResponseMetadata,
  validateGroundedOutput,
  AI_CALCULATION_VERSION,
  AI_PROMPT_VERSION,
  roundHalfAwayFromZero,
  reproduceRatioValue,
  type AiEnv,
  type AiModelRequest,
} from "../src/ai.js";
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
const CURRENT_NET_INCOME = `TEST-${CURRENT}-net-income`;
const PREVIOUS_NET_INCOME = `TEST-${PREVIOUS}-net-income`;
const RATIO = `TEST-${CURRENT}-net_margin`;
const PREVIOUS_RATIO = `TEST-${PREVIOUS}-net_margin`;
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
const aiMigrationQueries = aiMigrationSql
  .split(";")
  .map((query) => query.trim())
  .filter(Boolean);
const derivedMigrationQueries = derivedMigrationSql
  .split(";")
  .map((query) => query.trim())
  .filter(Boolean);
const calculationAuditMigrationQueries = calculationAuditMigrationSql
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
    [CURRENT_NET_INCOME, "xbrl_fact", "Net income", CURRENT, "https://data.sec.gov/api/xbrl/current-net-income.json"],
    [PREVIOUS_NET_INCOME, "xbrl_fact", "Net income", PREVIOUS, "https://data.sec.gov/api/xbrl/previous-net-income.json"],
    [RATIO, "derived_ratio", "Net margin", CURRENT, null],
    [PREVIOUS_RATIO, "derived_ratio", "Net margin", PREVIOUS, null],
    [CHANGE, "derived_comparison", "Revenue change", CURRENT, null],
    [CURRENT_RISK, "risk_passage", "Current risk", CURRENT, "https://www.sec.gov/Archives/test-current.htm#risk"],
    [PREVIOUS_RISK, "risk_passage", "Previous risk", PREVIOUS, "https://www.sec.gov/Archives/test-previous.htm#risk"],
    [RISK_CHANGE, "derived_risk_change", "Risk change", CURRENT, null],
  ];
  await env.DB.batch(evidence.map((row) => env.DB.prepare("INSERT INTO evidence_links (evidence_id, schema_version, evidence_type, label, filing_accession, source_url) VALUES (?, '1.0.0', ?, ?, ?, ?)").bind(...row)));
  await env.DB.batch([
    env.DB.prepare("INSERT INTO evidence_sources VALUES (?, ?)").bind(RATIO, CURRENT_NET_INCOME),
    env.DB.prepare("INSERT INTO evidence_sources VALUES (?, ?)").bind(RATIO, FACT),
    env.DB.prepare("INSERT INTO evidence_sources VALUES (?, ?)").bind(PREVIOUS_RATIO, PREVIOUS_NET_INCOME),
    env.DB.prepare("INSERT INTO evidence_sources VALUES (?, ?)").bind(PREVIOUS_RATIO, PREVIOUS_FACT),
    env.DB.prepare("INSERT INTO evidence_sources VALUES (?, ?)").bind(CHANGE, FACT),
    env.DB.prepare("INSERT INTO evidence_sources VALUES (?, ?)").bind(CHANGE, PREVIOUS_FACT),
    env.DB.prepare("INSERT INTO evidence_sources VALUES (?, ?)").bind(RISK_CHANGE, CURRENT_RISK),
    env.DB.prepare("INSERT INTO evidence_sources VALUES (?, ?)").bind(RISK_CHANGE, PREVIOUS_RISK),
    env.DB.prepare("INSERT INTO financial_facts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(FACT, CURRENT, "revenue", "Revenue", 120, "$120", "USD", "us-gaap", "Revenues", "Revenue", "duration", "2025-01-01", "2025-12-31", 2025, "FY", "2026-02-01", "https://data.sec.gov/api/xbrl/current.json"),
    env.DB.prepare("INSERT INTO financial_facts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(PREVIOUS_FACT, PREVIOUS, "revenue", "Revenue", 100, "$100", "USD", "us-gaap", "Revenues", "Revenue", "duration", "2024-01-01", "2024-12-31", 2024, "FY", "2025-02-01", "https://data.sec.gov/api/xbrl/previous.json"),
    env.DB.prepare("INSERT INTO financial_facts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(CURRENT_NET_INCOME, CURRENT, "net_income", "Net income", 24, "$24", "USD", "us-gaap", "NetIncomeLoss", "Net income", "duration", "2025-01-01", "2025-12-31", 2025, "FY", "2026-02-01", "https://data.sec.gov/api/xbrl/current-net-income.json"),
    env.DB.prepare("INSERT INTO financial_facts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(PREVIOUS_NET_INCOME, PREVIOUS, "net_income", "Net income", 25, "$25", "USD", "us-gaap", "NetIncomeLoss", "Net income", "duration", "2024-01-01", "2024-12-31", 2024, "FY", "2025-02-01", "https://data.sec.gov/api/xbrl/previous-net-income.json"),
    env.DB.prepare("INSERT INTO ratios VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(RATIO, CURRENT, "net_margin", "Net margin", 0.2, 20, "20.00%", "net_income / revenue", "24 / 120", CURRENT_NET_INCOME, FACT),
    env.DB.prepare("INSERT INTO ratios VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(PREVIOUS_RATIO, PREVIOUS, "net_margin", "Net margin", 0.25, 25, "25.00%", "net_income / revenue", "25 / 100", PREVIOUS_NET_INCOME, PREVIOUS_FACT),
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
      { name: "0005_ai_analysis.sql", queries: aiMigrationQueries },
      { name: "0006_ai_derived_values.sql", queries: derivedMigrationQueries },
      { name: "0007_ai_calculation_audit.sql", queries: calculationAuditMigrationQueries },
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
    expect(pending.response.headers.get("cache-control")).toBe("no-store");
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
      TURNSTILE_HOSTNAMES: "filinglens.ritwikkhare.workers.dev",
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

  it("publishes and caches only citation-valid AI filing analysis", async () => {
    const aiEnv = {
      ...env,
      AI_ENABLED: "true",
      AI_MODEL: "mock-grounded-model",
      AI_RATE_LIMITER: { limit: async () => ({ success: true }) },
    } as unknown as AiEnv;
    let calls = 0;
    const capturedRequests: AiModelRequest[] = [];
    const model = async (request: AiModelRequest) => {
      calls += 1;
      capturedRequests.push(request);
      return {
        sentiment: "bullish",
        confidence: 0.82,
        refused: false,
        refusal_reason: null,
        claims: [
          { kind: "summary", text: "Revenue increased +20.00% versus the prior annual filing.", evidence_ids: [CHANGE] },
          { kind: "supporting", text: "Revenue reached $120 for the current fiscal year.", evidence_ids: [FACT] },
          { kind: "opposing", text: "Current risk language materially changed.", evidence_ids: [RISK_CHANGE] },
          { kind: "uncertainty", text: "Current risk language changed but filing evidence does not measure future effects.", evidence_ids: [RISK_CHANGE] },
        ],
      };
    };
    const request = () => new Request("https://api.example.test/api/v1/companies/TEST/ai-analysis", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ turnstile_token: "test-token" }),
    });
    const challenge = async () => ({ ok: true } as const);
    const created = await generateCompanyAiAnalysis(request(), "TEST", aiEnv, model, challenge);
    const body: any = await created.json();
    expect(created.status).toBe(201);
    expect(body.data).toMatchObject({ ticker: "TEST", sentiment: "bullish", validation_status: "passed" });
    expect(body.data.prompt_version).toBe(AI_PROMPT_VERSION);
    expect(body.data.validation_details).toMatchObject({
      all_numerical_claims_reproduced: true,
      numeric_audit_version: "filinglens-numeric-audit-v1",
    });
    const auditRows = await env.DB.prepare("SELECT status, audit_version, audit_json FROM ai_numeric_audits WHERE response_id = ? ORDER BY claim_id").bind(body.data.response_id).all<Record<string, unknown>>();
    expect(auditRows.results).toHaveLength(4);
    expect(auditRows.results.every((row) => row.audit_version === "filinglens-numeric-audit-v1")).toBe(true);
    expect(capturedRequests[0].messages[0].content).toContain("Copy every financial value and unit exactly as displayed");
    expect(capturedRequests[0].messages[0].content).toContain("do not round, rescale, convert, or perform new arithmetic");
    expect(body.data.evidence.some((entry: any) => entry.source_url?.startsWith("https://www.sec.gov/") || entry.source_url?.startsWith("https://data.sec.gov/"))).toBe(true);
    const cached = await generateCompanyAiAnalysis(request(), "TEST", aiEnv, model, challenge);
    expect(cached.status).toBe(200);
    expect((await cached.json() as any).meta.cached).toBe(true);
    expect(calls).toBe(1);
    expect((await getCompanyAiAnalysis("TEST", aiEnv)).status).toBe(200);
    await env.DB.prepare(
      "INSERT INTO ai_response_invalidations (response_id, reason_code, detail, invalidated_at, invalidated_by) VALUES (?, 'TEST_INVALIDATION', 'Local cache invalidation regression.', CURRENT_TIMESTAMP, 'vitest')",
    ).bind(body.data.response_id).run();
    await env.DB.prepare(
      `INSERT INTO ai_responses
        (response_id, company_id, data_fingerprint, response_type, question, question_hash,
         model, prompt_version, generated_at, sentiment, confidence, refused,
         refusal_reason, validation_status, validation_details_json)
       VALUES ('legacy-v3-response', ?, ?, 'analysis', NULL, '', ?, 'filinglens-grounded-v3',
         CURRENT_TIMESTAMP, 'neutral', 0.1, 1, 'Legacy cached response.', 'passed', '{}')`,
    ).bind(body.data.company_id, body.data.data_fingerprint, aiEnv.AI_MODEL).run();
    expect((await getCompanyAiAnalysis("TEST", aiEnv)).status).toBe(404);
  });

  it.each([
    ["direct object", (output: unknown) => output],
    ["binding response object", (output: unknown) => ({ response: output, usage: { prompt_tokens: 10 } })],
    ["binding response JSON string", (output: unknown) => ({ response: JSON.stringify(output), usage: { prompt_tokens: 10 } })],
    ["REST result response", (output: unknown) => ({ result: { response: JSON.stringify(output) }, success: true })],
    ["OpenAI-compatible choice", (output: unknown) => ({ choices: [{ message: { content: JSON.stringify(output) }, finish_reason: "stop" }] })],
  ])("accepts the documented %s model response shape", async (label, wrap) => {
    const safeModelName = `mock-shape-${label.replace(/[^a-z]+/g, "-")}`;
    const aiEnv = {
      ...env,
      AI_ENABLED: "true",
      AI_MODEL: safeModelName,
      AI_RATE_LIMITER: { limit: async () => ({ success: true }) },
    } as unknown as AiEnv;
    const output = {
      sentiment: "neutral", confidence: 0.75, refused: false, refusal_reason: null,
      claims: [
        { kind: "summary", text: "Revenue increased +20.00% versus the prior annual filing.", evidence_ids: [CHANGE] },
        { kind: "supporting", text: "Revenue reached $120 for the current fiscal year.", evidence_ids: [FACT] },
        { kind: "opposing", text: "Current risk language materially changed.", evidence_ids: [RISK_CHANGE] },
        { kind: "uncertainty", text: "Current risk language does not measure future effects.", evidence_ids: [RISK_CHANGE] },
      ],
    };
    const response = await generateCompanyAiAnalysis(
      new Request("https://api.example.test/api/v1/companies/TEST/ai-analysis", {
        method: "POST", body: JSON.stringify({ turnstile_token: "test-token" }),
      }),
      "TEST", aiEnv, async () => wrap(output), async () => ({ ok: true } as const),
    );
    expect(response.status).toBe(201);
  });

  it("logs only safe provider-shape metadata", () => {
    const secretText = "private filing text must never be logged";
    const metadata = providerResponseMetadata({
      response: {
        sentiment: "neutral", confidence: 0.1, refused: false, refusal_reason: null,
        claims: [{ kind: "summary", text: secretText, evidence_ids: [FACT] }],
      },
      usage: { prompt_tokens: 10 },
    });
    expect(metadata).toMatchObject({
      envelope: "response",
      payload_type: "object",
      claims_count: 1,
      refused: false,
      refusal_reason_state: "null",
    });
    expect(JSON.stringify(metadata)).not.toContain(secretText);
    expect(JSON.stringify(metadata)).not.toContain(FACT);
  });

  it.each(["", "   \t\n"])("normalizes a blank non-refusal reason and validates all claims", async (refusalReason) => {
    const packet = await loadGroundingPacket(env.DB, "TEST");
    expect(packet).not.toBeNull();
    const result = validateGroundedOutput({
      sentiment: "neutral", confidence: 0.7, refused: false, refusal_reason: refusalReason,
      claims: [
        { kind: "summary", text: "Revenue increased +20.00% versus the prior annual filing.", evidence_ids: [CHANGE] },
        { kind: "supporting", text: "Revenue reached $120 for the current fiscal year.", evidence_ids: [FACT] },
        { kind: "opposing", text: "Current risk language materially changed.", evidence_ids: [RISK_CHANGE] },
        { kind: "uncertainty", text: "Current risk language does not measure future effects.", evidence_ids: [RISK_CHANGE] },
      ],
    }, packet!, "analysis");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output.refusal_reason).toBeNull();
  });

  it("classifies refusal reasons structurally without logging their content", () => {
    const meaningfulReason = "private refusal detail must never be logged";
    const blank = providerResponseMetadata({
      response: { sentiment: "neutral", confidence: 0.7, refused: false, refusal_reason: "  ", claims: [] },
    });
    const nonempty = providerResponseMetadata({
      response: { sentiment: "neutral", confidence: 0.7, refused: false, refusal_reason: meaningfulReason, claims: [] },
    });
    expect(blank.refusal_reason_state).toBe("blank");
    expect(nonempty.refusal_reason_state).toBe("nonempty");
    expect(JSON.stringify(nonempty)).not.toContain(meaningfulReason);
  });

  it("retries one meaningful inconsistent non-refusal and accepts a corrected response", async () => {
    const aiEnv = {
      ...env,
      AI_ENABLED: "true",
      AI_MODEL: "mock-inconsistent-refusal-corrected",
      AI_RATE_LIMITER: { limit: async () => ({ success: true }) },
    } as unknown as AiEnv;
    const validClaims = [
      { kind: "summary", text: "Revenue increased +20.00% versus the prior annual filing.", evidence_ids: [CHANGE] },
      { kind: "supporting", text: "Revenue reached $120 for the current fiscal year.", evidence_ids: [FACT] },
      { kind: "opposing", text: "Current risk language materially changed.", evidence_ids: [RISK_CHANGE] },
      { kind: "uncertainty", text: "Current risk language does not measure future effects.", evidence_ids: [RISK_CHANGE] },
    ];
    let calls = 0;
    const response = await generateCompanyAiAnalysis(
      new Request("https://api.example.test/api/v1/companies/TEST/ai-analysis", {
        method: "POST", body: JSON.stringify({ turnstile_token: "test-token" }),
      }),
      "TEST", aiEnv, async () => ({
        sentiment: "neutral", confidence: 0.7, refused: false,
        refusal_reason: ++calls === 1 ? "The output is not a refusal." : null,
        claims: validClaims,
      }),
      async () => ({ ok: true } as const),
    );
    expect(response.status).toBe(201);
    expect(calls).toBe(2);
  });

  it("rejects a persistent inconsistent refusal state after one correction and publishes nothing", async () => {
    const aiEnv = {
      ...env,
      AI_ENABLED: "true",
      AI_MODEL: "mock-inconsistent-refusal-persistent",
      AI_RATE_LIMITER: { limit: async () => ({ success: true }) },
    } as unknown as AiEnv;
    const before = await env.DB.prepare("SELECT COUNT(*) AS count FROM ai_responses").first<{ count: number }>();
    let calls = 0;
    const response = await generateCompanyAiAnalysis(
      new Request("https://api.example.test/api/v1/companies/TEST/ai-analysis", {
        method: "POST", body: JSON.stringify({ turnstile_token: "test-token" }),
      }),
      "TEST", aiEnv, async () => {
        calls += 1;
        return {
          sentiment: "neutral", confidence: 0.7, refused: false, refusal_reason: "Still inconsistent.",
          claims: [{ kind: "summary", text: "Revenue reached $120.", evidence_ids: [FACT] }],
        };
      },
      async () => ({ ok: true } as const),
    );
    const body = await response.json() as { data?: { error?: { code?: string } } };
    const after = await env.DB.prepare("SELECT COUNT(*) AS count FROM ai_responses").first<{ count: number }>();
    expect(response.status).toBe(422);
    expect(body.data?.error?.code).toBe("AI_VALIDATION_FAILED");
    expect(calls).toBe(2);
    expect(after?.count).toBe(before?.count);
  });

  it("enforces the complete refusal contract", async () => {
    const packet = await loadGroundingPacket(env.DB, "TEST");
    expect(packet).not.toBeNull();
    expect(validateGroundedOutput({
      sentiment: "neutral", confidence: 0.1, refused: true,
      refusal_reason: "The SEC evidence does not support this request.", claims: [],
    }, packet!, "analysis")).toMatchObject({ ok: true });
    for (const refusalReason of [null, "", "   "]) {
      expect(validateGroundedOutput({
        sentiment: "neutral", confidence: 0.1, refused: true, refusal_reason: refusalReason, claims: [],
      }, packet!, "analysis")).toMatchObject({ ok: false, code: "INVALID_REFUSAL" });
    }
    expect(validateGroundedOutput({
      sentiment: "neutral", confidence: 0.1, refused: true,
      refusal_reason: "The SEC evidence does not support this request.",
      claims: [{ kind: "summary", text: "Revenue reached $120.", evidence_ids: [FACT] }],
    }, packet!, "analysis")).toMatchObject({ ok: false, code: "INVALID_REFUSAL" });
  });

  it.each([
    ["empty non-refusal", { sentiment: "neutral", confidence: 0, refused: false, refusal_reason: null, claims: [] }],
    ["malformed JSON", { response: '{"sentiment":' }],
    ["truncated OpenAI-compatible content", { choices: [{ message: { content: '{"sentiment":"neutral"' }, finish_reason: "length" }] }],
  ])("retries %s exactly once and publishes only the valid second result", async (label, firstOutput) => {
    const aiEnv = {
      ...env,
      AI_ENABLED: "true",
      AI_MODEL: `mock-recovery-${label.replace(/[^a-z]+/g, "-")}`,
      AI_RATE_LIMITER: { limit: async () => ({ success: true }) },
    } as unknown as AiEnv;
    const valid = {
      sentiment: "neutral", confidence: 0.7, refused: false, refusal_reason: null,
      claims: [
        { kind: "summary", text: "Revenue increased +20.00% versus the prior annual filing.", evidence_ids: [CHANGE] },
        { kind: "supporting", text: "Revenue reached $120 for the current fiscal year.", evidence_ids: [FACT] },
        { kind: "opposing", text: "Current risk language materially changed.", evidence_ids: [RISK_CHANGE] },
        { kind: "uncertainty", text: "Current risk language does not measure future effects.", evidence_ids: [RISK_CHANGE] },
      ],
    };
    let calls = 0;
    const requests: AiModelRequest[] = [];
    const response = await generateCompanyAiAnalysis(
      new Request("https://api.example.test/api/v1/companies/TEST/ai-analysis", {
        method: "POST", body: JSON.stringify({ turnstile_token: "test-token" }),
      }),
      "TEST", aiEnv, async (request) => {
        requests.push(request);
        return ++calls === 1 ? firstOutput : { response: valid };
      },
      async () => ({ ok: true } as const),
    );
    expect(response.status).toBe(201);
    expect(calls).toBe(2);
    expect(requests[1].messages.some((message) => message.role === "system" && message.content.includes("preceding provider result"))).toBe(true);
    expect(requests[1].messages.find((message) => message.role === "user")?.content)
      .toBe(requests[0].messages.find((message) => message.role === "user")?.content);
  });

  it("stops after one retry when provider output stays malformed and publishes nothing", async () => {
    const aiEnv = {
      ...env,
      AI_ENABLED: "true",
      AI_MODEL: "mock-double-malformed",
      AI_RATE_LIMITER: { limit: async () => ({ success: true }) },
    } as unknown as AiEnv;
    const before = await env.DB.prepare("SELECT COUNT(*) AS count FROM ai_responses").first<{ count: number }>();
    let calls = 0;
    const response = await generateCompanyAiAnalysis(
      new Request("https://api.example.test/api/v1/companies/TEST/ai-analysis", {
        method: "POST", body: JSON.stringify({ turnstile_token: "test-token" }),
      }),
      "TEST", aiEnv, async () => { calls += 1; return { response: "{" }; },
      async () => ({ ok: true } as const),
    );
    const after = await env.DB.prepare("SELECT COUNT(*) AS count FROM ai_responses").first<{ count: number }>();
    expect(response.status).toBe(422);
    expect(calls).toBe(2);
    expect(after?.count).toBe(before?.count);
  });

  it("does not retry a well-formed response that fails SEC evidence validation", async () => {
    const aiEnv = {
      ...env,
      AI_ENABLED: "true",
      AI_MODEL: "mock-nonretriable-validation-failure",
      AI_RATE_LIMITER: { limit: async () => ({ success: true }) },
    } as unknown as AiEnv;
    let calls = 0;
    const response = await generateCompanyAiAnalysis(
      new Request("https://api.example.test/api/v1/companies/TEST/ai-analysis", {
        method: "POST", body: JSON.stringify({ turnstile_token: "test-token" }),
      }),
      "TEST", aiEnv, async () => {
        calls += 1;
        return {
          sentiment: "neutral", confidence: 0.7, refused: false, refusal_reason: null,
          claims: [
            { kind: "summary", text: "Revenue reached $999.", evidence_ids: [FACT] },
            { kind: "supporting", text: "Revenue reached $120.", evidence_ids: [FACT] },
            { kind: "opposing", text: "Current risk language materially changed.", evidence_ids: [RISK_CHANGE] },
            { kind: "uncertainty", text: "Current risk language does not measure future effects.", evidence_ids: [RISK_CHANGE] },
          ],
        };
      },
      async () => ({ ok: true } as const),
    );
    expect(response.status).toBe(422);
    expect(calls).toBe(1);
  });

  it.each([
    ["invalid citation", { kind: "summary", text: "Revenue reached $120.", evidence_ids: ["outside-packet"] }],
    ["stock prediction", { kind: "summary", text: "Revenue means investors should buy the stock.", evidence_ids: [FACT] }],
  ])("does not retry a %s validation failure", async (label, summaryClaim) => {
    const aiEnv = {
      ...env,
      AI_ENABLED: "true",
      AI_MODEL: `mock-zero-retry-${label.replace(/[^a-z]+/g, "-")}`,
      AI_RATE_LIMITER: { limit: async () => ({ success: true }) },
    } as unknown as AiEnv;
    let calls = 0;
    const response = await generateCompanyAiAnalysis(
      new Request("https://api.example.test/api/v1/companies/TEST/ai-analysis", {
        method: "POST", body: JSON.stringify({ turnstile_token: "test-token" }),
      }),
      "TEST", aiEnv, async () => {
        calls += 1;
        return {
          sentiment: "neutral", confidence: 0.7, refused: false, refusal_reason: null,
          claims: [
            summaryClaim,
            { kind: "supporting", text: "Revenue reached $120.", evidence_ids: [FACT] },
            { kind: "opposing", text: "Current risk language materially changed.", evidence_ids: [RISK_CHANGE] },
            { kind: "uncertainty", text: "Current risk language does not measure future effects.", evidence_ids: [RISK_CHANGE] },
          ],
        };
      },
      async () => ({ ok: true } as const),
    );
    expect(response.status).toBe(422);
    expect(calls).toBe(1);
  });

  it("materializes approved calculations with complete SEC evidence metadata", async () => {
    const company = await env.DB.prepare("SELECT id FROM companies WHERE ticker = 'TEST'").first<{ id: number }>();
    await materializeApprovedDerivedEvidence(env.DB, company!.id, "TEST", [CURRENT]);
    const rows = await env.DB.prepare(
      "SELECT value_kind, formula_key, unrounded_value, displayed_value, unit, input_evidence_ids_json, sec_links_json FROM ai_derived_values ORDER BY value_kind",
    ).all<Record<string, unknown>>();
    const percentageChange = rows.results.find((row) => row.value_kind === "percentage_change");
    const percentagePointRow = rows.results.find((row) => row.value_kind === "percentage_point_change");
    const ratioChange = rows.results.find((row) => row.value_kind === "ratio_change");
    expect(percentageChange).toMatchObject({ formula_key: "percentage_change", displayed_value: "+20.00%", unit: "percent" });
    expect(Number(percentageChange?.unrounded_value)).toBeCloseTo(20, 12);
    expect(percentagePointRow).toMatchObject({ formula_key: "percentage_point_change", displayed_value: "-5.00 percentage points", unit: "percentage_points" });
    expect(Number(percentagePointRow?.unrounded_value)).toBeCloseTo(-5, 12);
    expect(ratioChange).toMatchObject({ formula_key: "ratio_change", displayed_value: "-0.0500", unit: "ratio" });
    expect(Number(ratioChange?.unrounded_value)).toBeCloseTo(-0.05, 12);
    for (const row of rows.results) {
      expect(JSON.parse(String(row.input_evidence_ids_json))).toHaveLength(2);
      const links = JSON.parse(String(row.sec_links_json));
      expect(links.length).toBeGreaterThan(0);
      expect(links.every((link: string) => /^https:\/\/(?:www|data)\.sec\.gov\//.test(link))).toBe(true);
    }
    const grounded = await loadGroundingPacket(env.DB, "TEST");
    const percentagePoint = grounded!.items.find((entry) => entry.derived?.value_kind === "percentage_point_change");
    expect(percentagePoint).toMatchObject({
      derived: {
        formula: "(current_ratio - previous_ratio) * 100",
        displayed_value: "-5.00 percentage points",
        input_evidence_ids: [RATIO, PREVIOUS_RATIO],
      },
    });
    expect(percentagePoint?.derived).toMatchObject({
      calculation_version: AI_CALCULATION_VERSION,
      display_precision: 2,
      reproduction_status: "reproduced",
    });
    expect(percentagePoint?.derived?.exact_inputs).toHaveLength(4);
  });

  it("recomputes the AAPL quarterly ratio change from direct facts instead of the rounded comparison", async () => {
    const currentQ = "0000000001-26-000010";
    const previousQ = "0000000001-25-000010";
    const facts = {
      currentLiabilities: `TEST-${currentQ}-liabilities`,
      currentAssets: `TEST-${currentQ}-assets`,
      previousLiabilities: `TEST-${previousQ}-liabilities`,
      previousAssets: `TEST-${previousQ}-assets`,
    };
    const currentRatio = `TEST-${currentQ}-liabilities-to-assets`;
    const previousRatio = `TEST-${previousQ}-liabilities-to-assets`;
    const roundedCandidate = `TEST-${currentQ}-rounded-pp-change`;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO filings (accession_number, company_id, schema_version, form, filing_date, report_date, official_url, filing_index_url) SELECT ?, id, '1.0.0', '10-Q', ?, ?, ?, ? FROM companies WHERE ticker = 'TEST'").bind(currentQ, "2026-05-01", "2026-03-31", "https://www.sec.gov/Archives/test-current-q.htm", "https://www.sec.gov/Archives/test-current-q-index.html"),
      env.DB.prepare("INSERT INTO filings (accession_number, company_id, schema_version, form, filing_date, report_date, official_url, filing_index_url) SELECT ?, id, '1.0.0', '10-Q', ?, ?, ?, ? FROM companies WHERE ticker = 'TEST'").bind(previousQ, "2025-05-01", "2025-03-31", "https://www.sec.gov/Archives/test-previous-q.htm", "https://www.sec.gov/Archives/test-previous-q-index.html"),
    ]);
    const evidenceRows = [
      [facts.currentLiabilities, "xbrl_fact", "Current liabilities", currentQ, "https://data.sec.gov/api/xbrl/current-liabilities.json"],
      [facts.currentAssets, "xbrl_fact", "Current assets", currentQ, "https://data.sec.gov/api/xbrl/current-assets.json"],
      [facts.previousLiabilities, "xbrl_fact", "Previous liabilities", previousQ, "https://data.sec.gov/api/xbrl/previous-liabilities.json"],
      [facts.previousAssets, "xbrl_fact", "Previous assets", previousQ, "https://data.sec.gov/api/xbrl/previous-assets.json"],
      [currentRatio, "derived_ratio", "Liabilities to assets", currentQ, null],
      [previousRatio, "derived_ratio", "Liabilities to assets", previousQ, null],
      [roundedCandidate, "derived_comparison", "Liabilities to assets change", currentQ, null],
    ];
    await env.DB.batch(evidenceRows.map((row) => env.DB.prepare("INSERT INTO evidence_links (evidence_id, schema_version, evidence_type, label, filing_accession, source_url) VALUES (?, '1.0.0', ?, ?, ?, ?)").bind(...row)));
    const factRow = (id: string, accession: string, key: string, name: string, value: number, url: string) => env.DB.prepare("INSERT INTO financial_facts VALUES (?, ?, ?, ?, ?, ?, 'USD', 'us-gaap', ?, ?, 'instant', NULL, ?, 2026, 'Q2', ?, ?)")
      .bind(id, accession, key, name, value, `$${value}`, key, name, accession === currentQ ? "2026-03-31" : "2025-03-31", accession === currentQ ? "2026-05-01" : "2025-05-01", url);
    await env.DB.batch([
      factRow(facts.currentLiabilities, currentQ, "liabilities", "Liabilities", 275_746_000_000, "https://data.sec.gov/api/xbrl/current-liabilities.json"),
      factRow(facts.currentAssets, currentQ, "assets", "Assets", 383_266_000_000, "https://data.sec.gov/api/xbrl/current-assets.json"),
      factRow(facts.previousLiabilities, previousQ, "liabilities", "Liabilities", 265_665_000_000, "https://data.sec.gov/api/xbrl/previous-liabilities.json"),
      factRow(facts.previousAssets, previousQ, "assets", "Assets", 331_495_000_000, "https://data.sec.gov/api/xbrl/previous-assets.json"),
      env.DB.prepare("INSERT INTO ratios VALUES (?, ?, 'liabilities_to_assets', 'Liabilities to assets', ?, ?, '71.95%', 'liabilities / assets', 'rounded display only', ?, ?)").bind(currentRatio, currentQ, 0.7195, 71.95, facts.currentLiabilities, facts.currentAssets),
      env.DB.prepare("INSERT INTO ratios VALUES (?, ?, 'liabilities_to_assets', 'Liabilities to assets', ?, ?, '80.14%', 'liabilities / assets', 'rounded display only', ?, ?)").bind(previousRatio, previousQ, 0.8014, 80.14, facts.previousLiabilities, facts.previousAssets),
      env.DB.prepare("INSERT INTO filing_comparisons (comparison_id, company_id, schema_version, current_accession, previous_accession, form, comparison_basis, fiscal_period, calculated_at) SELECT 'TEST-q-comparison', id, '1.0.0', ?, ?, '10-Q', 'same_fiscal_quarter_prior_year', 'Q2', '2026-05-01' FROM companies WHERE ticker = 'TEST'").bind(currentQ, previousQ),
      env.DB.prepare("INSERT INTO comparison_changes VALUES (?, 'TEST-q-comparison', 'liabilities_to_assets', 'Liabilities to assets', 'percentage_point_change', 'decreased', -8.19, '-8.19 percentage points', '(current_ratio - previous_ratio) * 100', ?, ?)").bind(roundedCandidate, currentRatio, previousRatio),
      env.DB.prepare("INSERT INTO evidence_sources VALUES (?, ?)").bind(currentRatio, facts.currentLiabilities),
      env.DB.prepare("INSERT INTO evidence_sources VALUES (?, ?)").bind(currentRatio, facts.currentAssets),
      env.DB.prepare("INSERT INTO evidence_sources VALUES (?, ?)").bind(previousRatio, facts.previousLiabilities),
      env.DB.prepare("INSERT INTO evidence_sources VALUES (?, ?)").bind(previousRatio, facts.previousAssets),
      env.DB.prepare("INSERT INTO evidence_sources VALUES (?, ?)").bind(roundedCandidate, currentRatio),
      env.DB.prepare("INSERT INTO evidence_sources VALUES (?, ?)").bind(roundedCandidate, previousRatio),
    ]);
    const company = await env.DB.prepare("SELECT id FROM companies WHERE ticker = 'TEST'").first<{ id: number }>();
    await materializeApprovedDerivedEvidence(env.DB, company!.id, "TEST", [currentQ]);
    const corrected = await env.DB.prepare("SELECT * FROM ai_derived_values WHERE current_accession = ? AND formula_key = 'percentage_point_change'").bind(currentQ).first<Record<string, unknown>>();
    expect(Number(corrected?.unrounded_value)).toBe(-8.195103595752384);
    expect(corrected?.displayed_value).toBe("-8.20 percentage points");
    expect(corrected?.calculation_version).toBe(AI_CALCULATION_VERSION);
    expect(JSON.parse(String(corrected?.exact_inputs_json))).toHaveLength(4);
    expect(JSON.parse(String(corrected?.dependency_path_json)).filter((step: any) => step.operation === "divide")).toHaveLength(2);
    expect(String(corrected?.displayed_value)).not.toBe("-8.19 percentage points");
  });

  it("uses deterministic half-away-from-zero display rounding", () => {
    expect(roundHalfAwayFromZero(1.005, 2)).toBe(1.01);
    expect(roundHalfAwayFromZero(-1.005, 2)).toBe(-1.01);
    expect(roundHalfAwayFromZero(8.195, 2)).toBe(8.2);
    expect(roundHalfAwayFromZero(-8.195, 2)).toBe(-8.2);
    expect(roundHalfAwayFromZero(-0.00001, 2)).toBe(0);
    expect(reproduceRatioValue(-10, 4)).toBe(-2.5);
    expect(() => reproduceRatioValue(10, 0)).toThrow("zero_denominator");
    expect(() => reproduceRatioValue(Number.NaN, 5)).toThrow("invalid_ratio_input");
  });

  it("rejects a tampered derived record and restores it with a versioned upsert", async () => {
    const currentQ = "0000000001-26-000010";
    const row = await env.DB.prepare("SELECT evidence_id FROM ai_derived_values WHERE current_accession = ? AND formula_key = 'percentage_point_change'").bind(currentQ).first<{ evidence_id: string }>();
    await env.DB.prepare("UPDATE ai_derived_values SET unrounded_value = -8.19, displayed_value = '-8.19 percentage points' WHERE evidence_id = ?").bind(row!.evidence_id).run();
    await expect(loadGroundingPacket(env.DB, "TEST")).rejects.toThrow("derived_unrounded_mismatch");
    const company = await env.DB.prepare("SELECT id FROM companies WHERE ticker = 'TEST'").first<{ id: number }>();
    await materializeApprovedDerivedEvidence(env.DB, company!.id, "TEST", [currentQ]);
    const restored = await env.DB.prepare("SELECT unrounded_value, displayed_value, calculation_version FROM ai_derived_values WHERE evidence_id = ?").bind(row!.evidence_id).first<Record<string, unknown>>();
    expect(Number(restored?.unrounded_value)).toBe(-8.195103595752384);
    expect(restored).toMatchObject({ displayed_value: "-8.20 percentage points", calculation_version: AI_CALCULATION_VERSION });
  });

  it("rejects invented numbers, invalid citations, stock predictions, and malformed schema", async () => {
    const packet = await loadGroundingPacket(env.DB, "TEST");
    expect(packet).not.toBeNull();
    const base = { sentiment: "neutral", confidence: 0.5, refused: false, refusal_reason: null };
    const complete = (summary: any) => [summary,
      { kind: "supporting", text: "Revenue reached $120.", evidence_ids: [FACT] },
      { kind: "opposing", text: "Current risk language materially changed.", evidence_ids: [RISK_CHANGE] },
      { kind: "uncertainty", text: "Current risk language does not measure future effects.", evidence_ids: [RISK_CHANGE] },
    ];
    expect(validateGroundedOutput({ ...base, claims: complete({ kind: "summary", text: "Revenue reached $999.", evidence_ids: [FACT] }) }, packet!, "analysis")).toMatchObject({ ok: false, code: "NUMERIC_MISMATCH" });
    expect(validateGroundedOutput({ ...base, claims: complete({ kind: "summary", text: "Revenue reached $120.", evidence_ids: ["outside-packet"] }) }, packet!, "analysis")).toMatchObject({ ok: false, code: "INVALID_CITATION" });
    expect(validateGroundedOutput({ ...base, claims: complete({ kind: "summary", text: "Revenue means investors should buy the stock.", evidence_ids: [FACT] }) }, packet!, "analysis")).toMatchObject({ ok: false, code: "STOCK_PREDICTION" });
    expect(validateGroundedOutput({ ...base, extra: true, claims: [] }, packet!, "analysis")).toMatchObject({ ok: false, code: "MALFORMED_MODEL_OUTPUT" });
  });

  it("does not partially publish a numerically invalid AI response", async () => {
    const aiEnv = {
      ...env,
      AI_ENABLED: "true",
      AI_MODEL: "mock-numeric-rejection-model",
      AI_RATE_LIMITER: { limit: async () => ({ success: true }) },
    } as unknown as AiEnv;
    const before = await env.DB.prepare("SELECT COUNT(*) AS count FROM ai_responses").first<{ count: number }>();
    const response = await generateCompanyAiAnalysis(
      new Request("https://api.example.test/api/v1/companies/TEST/ai-analysis", {
        method: "POST",
        body: JSON.stringify({ turnstile_token: "test-token" }),
      }),
      "TEST",
      aiEnv,
      async () => ({
        sentiment: "neutral", confidence: 0.7, refused: false, refusal_reason: null,
        claims: [
          { kind: "summary", text: "Revenue reached $999.", evidence_ids: [FACT] },
          { kind: "supporting", text: "Revenue reached $120.", evidence_ids: [FACT] },
          { kind: "opposing", text: "Current risk language materially changed.", evidence_ids: [RISK_CHANGE] },
          { kind: "uncertainty", text: "Current risk language does not measure future effects.", evidence_ids: [RISK_CHANGE] },
        ],
      }),
      async () => ({ ok: true } as const),
    );
    const after = await env.DB.prepare("SELECT COUNT(*) AS count FROM ai_responses").first<{ count: number }>();
    expect(response.status).toBe(422);
    expect(after?.count).toBe(before?.count);
  });

  it("answers filing questions with citations and safely refuses unsupported questions", async () => {
    const aiEnv = {
      ...env,
      AI_ENABLED: "true",
      AI_MODEL: "mock-qa-model",
      AI_RATE_LIMITER: { limit: async () => ({ success: true }) },
    } as unknown as AiEnv;
    const challenge = async () => ({ ok: true } as const);
    const request = (question: string) => new Request("https://api.example.test/api/v1/companies/TEST/ai-questions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ turnstile_token: "test-token", question }),
    });
    const answered = await askCompanyAiQuestion(request("What was revenue?"), "TEST", aiEnv, async () => ({
      sentiment: "neutral", confidence: 0.95, refused: false, refusal_reason: null,
      claims: [{ kind: "answer", text: "Revenue was $120 for the current fiscal year.", evidence_ids: [FACT] }],
    }), challenge);
    expect(answered.status).toBe(201);
    expect((await answered.json() as any).data.claims[0].evidence_ids).toEqual([FACT]);
    const refused = await askCompanyAiQuestion(request("What will the stock price be?"), "TEST", { ...aiEnv, AI_MODEL: "mock-refusal-model" }, async () => ({
      sentiment: "neutral", confidence: 0.1, refused: true,
      refusal_reason: "The supplied SEC evidence cannot support a stock-price prediction.", claims: [],
    }), challenge);
    expect(refused.status).toBe(201);
    expect((await refused.json() as any).data).toMatchObject({ refused: true, sentiment: "neutral" });
  });

  it("enforces AI disablement, request size, Turnstile, and rate limiting before model use", async () => {
    const base = {
      ...env, AI_ENABLED: "true", AI_MODEL: "mock-controls",
      AI_RATE_LIMITER: { limit: async () => ({ success: true }) },
    } as unknown as AiEnv;
    const model = async () => { throw new Error("model must not run"); };
    const make = (body: string) => new Request("https://api.example.test", { method: "POST", body });
    expect((await generateCompanyAiAnalysis(make("{}"), "TEST", { ...base, AI_ENABLED: "false" }, model)).status).toBe(503);
    expect((await generateCompanyAiAnalysis(make("{}"), "TEST", { ...base, AI_RATE_LIMITER: { limit: async () => ({ success: false }) } }, model)).status).toBe(429);
    expect((await generateCompanyAiAnalysis(make(JSON.stringify({ turnstile_token: "x" })), "TEST", base, model, async () => ({ ok: false, code: "REJECTED" }))).status).toBe(403);
    expect((await generateCompanyAiAnalysis(make(JSON.stringify({ turnstile_token: "x", padding: "x".repeat(9_000) })), "TEST", base, model, async () => ({ ok: true }))).status).toBe(400);
  });

  it("does not consume a processing attempt when GitHub dispatch is temporarily unavailable", async () => {
    await env.DB.prepare("DELETE FROM analysis_jobs WHERE ticker = 'FRESH'").run();
    const sent: AnalysisQueueMessage[] = [];
    const onboardingEnv: OnboardingEnv = {
      DB: env.DB,
      ANALYSIS_QUEUE: fakeQueue(sent),
      TICKER_SEARCH_RATE_LIMITER: { limit: async () => ({ success: true }) },
      ONBOARDING_RATE_LIMITER: { limit: async () => ({ success: true }) },
      ONBOARDING_ENABLED: "true",
      GITHUB_REPOSITORY: "ritwikkhare/10kAnalysis",
      TURNSTILE_ACTION: "analyze_ticker",
      TURNSTILE_HOSTNAMES: "filinglens.ritwikkhare.workers.dev",
    };
    const challenge = async () => ({ ok: true } as const);
    const request = new Request("https://api.example.test", {
      method: "POST",
      body: JSON.stringify({ turnstile_token: "fresh-token" }),
    });
    const created = await createAnalysisJob(request, "FRESH", onboardingEnv, challenge);
    const job: any = (await created.json() as any).data;
    let retried = false;
    const firstDelivery = {
      id: "queue-transient-1", timestamp: new Date(), body: sent[0], attempts: 1,
      ack: () => { throw new Error("transient delivery must not be acknowledged"); },
      retry: () => { retried = true; },
    } as Message<AnalysisQueueMessage>;
    await consumeAnalysisQueue(
      { queue: "filinglens-analysis", messages: [firstDelivery], metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } }, ackAll: () => {}, retryAll: () => {} },
      onboardingEnv,
      async () => new Response(null, { status: 503 }),
    );
    expect(retried).toBe(true);
    let status: any = (await (await analysisJobStatus(job.job_id, onboardingEnv)).json() as any).data;
    expect(status).toMatchObject({ status: "queued", attempt_count: 0 });

    let acknowledged = false;
    const secondDelivery = {
      ...firstDelivery, id: "queue-transient-2", attempts: 2,
      ack: () => { acknowledged = true; },
      retry: () => { throw new Error("successful dispatch must not retry"); },
    } as Message<AnalysisQueueMessage>;
    await consumeAnalysisQueue(
      { queue: "filinglens-analysis", messages: [secondDelivery], metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } }, ackAll: () => {}, retryAll: () => {} },
      onboardingEnv,
      async () => new Response(null, { status: 204 }),
    );
    expect(acknowledged).toBe(true);
    status = (await (await analysisJobStatus(job.job_id, onboardingEnv)).json() as any).data;
    expect(status).toMatchObject({ status: "processing", attempt_count: 1 });
  });

  it("safely resumes authorization interrupted before GitHub accepted it", async () => {
    await env.DB.prepare("DELETE FROM analysis_jobs WHERE ticker = 'FRESH'").run();
    const sent: AnalysisQueueMessage[] = [];
    const onboardingEnv: OnboardingEnv = {
      DB: env.DB,
      ANALYSIS_QUEUE: fakeQueue(sent),
      TICKER_SEARCH_RATE_LIMITER: { limit: async () => ({ success: true }) },
      ONBOARDING_RATE_LIMITER: { limit: async () => ({ success: true }) },
      ONBOARDING_ENABLED: "true",
      GITHUB_REPOSITORY: "ritwikkhare/10kAnalysis",
      TURNSTILE_ACTION: "analyze_ticker",
      TURNSTILE_HOSTNAMES: "filinglens.ritwikkhare.workers.dev",
    };
    const created = await createAnalysisJob(
      new Request("https://api.example.test", {
        method: "POST",
        body: JSON.stringify({ turnstile_token: "resume-token" }),
      }),
      "FRESH",
      onboardingEnv,
      async () => ({ ok: true } as const),
    );
    const job: any = (await created.json() as any).data;
    await env.DB.prepare(
      "UPDATE analysis_jobs SET status = 'processing', attempt_count = 0 WHERE job_id = ?",
    ).bind(job.job_id).run();

    let acknowledged = false;
    await consumeAnalysisQueue(
      {
        queue: "filinglens-analysis",
        messages: [{
          id: "queue-resume", timestamp: new Date(), body: sent[0], attempts: 2,
          ack: () => { acknowledged = true; },
          retry: () => { throw new Error("resumed authorization must not retry"); },
        } as Message<AnalysisQueueMessage>],
        metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
        ackAll: () => {}, retryAll: () => {},
      },
      onboardingEnv,
      async () => new Response(null, { status: 204 }),
    );

    expect(acknowledged).toBe(true);
    const status: any = (await (await analysisJobStatus(job.job_id, onboardingEnv)).json() as any).data;
    expect(status).toMatchObject({ status: "processing", attempt_count: 1 });
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
      TURNSTILE_HOSTNAMES: "filinglens.ritwikkhare.workers.dev",
    } satisfies OnboardingEnv;
    const challenge = async () => ({ ok: true } as const);
    const makeRequest = () => new Request("https://api.example.test", { method: "POST", body: JSON.stringify({ turnstile_token: "token" }) });
    expect((await createAnalysisJob(makeRequest(), "NOPE", base, challenge)).status).toBe(404);
    expect((await createAnalysisJob(makeRequest(), "TEST", base, challenge)).status).toBe(409);
    expect((await createAnalysisJob(makeRequest(), "NOPE", { ...base, ONBOARDING_ENABLED: "false" }, challenge)).status).toBe(503);
    expect((await createAnalysisJob(makeRequest(), "NOPE", {
      ...base,
      ONBOARDING_RATE_LIMITER: { limit: async () => ({ success: false }) },
    }, challenge)).status).toBe(429);
  });
});
