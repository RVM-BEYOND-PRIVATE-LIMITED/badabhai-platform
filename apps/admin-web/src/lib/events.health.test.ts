import { describe, it, expect } from "vitest";
import { healthSchema, summarizeHealthCheck } from "./events";
import { healthTone } from "./format";

/**
 * `/health` parity with the API.
 *
 * REGRESSION GUARD. The schema required every check to be a string, but `storage_config` has
 * been an OBJECT since API #796 — so the WHOLE probe failed to parse, and the dashboard and the
 * System page both said "the health probe is unreachable" about a platform that was up.
 *
 * `storage_config` below is the API's own fixture (apps/api/src/health/health.controller.test.ts,
 * STORAGE_CONFIG_UP), not an invented shape.
 */
const STORAGE_CONFIG_UP = {
  supabase: "configured",
  buckets: {
    resumes: true,
    photos: true,
    voice_notes: true,
    interview_kit: true,
    feedback_attachments: true,
  },
  resume_render_enabled: true,
  armed_without_credentials: false,
};

const body = (checks: Record<string, unknown>) => ({
  status: "ok",
  service: "api",
  environment: "production",
  timestamp: "2026-11-04T09:00:00.000Z",
  checks,
});

describe("health probe — the storage_config object no longer breaks the parse", () => {
  it("parses the real response, object check included", () => {
    const parsed = healthSchema.parse(
      body({
        database: "up",
        redis: "up",
        deletion_sweep: "up",
        ai_service: "up",
        ai_posture: "real",
        storage_config: STORAGE_CONFIG_UP,
      }),
    );
    expect(parsed.checks).toEqual({
      database: "up",
      redis: "up",
      deletion_sweep: "up",
      ai_service: "up",
      ai_posture: "real",
      storage_config: "up",
    });
  });

  it("flags Storage armed without credentials as a failing dependency", () => {
    const word = summarizeHealthCheck({
      ...STORAGE_CONFIG_UP,
      supabase: "not_configured",
      armed_without_credentials: true,
    });
    expect(word).toBe("misconfigured");
    expect(healthTone(word)).toBe("bad");
  });

  it("says 'not configured' — a warning, not an outage — when nothing is armed", () => {
    const word = summarizeHealthCheck({
      ...STORAGE_CONFIG_UP,
      supabase: "not_configured",
      armed_without_credentials: false,
    });
    expect(word).toBe("not configured");
    expect(healthTone(word)).toBe("warn");
  });

  it("renders an unknown object shape as 'unrecognised' instead of failing the probe", () => {
    const parsed = healthSchema.parse(body({ database: "up", something_new: { a: 1 } }));
    expect(parsed.checks.something_new).toBe("unrecognised");
    expect(healthTone("unrecognised")).toBe("warn");
  });

  it("still parses a probe whose checks are all strings", () => {
    expect(healthSchema.parse(body({ database: "down" })).checks).toEqual({ database: "down" });
  });
});
