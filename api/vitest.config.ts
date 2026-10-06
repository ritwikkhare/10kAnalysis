import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Production Workers AI is deliberately absent from this test-only config.
  // Tests inject AiModelRunner mocks, so no local test can consume remote AI.
  plugins: [cloudflareTest({ wrangler: { configPath: "./test-worker.jsonc" } })],
});
