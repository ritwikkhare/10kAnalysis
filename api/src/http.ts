const SCHEMA_VERSION = "1.0.0";
const SEC_HOSTS = new Set(["www.sec.gov", "data.sec.gov"]);

export type ApiEnvelope<T> = {
  schema_version: typeof SCHEMA_VERSION;
  data: T;
  meta: Record<string, unknown>;
};

export function json<T>(data: T, meta: Record<string, unknown> = {}, status = 200): Response {
  assertSafeCitations(data);
  const body: ApiEnvelope<T> = { schema_version: SCHEMA_VERSION, data, meta };
  return Response.json(body, {
    status,
    headers: {
      "cache-control": status === 200 ? "public, max-age=60" : "no-store",
      "access-control-allow-origin": "*",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

export function apiError(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, {}, status);
}

function assertSafeCitations(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(assertSafeCitations);
    return;
  }
  if (!value || typeof value !== "object") return;

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if ((key === "source_url" || key === "official_url" || key === "filing_index_url") && child !== null) {
      if (typeof child !== "string") throw new Error(`Citation field ${key} must be a string.`);
      const parsed = new URL(child);
      if (parsed.protocol !== "https:" || !SEC_HOSTS.has(parsed.hostname)) {
        throw new Error(`Citation field ${key} must link to an official SEC HTTPS URL.`);
      }
    }
    assertSafeCitations(child);
  }
}

export function cleanTicker(value: string): string | null {
  const ticker = value.trim().toUpperCase();
  return /^[A-Z][A-Z0-9.-]{0,9}$/.test(ticker) ? ticker : null;
}

export function cleanAccession(value: string): string | null {
  return /^\d{10}-\d{2}-\d{6}$/.test(value) ? value : null;
}

export function pagination(url: URL): { limit: number; offset: number } {
  const rawLimit = Number(url.searchParams.get("limit") ?? "50");
  const rawOffset = Number(url.searchParams.get("offset") ?? "0");
  const limit = Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 50;
  const offset = Number.isInteger(rawOffset) ? Math.max(rawOffset, 0) : 0;
  return { limit, offset };
}
