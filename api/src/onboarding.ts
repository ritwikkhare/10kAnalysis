import { first, type Row } from "./db.js";
import { apiError, cleanTicker, json } from "./http.js";
import { verifyTurnstile, type TurnstileVerification } from "./turnstile.js";

export type AnalysisQueueMessage = {
  job_id: string;
  ticker: string;
  cik: string;
};

export type OnboardingEnv = Env & {
  TURNSTILE_SECRET?: string;
  GITHUB_ONBOARDING_TOKEN?: string;
};

type VerifyChallenge = (
  token: unknown,
  clientIp: string,
  env: OnboardingEnv,
) => Promise<TurnstileVerification>;

const JOB_SELECT = `SELECT job_id, ticker, cik, company_name, status, attempt_count,
  max_attempts, requested_at, started_at, completed_at, updated_at,
  public_message, error_code, failure_stage FROM analysis_jobs`;

function publicJob(row: Row): Row {
  return {
    job_id: row.job_id,
    ticker: row.ticker,
    cik: row.cik,
    company_name: row.company_name,
    status: row.status,
    attempt_count: row.attempt_count,
    max_attempts: row.max_attempts,
    requested_at: row.requested_at,
    started_at: row.started_at,
    completed_at: row.completed_at,
    updated_at: row.updated_at,
    message: row.public_message,
    error_code: row.error_code,
    can_retry: row.status === "failed" && Number(row.attempt_count) < Number(row.max_attempts),
  };
}

async function defaultChallenge(
  token: unknown,
  clientIp: string,
  env: OnboardingEnv,
): Promise<TurnstileVerification> {
  return verifyTurnstile(token, clientIp, {
    secret: env.TURNSTILE_SECRET,
    expectedAction: env.TURNSTILE_ACTION,
    expectedHostnames: env.TURNSTILE_HOSTNAMES,
  });
}

async function requestBody(request: Request): Promise<{ turnstile_token?: unknown } | null> {
  const size = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(size) && size > 4096) return null;
  try {
    const value: unknown = await request.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value as { turnstile_token?: unknown };
  } catch {
    return null;
  }
}

async function protect(
  request: Request,
  env: OnboardingEnv,
  verifyChallenge: VerifyChallenge,
  limiterKey: string,
): Promise<Response | null> {
  if (env.ONBOARDING_ENABLED !== "true") {
    return apiError(503, "ONBOARDING_DISABLED", "Ticker analysis is not enabled in this deployment yet.");
  }
  const clientIp = request.headers.get("CF-Connecting-IP") ?? "unknown-client";
  const outcome = await env.ONBOARDING_RATE_LIMITER.limit({ key: `${limiterKey}:${clientIp}` });
  if (!outcome.success) {
    return apiError(429, "RATE_LIMITED", "Too many analysis requests. Please wait and try again.", { "retry-after": "60" });
  }
  const body = await requestBody(request);
  if (!body) return apiError(400, "INVALID_REQUEST", "A small JSON request body is required.");
  const verification = await verifyChallenge(body.turnstile_token, clientIp, env);
  if (verification.ok) return null;
  if (verification.code === "MISCONFIGURED") {
    return apiError(503, "CHALLENGE_UNAVAILABLE", "Request verification is not configured yet.");
  }
  if (verification.code === "UNAVAILABLE") {
    return apiError(503, "CHALLENGE_UNAVAILABLE", "Request verification is temporarily unavailable.");
  }
  return apiError(403, "CHALLENGE_FAILED", "Request verification failed. Please complete a fresh challenge.");
}

export async function createAnalysisJob(
  request: Request,
  tickerValue: string,
  env: OnboardingEnv,
  verifyChallenge: VerifyChallenge = defaultChallenge,
): Promise<Response> {
  const ticker = cleanTicker(tickerValue);
  if (!ticker) return apiError(400, "INVALID_TICKER", "Ticker format is invalid.");
  if (env.ONBOARDING_TEST_TICKER && ticker !== cleanTicker(env.ONBOARDING_TEST_TICKER)) {
    return apiError(503, "CONTROLLED_ROLLOUT", "Ticker analysis is temporarily limited during production verification.");
  }
  const blocked = await protect(request, env, verifyChallenge, `analyze:${ticker}`);
  if (blocked) return blocked;

  const company = await first(env.DB, "SELECT ticker, cik, name FROM sec_company_directory WHERE ticker = ?", [ticker]);
  if (!company) {
    return apiError(404, "UNSUPPORTED_COMPANY", `${ticker} is not in the synchronized official SEC ticker directory.`);
  }
  const processed = await first(env.DB, "SELECT ticker FROM companies WHERE ticker = ?", [ticker]);
  if (processed) {
    return apiError(409, "ALREADY_ANALYZED", `${ticker} is already available in FilingLens.`);
  }
  const active = await first(env.DB, `${JOB_SELECT} WHERE ticker = ? AND status IN ('queued', 'processing') ORDER BY requested_at DESC LIMIT 1`, [ticker]);
  if (active) return json(publicJob(active), { duplicate_request: true }, 202);

  const jobId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO analysis_jobs
      (job_id, ticker, cik, company_name, status, requested_at, updated_at, public_message)
      VALUES (?, ?, ?, ?, 'queued', ?, ?, 'Analysis request accepted and waiting for background processing.')`,
  ).bind(jobId, company.ticker, company.cik, company.name, timestamp, timestamp).run();
  const job = await first(env.DB, `${JOB_SELECT} WHERE ticker = ? AND status IN ('queued', 'processing') ORDER BY requested_at DESC LIMIT 1`, [ticker]);
  if (!job) return apiError(503, "QUEUE_UNAVAILABLE", "The analysis request could not be saved. Please try again.");

  if (job.job_id === jobId) {
    try {
      await env.ANALYSIS_QUEUE.send({ job_id: jobId, ticker, cik: String(company.cik) }, { contentType: "json" });
    } catch {
      await env.DB.prepare(
        `UPDATE analysis_jobs SET status = 'failed', completed_at = ?, updated_at = ?,
          public_message = 'The request was saved, but background processing could not start. You can retry it.',
          error_code = 'QUEUE_UNAVAILABLE', failure_stage = 'queue' WHERE job_id = ? AND status = 'queued'`,
      ).bind(timestamp, timestamp, jobId).run();
      const failed = await first(env.DB, `${JOB_SELECT} WHERE job_id = ?`, [jobId]);
      return json(publicJob(failed!), {}, 503);
    }
  }
  return json(publicJob(job), { duplicate_request: job.job_id !== jobId }, 202);
}

export async function analysisJobStatus(jobId: string, env: OnboardingEnv): Promise<Response> {
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) return apiError(400, "INVALID_JOB_ID", "Analysis job ID format is invalid.");
  const job = await first(env.DB, `${JOB_SELECT} WHERE job_id = ?`, [jobId]);
  if (!job) return apiError(404, "JOB_NOT_FOUND", "Analysis job was not found.");
  return json(publicJob(job), {}, 200, { "cache-control": "no-store" });
}

export async function retryAnalysisJob(
  request: Request,
  jobId: string,
  env: OnboardingEnv,
  verifyChallenge: VerifyChallenge = defaultChallenge,
): Promise<Response> {
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) return apiError(400, "INVALID_JOB_ID", "Analysis job ID format is invalid.");
  const blocked = await protect(request, env, verifyChallenge, `retry:${jobId}`);
  if (blocked) return blocked;
  const existing = await first(env.DB, `${JOB_SELECT} WHERE job_id = ?`, [jobId]);
  if (!existing) return apiError(404, "JOB_NOT_FOUND", "Analysis job was not found.");
  if (env.ONBOARDING_TEST_TICKER && existing.ticker !== cleanTicker(env.ONBOARDING_TEST_TICKER)) {
    return apiError(503, "CONTROLLED_ROLLOUT", "Ticker analysis is temporarily limited during production verification.");
  }
  if (existing.status !== "failed") return apiError(409, "JOB_NOT_RETRYABLE", "Only failed analysis jobs can be retried.");
  if (Number(existing.attempt_count) >= Number(existing.max_attempts)) {
    return apiError(409, "RETRY_LIMIT_REACHED", "This analysis request has reached its retry limit.");
  }
  const timestamp = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE analysis_jobs SET status = 'queued', completed_at = NULL, updated_at = ?,
      public_message = 'Retry accepted and waiting for background processing.', error_code = NULL,
      failure_stage = NULL WHERE job_id = ? AND status = 'failed'`,
  ).bind(timestamp, jobId).run();
  try {
    await env.ANALYSIS_QUEUE.send(
      { job_id: jobId, ticker: String(existing.ticker), cik: String(existing.cik) },
      { contentType: "json" },
    );
  } catch {
    await env.DB.prepare(
      `UPDATE analysis_jobs SET status = 'failed', completed_at = ?, updated_at = ?,
        public_message = 'The retry was saved, but background processing could not start. You can retry again.',
        error_code = 'QUEUE_UNAVAILABLE', failure_stage = 'queue' WHERE job_id = ?`,
    ).bind(timestamp, timestamp, jobId).run();
    return apiError(503, "QUEUE_UNAVAILABLE", "Background processing could not start. Please try again.");
  }
  const queued = await first(env.DB, `${JOB_SELECT} WHERE job_id = ?`, [jobId]);
  return json(publicJob(queued!), {}, 202);
}

function validMessage(value: unknown): value is AnalysisQueueMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.job_id === "string" && /^[0-9a-f-]{36}$/i.test(item.job_id) &&
    typeof item.ticker === "string" && cleanTicker(item.ticker) === item.ticker &&
    typeof item.cik === "string" && /^\d{10}$/.test(item.cik);
}

export async function dispatchToGitHub(message: AnalysisQueueMessage, env: OnboardingEnv): Promise<Response> {
  if (!env.GITHUB_ONBOARDING_TOKEN || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPOSITORY)) {
    return new Response(null, { status: 503 });
  }
  return fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/dispatches`, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${env.GITHUB_ONBOARDING_TOKEN}`,
      "content-type": "application/json",
      "user-agent": "FilingLens-onboarding-dispatcher",
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify({ event_type: "filinglens_onboard_company", client_payload: message }),
    signal: AbortSignal.timeout(10_000),
  });
}

export async function consumeAnalysisQueue(
  batch: MessageBatch<AnalysisQueueMessage>,
  env: OnboardingEnv,
  dispatcher: (message: AnalysisQueueMessage, env: OnboardingEnv) => Promise<Response> = dispatchToGitHub,
): Promise<void> {
  for (const message of batch.messages) {
    if (!validMessage(message.body)) {
      console.error(JSON.stringify({ message: "invalid_analysis_queue_message", queue_message_id: message.id }));
      message.ack();
      continue;
    }
    const timestamp = new Date().toISOString();
    try {
      const job = await first(env.DB, `${JOB_SELECT} WHERE job_id = ?`, [message.body.job_id]);
      if (!job || job.ticker !== message.body.ticker || job.cik !== message.body.cik || job.status !== "queued") {
        message.ack();
        continue;
      }
      await env.DB.prepare(
        `UPDATE analysis_jobs SET status = 'processing', attempt_count = attempt_count + 1,
          started_at = COALESCE(started_at, ?), updated_at = ?,
          public_message = 'Background processing has started.' WHERE job_id = ? AND status = 'queued'`,
      ).bind(timestamp, timestamp, message.body.job_id).run();
      const response = await dispatcher(message.body, env);
      if (response.status === 204) {
        message.ack();
        continue;
      }
      if (response.status === 429 || response.status >= 500) throw new Error(`dispatch_${response.status}`);
      await env.DB.prepare(
        `UPDATE analysis_jobs SET status = 'failed', completed_at = ?, updated_at = ?,
          public_message = 'Background processing could not be authorized. The request can be retried after configuration is fixed.',
          error_code = 'DISPATCH_REJECTED', failure_stage = 'dispatch' WHERE job_id = ?`,
      ).bind(timestamp, timestamp, message.body.job_id).run();
      message.ack();
    } catch (error) {
      if (message.attempts >= 3) {
        try {
          await env.DB.prepare(
            `UPDATE analysis_jobs SET status = 'failed', completed_at = ?, updated_at = ?,
              public_message = 'Background processing was temporarily unavailable and exhausted automatic retries.',
              error_code = 'DISPATCH_UNAVAILABLE', failure_stage = 'dispatch' WHERE job_id = ?`,
          ).bind(timestamp, timestamp, message.body.job_id).run();
        } catch (statusError) {
          console.error(JSON.stringify({ message: "analysis_failure_status_write_failed", job_id: message.body.job_id, error: statusError instanceof Error ? statusError.message : "unknown" }));
          message.retry({ delaySeconds: 300 });
          continue;
        }
        console.error(JSON.stringify({ message: "analysis_dispatch_failed", job_id: message.body.job_id, error: error instanceof Error ? error.message : "unknown" }));
        message.ack();
      } else {
        try {
          await env.DB.prepare(
            `UPDATE analysis_jobs SET status = 'queued', updated_at = ?,
              public_message = 'Background processing is temporarily delayed and will retry.' WHERE job_id = ?`,
          ).bind(timestamp, message.body.job_id).run();
        } catch (statusError) {
          console.error(JSON.stringify({ message: "analysis_retry_status_write_failed", job_id: message.body.job_id, error: statusError instanceof Error ? statusError.message : "unknown" }));
        }
        message.retry({ delaySeconds: Math.min(30 * (2 ** message.attempts), 300) });
      }
    }
  }
}
