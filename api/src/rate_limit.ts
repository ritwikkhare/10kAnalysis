import { apiError } from "./http.js";

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
