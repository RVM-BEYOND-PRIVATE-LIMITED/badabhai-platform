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
});
