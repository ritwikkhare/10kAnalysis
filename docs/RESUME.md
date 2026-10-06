# FilingLens resume and portfolio copy

## One-line project description

Evidence-grounded SEC filing intelligence platform that turns 10-K and 10-Q reports
into traceable financial facts, ratios, year-over-year comparisons, risk-language
changes, and validation-gated AI research.

## Resume bullets

- Built a full-stack SEC filing intelligence platform that discovers public-company
  tickers, ingests 10-K/10-Q filings and XBRL facts, normalizes fiscal periods, and
  presents financials, ratios, comparisons, and Item 1A risk changes in a responsive
  dashboard.
- Designed an evidence graph that links every reported fact, calculated ratio,
  comparison, risk passage, and AI claim to official SEC source URLs and underlying
  evidence IDs.
- Implemented asynchronous, idempotent company onboarding with Python, Cloudflare
  Workers, Queues, D1, and GitHub Actions, including duplicate prevention, bounded
  retries, unsupported-filer classification, and safe failure logging.
- Added evidence-grounded Workers AI analysis with strict JSON, citation, and numeric
  validation; backend-reproduced derived values; Turnstile protection; rate limits;
  and fail-closed publication rules that reject unsupported claims and forecasts.
- Created automated regression coverage across Python, TypeScript, Worker/API, D1,
  and React layers, including fiscal-quarter matching, XBRL aliases, evidence-ID
  uniqueness, AI response adapters, calculation precision, and responsive UI builds.

## Technology

Python, TypeScript, React, Next.js/Vinext, SEC EDGAR, XBRL, Cloudflare Workers,
Workers AI, D1, Queues, Turnstile, GitHub Actions, Vitest, and Python unittest.

## Links

- Live: <https://filinglens.ritwikkhare.workers.dev>
- Source: <https://github.com/ritwikkhare/10kAnalysis>
