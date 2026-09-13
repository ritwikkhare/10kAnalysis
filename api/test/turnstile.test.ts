import { describe, expect, it } from "vitest";
import { verifyTurnstile } from "../src/turnstile.js";

const config = {
  secret: "test-secret",
  expectedAction: "analyze_ticker",
  expectedHostnames: "localhost,127.0.0.1",
};

describe("Turnstile siteverify", () => {
  it("requires success, the expected action, and an allowed hostname", async () => {
    const accepted = await verifyTurnstile("fresh-token", "192.0.2.5", config, async (_url, init) => {
      expect(String(init?.body)).toContain("remoteip=192.0.2.5");
      return Response.json({ success: true, action: "analyze_ticker", hostname: "localhost" });
    });
    expect(accepted).toEqual({ ok: true });

    const wrongAction = await verifyTurnstile("fresh-token", "192.0.2.5", config, async () =>
      Response.json({ success: true, action: "other", hostname: "localhost" }));
    expect(wrongAction).toEqual({ ok: false, code: "REJECTED" });
  });

  it("fails closed for missing configuration and upstream errors", async () => {
    expect(await verifyTurnstile("token", "192.0.2.5", { ...config, secret: undefined })).toEqual({ ok: false, code: "MISCONFIGURED" });
    expect(await verifyTurnstile("token", "192.0.2.5", config, async () => { throw new Error("offline"); })).toEqual({ ok: false, code: "UNAVAILABLE" });
    expect(await verifyTurnstile("", "192.0.2.5", config)).toEqual({ ok: false, code: "MISSING_TOKEN" });
  });
});
