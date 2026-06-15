import { describe, it, expect } from "vitest";
import { loadServerConfig, assertAuthConfig, isUsingDevJwtDefault, DEV_JWT_SECRET } from "./server";

const REAL_JWT = "x".repeat(40);
const cfg = (over: Record<string, string> = {}) =>
  loadServerConfig({ DATABASE_URL: "postgresql://u:p@localhost:5432/db", ...over });

describe("assertAuthConfig (fail-closed worker-auth guard)", () => {
  it("allows dev defaults ONLY when NODE_ENV is explicitly development/test", () => {
    expect(() => assertAuthConfig(cfg(), "development")).not.toThrow();
    expect(() => assertAuthConfig(cfg(), "test")).not.toThrow();
  });

  it("throws on the dev JWT secret in production", () => {
    expect(() => assertAuthConfig(cfg({ SMS_PROVIDER: "fast2sms", FAST2SMS_API_KEY: "k", FAST2SMS_SENDER_ID: "s", FAST2SMS_DLT_TEMPLATE_ID: "t" }), "production")).toThrow(/JWT_SECRET/i);
  });

  it("throws when SMS_PROVIDER=console outside development", () => {
    expect(() => assertAuthConfig(cfg({ JWT_SECRET: REAL_JWT }), "production")).toThrow(/console/i);
  });

  it("throws when SMS_PROVIDER=fast2sms but credentials are missing", () => {
    expect(() =>
      assertAuthConfig(cfg({ JWT_SECRET: REAL_JWT, SMS_PROVIDER: "fast2sms" }), "production"),
    ).toThrow(/FAST2SMS/i);
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
    const c = cfg({
      JWT_SECRET: REAL_JWT,
      SMS_PROVIDER: "fast2sms",
      FAST2SMS_API_KEY: "api-key",
      FAST2SMS_SENDER_ID: "BADBHI",
      FAST2SMS_DLT_TEMPLATE_ID: "123456",
    });
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
