import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import migrationSql from "../migrations/0001_initial.sql?raw";
import directoryMigrationSql from "../migrations/0003_sec_company_directory.sql?raw";
import marketMigrationSql from "../migrations/0008_market_research.sql?raw";
import {
  benchmarkYear,
  eightKHeadline,
  generateBrief,
  getBrief,
  industryBenchmark,
  median,
  newsFeed,
  percentileRank,
  type Fetcher,
  type ResearchEnv,
} from "../src/research.js";
import type { AiModelRequest } from "../src/ai.js";

const queries = (sql: string) => sql.split(";").map((query) => query.trim()).filter(Boolean);
const NOW = new Date("2026-10-21T15:00:00Z");
const clock = () => NOW;
const SUBJECT_CIK = "0000000101";
const challenge = async () => ({ ok: true } as const);
const okLimiter = { limit: async () => ({ success: true }) };

function researchEnv(overrides: Partial<ResearchEnv> = {}): ResearchEnv {
  return {
    ...env,
    AI_ENABLED: "true",
    AI_MODEL: "mock-market-model",
    AI_RATE_LIMITER: okLimiter,
    TICKER_SEARCH_RATE_LIMITER: okLimiter,
    SEC_USER_AGENT: "FilingLens tests tests@example.com",
    FINNHUB_API_KEY: "test-key",
    ...overrides,
  } as unknown as ResearchEnv;
}

const frames: Record<string, Array<{ cik: number; val: number; accn: string }>> = {
  "Revenues/USD/CY2025": [
    { cik: 101, val: 120e9, accn: "0000000101-26-000001" },
    { cik: 102, val: 200e9, accn: "0000000102-26-000001" },
    { cik: 103, val: 50e9, accn: "0000000103-26-000001" },
    { cik: 104, val: 10e9, accn: "0000000104-26-000001" },
    { cik: 999, val: 900e9, accn: "0000000999-26-000001" },
  ],
  "Revenues/USD/CY2024": [
    { cik: 101, val: 100e9, accn: "0000000101-25-000001" },
    { cik: 102, val: 160e9, accn: "0000000102-25-000001" },
  ],
  "NetIncomeLoss/USD/CY2025": [
    { cik: 101, val: 30e9, accn: "x" }, { cik: 102, val: 20e9, accn: "x" },
    { cik: 103, val: 10e9, accn: "x" }, { cik: 104, val: -1e9, accn: "x" },
  ],
  "NetCashProvidedByUsedInOperatingActivities/USD/CY2025": [{ cik: 101, val: 36e9, accn: "x" }],
  "Assets/USD/CY2025Q4I": [{ cik: 101, val: 400e9, accn: "x" }, { cik: 102, val: 100e9, accn: "x" }],
  "Liabilities/USD/CY2025Q4I": [{ cik: 101, val: 300e9, accn: "x" }, { cik: 102, val: 40e9, accn: "x" }],
};

const submissions = {
  name: "Market Test Corp",
  sic: "3571",
  sicDescription: "Electronic Computers",
  filings: {
    recent: {
      form: ["8-K", "10-Q", "8-K", "8-K"],
      accessionNumber: ["0000000101-26-000050", "0000000101-26-000040", "0000000101-26-000030", "0000000101-25-000010"],
      filingDate: ["2026-10-01", "2026-08-01", "2026-07-15", "2025-01-10"],
      items: ["2.02,9.01", "", "5.02", "8.01"],
      primaryDocument: ["earnings.htm", "q.htm", "officer.htm", "old.htm"],
    },
  },
};

const press = (symbol: string) => symbol === "MKT"
  ? [
    { id: 11, datetime: Date.parse("2026-10-20T12:00:00Z") / 1000, headline: "Market Test Corp raises outlook after 20% sales jump", source: "Wire", summary: "Sales rose 20% in the quarter.", url: "https://news.example.com/a" },
    { id: 12, datetime: Date.parse("2026-10-19T12:00:00Z") / 1000, headline: "Market Test Corp raises outlook after 20% sales jump!", source: "Other", summary: "", url: "https://news.example.com/dup" },
    { id: 13, datetime: Date.parse("2026-10-18T12:00:00Z") / 1000, headline: "Regulators open probe into Market Test Corp", source: "Wire", summary: "", url: "https://news.example.com/b" },
    { id: 14, datetime: Date.parse("2026-10-17T12:00:00Z") / 1000, headline: "Insecure link", source: "Wire", summary: "", url: "http://news.example.com/c" },
  ]
  : [{ id: 90, datetime: Date.parse("2026-10-16T12:00:00Z") / 1000, headline: `${symbol} expands production`, source: "Wire", summary: "", url: `https://news.example.com/${symbol}` }];

function upstream(calls: string[] = [], failing = false): Fetcher {
  return async (input) => {
    calls.push(input);
    if (failing) return new Response("unavailable", { status: 503 });
    const url = new URL(input);
    if (url.hostname === "data.sec.gov" && url.pathname.startsWith("/submissions/")) return Response.json(submissions);
    if (url.hostname === "www.sec.gov" && url.pathname === "/cgi-bin/browse-edgar") {
      const start = Number(url.searchParams.get("start"));
      const body = start === 0 ? ["0000000101", "0000000102", "0000000103", "0000000104"].map((cik) => `<entry><content><company-info><cik>${cik}</cik></company-info></content></entry>`).join("") : "";
      return new Response(`<?xml version="1.0"?><feed>${body}</feed>`);
    }
    if (url.hostname === "data.sec.gov" && url.pathname.startsWith("/api/xbrl/frames/us-gaap/")) {
      const key = url.pathname.replace("/api/xbrl/frames/us-gaap/", "").replace(/\.json$/, "");
      return frames[key] ? Response.json({ data: frames[key] }) : new Response("not found", { status: 404 });
    }
    if (url.hostname === "finnhub.io") return Response.json(press(url.searchParams.get("symbol") ?? ""));
    return new Response("unexpected", { status: 500 });
  };
}

const get = (path: string) => new Request(`https://api.example.test/api/v1/companies/MKT/${path}`);
const post = (path: string) => new Request(`https://api.example.test/api/v1/companies/MKT/${path}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ turnstile_token: "test-token" }),
});

describe("market research", () => {
  beforeAll(async () => {
    await applyD1Migrations(env.DB, [
      { name: "0001_initial.sql", queries: queries(migrationSql) },
      { name: "0003_sec_company_directory.sql", queries: queries(directoryMigrationSql) },
      { name: "0008_market_research.sql", queries: queries(marketMigrationSql) },
    ]);
    await env.DB.prepare("INSERT INTO companies (schema_version, cik, ticker, name) VALUES ('1.0.0', ?, 'MKT', 'Market Test Corp')").bind(SUBJECT_CIK).run();
    await env.DB.batch([
      ["MKT", SUBJECT_CIK, "Market Test Corp"],
      ["BIG", "0000000102", "Big Peer Inc"],
      ["BIG-WT", "0000000102", "Big Peer Inc Warrants"],
      ["SML", "0000000103", "Small Peer Co"],
    ].map(([ticker, cik, name]) => env.DB.prepare(
      "INSERT INTO sec_company_directory (ticker, cik, name, source_url, source_fetched_at) VALUES (?, ?, ?, 'https://www.sec.gov/files/company_tickers.json', '2026-10-01T00:00:00Z')",
    ).bind(ticker, cik, name)));
  });

  it("computes medians, percentiles, 8-K headlines, and the benchmark year", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
    expect(percentileRank([0.1, 0.2, 0.3, 0.4], 0.3)).toBe(75);
    expect(eightKHeadline(["2.02", "9.01"])).toBe("Results of operations and financial condition");
    expect(eightKHeadline(["9.01"])).toBe("Financial statements and exhibits");
    expect(benchmarkYear(() => new Date("2026-10-21T00:00:00Z"))).toBe(2025);
    expect(benchmarkYear(() => new Date("2026-02-01T00:00:00Z"))).toBe(2024);
  });

  it("refuses live SEC requests without a declared contact user agent", async () => {
    const response = await newsFeed(get("news"), "MKT", researchEnv({ SEC_USER_AGENT: undefined }), upstream(), clock);
    expect(response.status).toBe(503);
    expect((await response.json() as any).data.error.code).toBe("SEC_NOT_CONFIGURED");
  });

  it("merges SEC 8-Ks with deduplicated press headlines and caches the feed", async () => {
    const calls: string[] = [];
    const response = await newsFeed(get("news"), "MKT", researchEnv(), upstream(calls), clock);
    const body: any = await response.json();
    expect(response.status).toBe(200);
    const items = body.data.items;
    expect(items.map((item: any) => item.headline)).toEqual([
      "Market Test Corp raises outlook after 20% sales jump",
      "Regulators open probe into Market Test Corp",
      "8-K: Results of operations and financial condition",
      "8-K: Director or officer change, appointment, or compensation",
    ]);
    expect(items[2]).toMatchObject({ kind: "sec_8k", url: "https://www.sec.gov/Archives/edgar/data/101/000000010126000050/earnings.htm" });
    expect(body.data.press_enabled).toBe(true);
    expect(calls.some((url) => url.includes("token=test-key"))).toBe(true);
    const before = calls.length;
    await newsFeed(get("news"), "MKT", researchEnv(), upstream(calls), clock);
    expect(calls.length).toBe(before);
  });

  it("shows only SEC 8-Ks when no press key is configured", async () => {
    const body: any = await (await newsFeed(get("news"), "MKT", researchEnv({ FINNHUB_API_KEY: undefined }), upstream(), clock)).json();
    expect(body.data.press_enabled).toBe(false);
    expect(body.data.items.every((item: any) => item.kind === "sec_8k")).toBe(true);
  });

  it("benchmarks the company against same-industry SEC filers", async () => {
    const response = await industryBenchmark(get("industry"), "MKT", researchEnv(), upstream(), clock);
    const data: any = (await response.json() as any).data;
    expect(response.status).toBe(200);
    expect(data).toMatchObject({ sic: "3571", sic_description: "Electronic Computers", calendar_year: 2025, sample_size: 4 });
    expect(data.peers.map((peer: any) => peer.ticker)).toEqual(["BIG", "MKT", "SML"]);
    const byKey = Object.fromEntries(data.metrics.map((metric: any) => [metric.key, metric]));
    expect(byKey.revenue).toMatchObject({ company_display: "$120.00 billion", median_display: "$85.00 billion", percentile: 75, sample_size: 4 });
    expect(byKey.revenue_growth).toMatchObject({ company_display: "+20.00%", median_display: "+22.50%", percentile: 50, sample_size: 2 });
    expect(byKey.net_margin).toMatchObject({ company_display: "25.00%", percentile: 100 });
    expect(byKey.liabilities_to_assets).toMatchObject({ company_display: "75.00%", median_display: "57.50%" });
    expect(data.peer_headlines.map((item: any) => item.headline)).toEqual(["BIG expands production", "SML expands production"]);
    expect(data.sources.every((source: any) => /^https:\/\/(?:www|data)\.sec\.gov\//.test(source.source_url))).toBe(true);
  });

  it("serves the last good benchmark when SEC is unavailable after expiry", async () => {
    const later = () => new Date(NOW.getTime() + 3 * 24 * 60 * 60 * 1000);
    const response = await industryBenchmark(get("industry"), "MKT", researchEnv(), upstream([], true), later);
    const body: any = await response.json();
    expect(response.status).toBe(200);
    expect(body.data.stale).toBe(true);
    expect(body.data.sic).toBe("3571");
  });

  it("publishes a validated news brief, drops an unverifiable claim, and caches it", async () => {
    const requests: AiModelRequest[] = [];
    const model = async (request: AiModelRequest) => {
      requests.push(request);
      return {
        sentiment: "bullish", confidence: 0.7, refused: false, refusal_reason: null,
        claims: [
          { kind: "summary", text: "Market Test Corp raised its outlook after a 20% sales jump.", evidence_ids: ["news-press-11"] },
          { kind: "opposing", text: "Regulators opened a probe into Market Test Corp.", evidence_ids: ["news-press-13"] },
          { kind: "supporting", text: "Market Test Corp sales jumped 45% after the outlook raise.", evidence_ids: ["news-press-11"] },
        ],
      };
    };
    const created = await generateBrief(post("news-brief"), "MKT", "news", researchEnv(), model, challenge, upstream(), clock);
    const body: any = await created.json();
    expect(created.status).toBe(201);
    expect(body.data.claims.map((claim: any) => claim.kind)).toEqual(["summary", "opposing"]);
    expect(body.data.validation_details).toMatchObject({ rejected_claim_count: 1 });
    const pressSource = body.data.evidence.find((entry: any) => entry.evidence_id === "news-press-11");
    expect(pressSource).toMatchObject({ source_url: null, external_url: "https://news.example.com/a" });
    expect(requests[0].messages[0].content).toContain("Copy every number");
    const again = await generateBrief(post("news-brief"), "MKT", "news", researchEnv(), model, challenge, upstream(), clock);
    expect((await again.json() as any).meta.cached).toBe(true);
    expect(requests).toHaveLength(1);
    const read: any = await (await getBrief(get("news-brief"), "MKT", "news", researchEnv(), upstream(), clock)).json();
    expect(read.data).toMatchObject({ response_type: "news", is_current: true });
  });

  it("publishes an industry brief that copies benchmark numbers exactly", async () => {
    const response = await generateBrief(post("industry-brief"), "MKT", "industry", researchEnv(), async () => ({
      sentiment: "bullish", confidence: 0.6, refused: false, refusal_reason: null,
      claims: [
        { kind: "summary", text: "MKT net margin of 25.00% ranks at the 100th percentile of its industry.", evidence_ids: ["industry-net_margin"] },
        { kind: "opposing", text: "MKT liabilities to assets of 75.00% exceed the industry median of 57.50%.", evidence_ids: ["industry-liabilities_to_assets"] },
      ],
    }), challenge, upstream(), clock);
    const body: any = await response.json();
    expect(response.status).toBe(201);
    expect(body.data.claims).toHaveLength(2);
    expect(body.data.evidence.every((entry: any) => entry.source_url === null || /^https:\/\/(?:www|data)\.sec\.gov\//.test(entry.source_url))).toBe(true);
  });

  it("retries once and then refuses to publish an unverifiable brief", async () => {
    let calls = 0;
    const response = await generateBrief(post("industry-brief"), "MKT", "industry", researchEnv({ AI_MODEL: "mock-market-unverified" }), async () => {
      calls += 1;
      return {
        sentiment: "bullish", confidence: 0.6, refused: false, refusal_reason: null,
        claims: [{ kind: "summary", text: "MKT net margin was 41.00%.", evidence_ids: ["industry-net_margin"] }],
      };
    }, challenge, upstream(), clock);
    expect(response.status).toBe(422);
    expect((await response.json() as any).data.error.code).toBe("AI_BRIEF_UNVERIFIED");
    expect(calls).toBe(2);
  });

  it("routes research endpoints and rejects companies without a dataset", async () => {
    const response = await SELF.fetch("https://api.example.test/api/v1/companies/NOPE/news");
    expect(response.status).toBe(404);
    expect((await response.json() as any).data.error.code).toBe("COMPANY_NOT_ANALYZED");
  });
});
