import { describe, it, expect } from "vitest";
import {
  loadServerConfig,
  assertPayerAuthConfig,
  payerLoginMethodBlockedReason,
} from "./server";

const REAL_JWT = "x".repeat(40);
const cfg = (over: Record<string, string> = {}) =>
  loadServerConfig({ DATABASE_URL: "postgresql://u:p@localhost:5432/db", ...over });

describe("payerLoginMethodBlockedReason (ADR-0019 B-R1 — supabase inert without keys)", () => {
  it("the mock channels (email_otp default / whatsapp) are always satisfiable", () => {
    expect(payerLoginMethodBlockedReason(cfg())).toBeNull(); // email_otp default
    expect(payerLoginMethodBlockedReason(cfg({ PAYER_LOGIN_METHOD: "whatsapp" }))).toBeNull();
  });

  it("supabase WITHOUT keys is blocked (fail closed, names the missing keys)", () => {
    const reason = payerLoginMethodBlockedReason(cfg({ PAYER_LOGIN_METHOD: "supabase" }));
    expect(reason).toMatch(/SUPABASE_URL/);
    expect(reason).toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  it("supabase WITH both keys is satisfiable", () => {
    const reason = payerLoginMethodBlockedReason(
      cfg({
        PAYER_LOGIN_METHOD: "supabase",
        SUPABASE_URL: "https://proj.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
      }),
    );
    expect(reason).toBeNull();
  });
});

describe("assertPayerAuthConfig (fail-closed payer-auth guard)", () => {
  it("allows the mock email_otp default in development/test", () => {
    expect(() => assertPayerAuthConfig(cfg(), "development")).not.toThrow();
    expect(() => assertPayerAuthConfig(cfg(), "test")).not.toThrow();
  });

  it("throws when supabase is selected without its keys (inert-without-keys)", () => {
    expect(() =>
      assertPayerAuthConfig(cfg({ PAYER_LOGIN_METHOD: "supabase" }), "development"),
    ).toThrow(/supabase/i);
  });

  it("throws on the dev JWT secret in production (the payer session is signed with it)", () => {
    expect(() => assertPayerAuthConfig(cfg(), "production")).toThrow(/JWT_SECRET/i);
  });

  it("passes in production with a real JWT secret and the default mock channel", () => {
    expect(() => assertPayerAuthConfig(cfg({ JWT_SECRET: REAL_JWT }), "production")).not.toThrow();
  });
});
