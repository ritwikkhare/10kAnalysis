// Wrangler generates all declared bindings in worker-configuration.d.ts.
// Runtime secrets are intentionally absent from wrangler.jsonc and merge here.
interface Env {
  ONBOARDING_ENABLED?: string;
  ONBOARDING_TEST_TICKER?: string;
  TURNSTILE_SECRET?: string;
  GITHUB_ONBOARDING_TOKEN?: string;
}
