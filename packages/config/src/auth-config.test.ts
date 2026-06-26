import { describe, it, expect } from "vitest";
import { loadServerConfig, assertAuthConfig, isUsingDevJwtDefault, DEV_JWT_SECRET } from "./server";

const REAL_JWT = "x".repeat(40);
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

  it("passes in production with a real JWT secret + fully-configured Fast2SMS", () => {
    const c = cfg({ ...FAST2SMS_CREDS, JWT_SECRET: REAL_JWT });
    expect(() => assertAuthConfig(c, "production")).not.toThrow();
  });
});

describe("isUsingDevJwtDefault", () => {
  it("is true with the dev default and false with a real secret", () => {
    expect(isUsingDevJwtDefault(cfg())).toBe(true);
    expect(cfg().JWT_SECRET).toBe(DEV_JWT_SECRET);
    expect(isUsingDevJwtDefault(cfg({ JWT_SECRET: REAL_JWT }))).toBe(false);
  });
});
