import { describe, it, expect } from "vitest";
import { loadServerConfig, assertAuthConfig, isUsingDevJwtDefault, DEV_JWT_SECRET } from "./server";

const REAL_JWT = "x".repeat(40);
const REAL_PIN_PEPPER = "p".repeat(24); // a non-dev PIN pepper (ADR-0026 Phase 3)
// The real-only Fast2SMS creds are now REQUIRED in EVERY environment. A fully-satisfiable
// set used by the "passes" cases (no real key — placeholder only).
const FAST2SMS_CREDS = {
  SMS_PROVIDER: "fast2sms",
  FAST2SMS_API_KEY: "placeholder-api-key",
  FAST2SMS_SENDER_ID: "BADBHI",
  FAST2SMS_DLT_TEMPLATE_ID: "123456",
};
const cfg = (over: Record<string, string> = {}) =>
  loadServerConfig({ DATABASE_URL: "postgresql://u:p@localhost:5432/db", ...over });

describe("assertAuthConfig (fail-closed worker-auth guard — real-only Fast2SMS)", () => {
  it("requires the Fast2SMS creds in EVERY env — dev/test throw without them too (real-only)", () => {
    // Worker OTP is REAL-ONLY: there is no console fallback, so the guard fails CLOSED
    // even in development/test when the Fast2SMS creds are absent.
    expect(() => assertAuthConfig(cfg(), "development")).toThrow(/FAST2SMS/i);
    expect(() => assertAuthConfig(cfg(), "test")).toThrow(/FAST2SMS/i);
  });

  it("passes in development/test WITH the Fast2SMS creds (dev JWT default allowed there)", () => {
    expect(() => assertAuthConfig(cfg(FAST2SMS_CREDS), "development")).not.toThrow();
    expect(() => assertAuthConfig(cfg(FAST2SMS_CREDS), "test")).not.toThrow();
  });

  it("throws on the dev JWT secret in production (even with full Fast2SMS creds)", () => {
    expect(() => assertAuthConfig(cfg(FAST2SMS_CREDS), "production")).toThrow(/JWT_SECRET/i);
  });

  it("throws when the Fast2SMS credentials are missing (any env, fail closed)", () => {
    expect(() => assertAuthConfig(cfg({ JWT_SECRET: REAL_JWT }), "production")).toThrow(/FAST2SMS/i);
    expect(() => assertAuthConfig(cfg({ JWT_SECRET: REAL_JWT }), "development")).toThrow(/FAST2SMS/i);
  });

  it("treats UNSET NODE_ENV as non-dev (fails closed)", () => {
    const prev = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    try {
      expect(() => assertAuthConfig(cfg())).toThrow();
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
    }
  });

  it("passes in production with a real JWT secret + PIN pepper + fully-configured Fast2SMS", () => {
    const c = cfg({ ...FAST2SMS_CREDS, JWT_SECRET: REAL_JWT, PIN_PEPPER: REAL_PIN_PEPPER });
    expect(() => assertAuthConfig(c, "production")).not.toThrow();
  });

  it("throws on the dev PIN pepper in production (ADR-0026 Phase 3 — fail closed like JWT_SECRET)", () => {
    // Real JWT + Fast2SMS but the PIN pepper left at its public dev default → must fail closed.
    const c = cfg({ ...FAST2SMS_CREDS, JWT_SECRET: REAL_JWT });
    expect(() => assertAuthConfig(c, "production")).toThrow(/PIN_PEPPER/i);
    // dev/test still allows the dev PIN pepper.
    expect(() => assertAuthConfig(cfg(FAST2SMS_CREDS), "development")).not.toThrow();
  });

  // ADR-0026: the refresh-token TTL must be >= the session absolute cap (else a refresh
  // record would expire out from under a still-valid session, forcing OTP early).
  it("fails closed when AUTH_REFRESH_TTL_DAYS < AUTH_SESSION_ABSOLUTE_MAX_DAYS", () => {
    const c = cfg({
      ...FAST2SMS_CREDS,
      AUTH_REFRESH_TTL_DAYS: "30",
      AUTH_SESSION_ABSOLUTE_MAX_DAYS: "90",
    });
    expect(() => assertAuthConfig(c, "development")).toThrow(/AUTH_REFRESH_TTL_DAYS/i);
  });

  it("passes when AUTH_REFRESH_TTL_DAYS >= AUTH_SESSION_ABSOLUTE_MAX_DAYS (default 90/90)", () => {
    expect(() => assertAuthConfig(cfg(FAST2SMS_CREDS), "development")).not.toThrow();
    const equalish = cfg({
      ...FAST2SMS_CREDS,
      AUTH_REFRESH_TTL_DAYS: "120",
      AUTH_SESSION_ABSOLUTE_MAX_DAYS: "90",
    });
    expect(() => assertAuthConfig(equalish, "development")).not.toThrow();
  });
});

describe("isUsingDevJwtDefault", () => {
  it("is true with the dev default and false with a real secret", () => {
    expect(isUsingDevJwtDefault(cfg())).toBe(true);
    expect(cfg().JWT_SECRET).toBe(DEV_JWT_SECRET);
    expect(isUsingDevJwtDefault(cfg({ JWT_SECRET: REAL_JWT }))).toBe(false);
  });
});
