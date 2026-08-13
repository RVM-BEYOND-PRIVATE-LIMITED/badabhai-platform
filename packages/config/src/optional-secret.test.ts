import { describe, it, expect } from "vitest";

import { loadServerConfig } from "./server";

/**
 * A DECLARED-BUT-UNCONFIGURED SECRET MUST NOT TAKE THE PROCESS DOWN.
 *
 * `docker-compose.staging.yml` declares provider credentials as `NAME: ${NAME:-}` so the owner
 * can arm them from the box without a code change. That form does NOT omit an unset variable —
 * it sets it to the empty string. `z.string().url().optional()` accepts `undefined` and rejects
 * `""`, so declaring the pass-through was enough, on its own, to make the API fail to boot the
 * next time staging deployed. These rows are the reason that is now impossible.
 *
 * The last two rows are the point: this must NOT become "any junk is accepted". Only the empty
 * string is reclassified as unset — a non-empty malformed value still fails.
 */
describe("optional secrets: empty string means unset, and only that", () => {
  it("SUPABASE_URL='' parses and reads as not-configured", () => {
    const config = loadServerConfig({ SUPABASE_URL: "" });
    expect(config.SUPABASE_URL).toBeUndefined();
  });

  it("SUPABASE_SERVICE_ROLE_KEY='' parses and reads as not-configured", () => {
    const config = loadServerConfig({ SUPABASE_SERVICE_ROLE_KEY: "" });
    expect(config.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
  });

  it("both empty together still boot — the exact shape a compose pass-through produces", () => {
    const config = loadServerConfig({
      SUPABASE_URL: "",
      SUPABASE_SERVICE_ROLE_KEY: "",
      VOICE_NOTES_BUCKET: "",
    });
    expect(config.SUPABASE_URL).toBeUndefined();
    expect(config.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
    expect(config.VOICE_NOTES_BUCKET).toBe("");
  });

  it("an omitted variable behaves identically to an empty one", () => {
    expect(loadServerConfig({}).SUPABASE_URL).toBeUndefined();
  });

  it("a real value still parses", () => {
    const config = loadServerConfig({
      SUPABASE_URL: "https://project.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    });
    expect(config.SUPABASE_URL).toBe("https://project.supabase.co");
    expect(config.SUPABASE_SERVICE_ROLE_KEY).toBe("service-role-key");
  });

  it("STILL REJECTS a non-empty malformed URL — the validation is narrowed, not removed", () => {
    expect(() => loadServerConfig({ SUPABASE_URL: "not-a-url" })).toThrow();
  });

  it("STILL REJECTS whitespace, which is a typo rather than an unset variable", () => {
    expect(() => loadServerConfig({ SUPABASE_URL: " " })).toThrow();
  });

  /**
   * #813/#814/#819 — the second-order shape of the same bug. `ZEPTOMAIL_API_URL` was
   * declared NOWHERE in the compose/CI deploy pipeline (a different bug, fixed
   * separately), so this exact crash was latent, not yet triggered, on the deployed
   * box — but wiring it through as the same `${VAR:-}` pass-through its siblings
   * already use would have handed the parse an empty string the moment any single
   * one of the four was unset, taking the ENTIRE API down before any request-level
   * boot guard (`assertPayerAuthConfig`) ever got a chance to degrade gracefully
   * instead. `ZEPTOMAIL_API_TOKEN`/`ZEPTOMAIL_MAIL_AGENT`/`EMAIL_FROM_ADDRESS` had
   * carried the identical un-guarded shape since before this file existed.
   */
  it("ZEPTOMAIL_API_URL='' parses and reads as not-configured", () => {
    const config = loadServerConfig({ ZEPTOMAIL_API_URL: "" });
    expect(config.ZEPTOMAIL_API_URL).toBeUndefined();
  });

  it("all four ZeptoMail/email fields empty together still boot — the compose pass-through shape", () => {
    const config = loadServerConfig({
      ZEPTOMAIL_API_URL: "",
      ZEPTOMAIL_API_TOKEN: "",
      ZEPTOMAIL_MAIL_AGENT: "",
      EMAIL_FROM_ADDRESS: "",
    });
    expect(config.ZEPTOMAIL_API_URL).toBeUndefined();
    expect(config.ZEPTOMAIL_API_TOKEN).toBeUndefined();
    expect(config.ZEPTOMAIL_MAIL_AGENT).toBeUndefined();
    expect(config.EMAIL_FROM_ADDRESS).toBeUndefined();
  });

  it("a real ZEPTOMAIL_API_URL still parses, and a malformed one is still rejected", () => {
    expect(
      loadServerConfig({ ZEPTOMAIL_API_URL: "https://api.zeptomail.in/v1.1/email" })
        .ZEPTOMAIL_API_URL,
    ).toBe("https://api.zeptomail.in/v1.1/email");
    expect(() => loadServerConfig({ ZEPTOMAIL_API_URL: "not-a-url" })).toThrow();
  });
});
