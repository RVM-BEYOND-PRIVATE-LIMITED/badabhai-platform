import { describe, it, expect } from "vitest";
import {
  loadServerConfig,
  assertPayerAuthConfig,
  payerLoginMethodBlockedReason,
  emailProviderBlockedReason,
} from "./server";

const REAL_JWT = "x".repeat(40);
const cfg = (over: Record<string, string> = {}) =>
  loadServerConfig({ DATABASE_URL: "postgresql://u:p@localhost:5432/db", ...over });

// A fully-satisfiable ZeptoMail credential set (no real token — placeholder only). The
// EMAIL_PROVIDER default is now "zeptomail", which REQUIRES this set at boot.
const ZEPTO_CREDS = {
  EMAIL_PROVIDER: "zeptomail",
  ZEPTOMAIL_API_TOKEN: "placeholder-zepto-token",
  ZEPTOMAIL_MAIL_AGENT: "placeholder-mail-agent",
  EMAIL_FROM_ADDRESS: "otp@example.com",
};
// A fully-satisfiable SMTP credential set.
const SMTP_CREDS = {
  EMAIL_PROVIDER: "smtp",
  SMTP_HOST: "smtp.example.com",
  SMTP_USER: "smtp-user",
  SMTP_PASS: "smtp-pass",
  EMAIL_FROM_ADDRESS: "otp@example.com",
};

describe("payerLoginMethodBlockedReason (ADR-0019 B-R1 — supabase inert without keys)", () => {
  it("email_otp (default) and whatsapp methods are always satisfiable at the METHOD level", () => {
    // payerLoginMethodBlockedReason gates ONLY the supabase IdP — the email-OTP provider
    // creds are a SEPARATE gate (emailProviderBlockedReason, asserted below).
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

describe("assertPayerAuthConfig (fail-closed payer-auth guard — real-only email)", () => {
  it("the DEFAULT (email_otp + zeptomail) THROWS without creds, even in development/test", () => {
    // The email channel is REAL-ONLY: the default zeptomail provider requires its creds in
    // every env, so the guard fails CLOSED without them (no mock channel to fall back to).
    expect(() => assertPayerAuthConfig(cfg(), "development")).toThrow(/ZEPTOMAIL_API_TOKEN/);
    expect(() => assertPayerAuthConfig(cfg(), "test")).toThrow(/ZEPTOMAIL_API_TOKEN/);
  });

  it("email_otp + zeptomail WITH its full cred set passes in development/test", () => {
    expect(() => assertPayerAuthConfig(cfg(ZEPTO_CREDS), "development")).not.toThrow();
    expect(() => assertPayerAuthConfig(cfg(ZEPTO_CREDS), "test")).not.toThrow();
  });

  it("throws when supabase is selected without its keys (inert-without-keys)", () => {
    expect(() =>
      assertPayerAuthConfig(cfg({ PAYER_LOGIN_METHOD: "supabase" }), "development"),
    ).toThrow(/supabase/i);
  });

  it("throws on the dev JWT secret in production (the payer session is signed with it)", () => {
    // Provide the email creds so the ONLY remaining problem is the JWT default.
    expect(() => assertPayerAuthConfig(cfg(ZEPTO_CREDS), "production")).toThrow(/JWT_SECRET/i);
  });

  it("passes in production with a real JWT secret AND the real email creds", () => {
    expect(() =>
      assertPayerAuthConfig(cfg({ ...ZEPTO_CREDS, JWT_SECRET: REAL_JWT }), "production"),
    ).not.toThrow();
  });
});

describe("emailProviderBlockedReason (ADR-0019 — real email-OTP provider fails closed)", () => {
  it("the default provider is zeptomail, which is blocked without creds (no 'none' option)", () => {
    expect(cfg().EMAIL_PROVIDER).toBe("zeptomail");
    expect(emailProviderBlockedReason(cfg())).toMatch(/ZEPTOMAIL_API_TOKEN/);
  });

  it("zeptomail WITHOUT creds is blocked (names the missing creds)", () => {
    const reason = emailProviderBlockedReason(cfg({ EMAIL_PROVIDER: "zeptomail" }));
    expect(reason).toMatch(/ZEPTOMAIL_API_TOKEN/);
    expect(reason).toMatch(/ZEPTOMAIL_MAIL_AGENT/);
    expect(reason).toMatch(/EMAIL_FROM_ADDRESS/);
  });

  it("zeptomail WITH its full cred set is satisfiable", () => {
    expect(emailProviderBlockedReason(cfg(ZEPTO_CREDS))).toBeNull();
  });

  it("smtp WITHOUT creds is blocked; WITH its full cred set is satisfiable", () => {
    expect(emailProviderBlockedReason(cfg({ EMAIL_PROVIDER: "smtp" }))).toMatch(/SMTP_HOST/);
    expect(emailProviderBlockedReason(cfg(SMTP_CREDS))).toBeNull();
  });

  it("auto is blocked when NEITHER set is configured, satisfiable when either is", () => {
    expect(emailProviderBlockedReason(cfg({ EMAIL_PROVIDER: "auto" }))).toMatch(/auto/);
    expect(
      emailProviderBlockedReason(cfg({ ...ZEPTO_CREDS, EMAIL_PROVIDER: "auto" })),
    ).toBeNull();
    expect(emailProviderBlockedReason(cfg({ ...SMTP_CREDS, EMAIL_PROVIDER: "auto" }))).toBeNull();
  });
});

describe("assertPayerAuthConfig — email-OTP provider gate (only when method=email_otp)", () => {
  it("the default config (email_otp + zeptomail) WITHOUT creds throws (real-only, fail closed)", () => {
    expect(() => assertPayerAuthConfig(cfg(), "development")).toThrow(/ZEPTOMAIL_API_TOKEN/);
  });

  it("email_otp + zeptomail WITH its full cred set does NOT throw", () => {
    expect(() => assertPayerAuthConfig(cfg(ZEPTO_CREDS), "development")).not.toThrow();
  });

  it("email_otp + smtp missing creds throws; with full SMTP creds + from-address passes", () => {
    expect(() =>
      assertPayerAuthConfig(cfg({ EMAIL_PROVIDER: "smtp" }), "development"),
    ).toThrow(/SMTP_HOST/);
    expect(() => assertPayerAuthConfig(cfg(SMTP_CREDS), "development")).not.toThrow();
  });

  it("email_otp + auto with neither set throws; with the ZeptoMail set passes", () => {
    expect(() =>
      assertPayerAuthConfig(cfg({ EMAIL_PROVIDER: "auto" }), "development"),
    ).toThrow(/auto/);
    expect(() =>
      assertPayerAuthConfig(cfg({ ...ZEPTO_CREDS, EMAIL_PROVIDER: "auto" }), "development"),
    ).not.toThrow();
  });

  it("whatsapp + zeptomail with no creds does NOT throw (email irrelevant when method≠email_otp)", () => {
    expect(() =>
      assertPayerAuthConfig(
        cfg({ PAYER_LOGIN_METHOD: "whatsapp", EMAIL_PROVIDER: "zeptomail" }),
        "development",
      ),
    ).not.toThrow();
  });

  it("loadServerConfig parses a config carrying ALL the new email vars without error", () => {
    const c = cfg({
      EMAIL_PROVIDER: "auto",
      ZEPTOMAIL_API_URL: "https://api.zeptomail.in/v1.1/email",
      ZEPTOMAIL_API_TOKEN: "placeholder-zepto-token",
      ZEPTOMAIL_MAIL_AGENT: "placeholder-mail-agent",
      ZEPTOMAIL_SANDBOX_MODE: "false",
      SMTP_HOST: "smtp.example.com",
      SMTP_PORT: "587",
      SMTP_USER: "smtp-user",
      SMTP_PASS: "smtp-pass",
      SMTP_FROM: "otp@example.com",
      EMAIL_FROM_NAME: "BadaBhai",
      EMAIL_FROM_ADDRESS: "otp@example.com",
      EMAIL_REPLY_TO: "support@example.com",
    });
    expect(c.EMAIL_PROVIDER).toBe("auto");
    expect(c.ZEPTOMAIL_SANDBOX_MODE).toBe(false);
    expect(c.SMTP_PORT).toBe(587);
    expect(c.EMAIL_FROM_ADDRESS).toBe("otp@example.com");
  });
});
