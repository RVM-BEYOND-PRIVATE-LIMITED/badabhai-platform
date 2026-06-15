import { describe, it, expect } from "vitest";
import {
  loadServerConfig,
  realAiCallsBlockedReason,
  areRealAiCallsEnabled,
} from "./server";
import { loadPublicConfig } from "./public";

describe("loadServerConfig", () => {
  it("boots with safe defaults when optional secrets are absent", () => {
    const config = loadServerConfig({});
    expect(config.NODE_ENV).toBe("development");
    expect(config.AI_ENABLE_REAL_CALLS).toBe(false);
    expect(config.API_PORT).toBe(3001);
    expect(config.DATABASE_URL).toContain("postgresql://");
  });

  it("coerces AI_ENABLE_REAL_CALLS from string", () => {
    expect(loadServerConfig({ AI_ENABLE_REAL_CALLS: "true" }).AI_ENABLE_REAL_CALLS).toBe(true);
    expect(loadServerConfig({ AI_ENABLE_REAL_CALLS: "false" }).AI_ENABLE_REAL_CALLS).toBe(false);
  });

  it("rejects an invalid DATABASE_URL", () => {
    expect(() => loadServerConfig({ DATABASE_URL: "not-a-url" })).toThrow();
  });
});

describe("realAiCalls gating (fail closed)", () => {
  it("is blocked by default", () => {
    const config = loadServerConfig({});
    expect(areRealAiCallsEnabled(config)).toBe(false);
    expect(realAiCallsBlockedReason(config)).toBe("AI_ENABLE_REAL_CALLS is false");
  });

  it("is blocked when enabled but missing the Gemini key", () => {
    const config = loadServerConfig({ AI_ENABLE_REAL_CALLS: "true" });
    expect(realAiCallsBlockedReason(config)).toBe("GEMINI_FLASH_API_KEY is not set");
  });

  it("is allowed when enabled AND the Gemini key is present", () => {
    const config = loadServerConfig({
      AI_ENABLE_REAL_CALLS: "true",
      GEMINI_FLASH_API_KEY: "g-test",
    });
    expect(areRealAiCallsEnabled(config)).toBe(true);
  });

  it("accepts the deprecated LITELLM_API_KEY as a back-compat alias (TD28/ADR-0008)", () => {
    const config = loadServerConfig({
      AI_ENABLE_REAL_CALLS: "true",
      LITELLM_API_KEY: "sk-legacy",
    });
    expect(areRealAiCallsEnabled(config)).toBe(true);
  });
});

describe("loadPublicConfig", () => {
  it("ignores server secrets and never crashes on their absence", () => {
    const config = loadPublicConfig({
      // A leaked server secret should simply be ignored, not validated.
      SUPABASE_SERVICE_ROLE_KEY: "should-be-ignored",
      NEXT_PUBLIC_API_URL: "https://api.example.com",
    });
    expect(config.NEXT_PUBLIC_API_URL).toBe("https://api.example.com");
    expect(config).not.toHaveProperty("SUPABASE_SERVICE_ROLE_KEY");
  });
});
