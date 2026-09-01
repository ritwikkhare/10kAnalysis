export type TurnstileResult = {
  success?: boolean;
  action?: string;
  hostname?: string;
  "error-codes"?: string[];
};

export type TurnstileConfig = {
  secret: string | undefined;
  expectedAction: string;
  expectedHostnames: string;
};

export type TurnstileVerification =
  | { ok: true }
  | { ok: false; code: "MISSING_TOKEN" | "MISCONFIGURED" | "REJECTED" | "UNAVAILABLE" };

export async function verifyTurnstile(
  token: unknown,
  clientIp: string,
  config: TurnstileConfig,
  fetcher: typeof fetch = fetch,
): Promise<TurnstileVerification> {
  const allowedHostnames = new Set(
    config.expectedHostnames.split(",").map((value) => value.trim()).filter(Boolean),
  );
  if (typeof token !== "string" || token.length === 0 || token.length > 2048) {
    return { ok: false, code: "MISSING_TOKEN" };
  }
  if (!config.secret || allowedHostnames.size === 0) {
    return { ok: false, code: "MISCONFIGURED" };
  }

  let response: Response;
  try {
    response = await fetcher("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        secret: config.secret,
        response: token,
        remoteip: clientIp,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { ok: false, code: "UNAVAILABLE" };
  }
  if (!response.ok) return { ok: false, code: "UNAVAILABLE" };

  let result: TurnstileResult;
  try {
    result = await response.json<TurnstileResult>();
  } catch {
    return { ok: false, code: "UNAVAILABLE" };
  }
  if (
    result.success !== true ||
    result.action !== config.expectedAction ||
    typeof result.hostname !== "string" ||
    !allowedHostnames.has(result.hostname)
  ) {
    return { ok: false, code: "REJECTED" };
  }
  return { ok: true };
}
