import { describe, it, expect } from "vitest";
import {
  loadServerConfig,
  realAiCallsBlockedReason,
  areRealAiCallsEnabled,
  realPaymentsBlockedReason,
  areRealPaymentsEnabled,
  assertPaymentsConfig,
  isCapacityEnforcementEnabled,
} from "./server";
import { loadPublicConfig } from "./public";

describe("payments config (ADR-0010 §D5 / F-6 — mock credits in alpha)", () => {
  it("defaults to mock: PAYMENTS_ENABLE_REAL false and real payments blocked", () => {
    const config = loadServerConfig({});
    expect(config.PAYMENTS_ENABLE_REAL).toBe(false);
    expect(areRealPaymentsEnabled(config)).toBe(false);
    expect(realPaymentsBlockedReason(config)).toBe("PAYMENTS_ENABLE_REAL is false");
  });

  it("exposes config-driven cap defaults (not hard-coded)", () => {
    const config = loadServerConfig({});
    expect(config.UNLOCK_MAX_REVEALS_PER_WORKER_PER_DAY).toBe(5);
    expect(config.UNLOCK_MAX_PAYERS_PER_WORKER_PER_WEEK).toBe(10);
    expect(config.UNLOCK_MAX_ATTEMPTS_PER_UNLOCK).toBe(3);
    const tuned = loadServerConfig({ UNLOCK_MAX_REVEALS_PER_WORKER_PER_DAY: "2" });
    expect(tuned.UNLOCK_MAX_REVEALS_PER_WORKER_PER_DAY).toBe(2);
  });

  it("exposes the per-payer capacity default (ADR-0016 — config-driven, tunable)", () => {
    const config = loadServerConfig({});
    expect(config.CAPACITY_DEFAULT_MAX_ACTIVE_VACANCIES).toBe(1);
    const tuned = loadServerConfig({ CAPACITY_DEFAULT_MAX_ACTIVE_VACANCIES: "3" });
    expect(tuned.CAPACITY_DEFAULT_MAX_ACTIVE_VACANCIES).toBe(3);
    // 0 is a valid allowance (a fresh payer holds zero active plans until they buy).
    expect(loadServerConfig({ CAPACITY_DEFAULT_MAX_ACTIVE_VACANCIES: "0" }).CAPACITY_DEFAULT_MAX_ACTIVE_VACANCIES).toBe(0);
  });

  it("capacity enforcement defaults OFF (shadow/inert; fail-safe default)", () => {
    const config = loadServerConfig({});
    expect(config.CAPACITY_ENFORCEMENT_ENABLED).toBe(false);
    expect(isCapacityEnforcementEnabled(config)).toBe(false);
  });

  it("capacity enforcement is tunable to ON (coerced from 'true'/'1')", () => {
    expect(isCapacityEnforcementEnabled(loadServerConfig({ CAPACITY_ENFORCEMENT_ENABLED: "true" }))).toBe(true);
    expect(isCapacityEnforcementEnabled(loadServerConfig({ CAPACITY_ENFORCEMENT_ENABLED: "1" }))).toBe(true);
    // and stays OFF for the falsey forms
    expect(isCapacityEnforcementEnabled(loadServerConfig({ CAPACITY_ENFORCEMENT_ENABLED: "false" }))).toBe(false);
    expect(isCapacityEnforcementEnabled(loadServerConfig({ CAPACITY_ENFORCEMENT_ENABLED: "0" }))).toBe(false);
  });

  it("assertPaymentsConfig is a no-op in the alpha mock default", () => {
    expect(() => assertPaymentsConfig(loadServerConfig({}))).not.toThrow();
  });

  it("assertPaymentsConfig THROWS when real is enabled without a provider key (fail closed)", () => {
    const config = loadServerConfig({ PAYMENTS_ENABLE_REAL: "true" });
    expect(() => assertPaymentsConfig(config)).toThrow(/PAYMENTS_PROVIDER_KEY/);
  });

  it("real payments are allowed only with both the flag AND a key", () => {
    const config = loadServerConfig({
      PAYMENTS_ENABLE_REAL: "true",
      PAYMENTS_PROVIDER_KEY: "rzp_test_xxx",
    });
    expect(realPaymentsBlockedReason(config)).toBeNull();
    expect(areRealPaymentsEnabled(config)).toBe(true);
    expect(() => assertPaymentsConfig(config)).not.toThrow();
  });
});

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
