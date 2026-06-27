import { describe, it, expect } from "vitest";
import {
  loadServerConfig,
  assertAdminAuthConfig,
  isUsingDevAdminJwtDefault,
  DEV_ADMIN_JWT_SECRET,
} from "./server";

const REAL_JWT = "x".repeat(40);
const REAL_ADMIN_JWT = "a".repeat(40);
const cfg = (over: Record<string, string> = {}) =>
  loadServerConfig({ DATABASE_URL: "postgresql://u:p@localhost:5432/db", ...over });

/**
 * assertAdminAuthConfig (ADR-0025 ADMIN-1, must-fix #2) — the fail-closed boot guard for the
 * 4th principal. Mirrors the `assertPayerAuthConfig` fail-closed test matrix: dev-secret-in-prod
 * rejected, half-set MFA/TOTP rejected, and (admin-specific) a shared worker/payer secret rejected.
 */
describe("assertAdminAuthConfig (fail-closed admin-auth boot guard — ADR-0025 must-fix #2)", () => {
  it("the DEFAULT config passes in development/test (dev defaults keep local boot working)", () => {
    expect(() => assertAdminAuthConfig(cfg(), "development")).not.toThrow();
    expect(() => assertAdminAuthConfig(cfg(), "test")).not.toThrow();
  });

  it("REJECTS the dev admin JWT secret in production (it would let anyone forge an admin session)", () => {
    // Real worker JWT set so the ONLY remaining problem is the admin dev secret.
    expect(() => assertAdminAuthConfig(cfg({ JWT_SECRET: REAL_JWT }), "production")).toThrow(
      /ADMIN_JWT_SECRET/i,
    );
  });

  it("REJECTS the dev admin JWT secret in staging (anything not explicitly dev/test)", () => {
    expect(() => assertAdminAuthConfig(cfg({ JWT_SECRET: REAL_JWT }), "staging")).toThrow(
      /ADMIN_JWT_SECRET/i,
    );
    // A bare "production" string (no real-secret env) fails closed too.
    expect(() => assertAdminAuthConfig(cfg({ JWT_SECRET: REAL_JWT }), "production")).toThrow(
      /ADMIN_JWT_SECRET/i,
    );
  });

  it("REJECTS an admin secret equal to the worker/payer JWT_SECRET (shared secret defeats separation)", () => {
    // Both set to the SAME real value: not the dev default, but a shared secret — rejected so an
    // admin token can never be cryptographically interchangeable with a worker/payer one.
    expect(() =>
      assertAdminAuthConfig(
        cfg({ JWT_SECRET: REAL_JWT, ADMIN_JWT_SECRET: REAL_JWT }),
        "production",
      ),
    ).toThrow(/must differ from JWT_SECRET/i);
  });

  it("REJECTS a HALF-SET MFA config (MFA required but no TOTP issuer) — even in development", () => {
    // A structural mis-config (not a dev shortcut), so it fails closed in every env.
    expect(() =>
      assertAdminAuthConfig(cfg({ ADMIN_MFA_REQUIRED: "true", ADMIN_TOTP_ISSUER: " " }), "development"),
    ).toThrow(/ADMIN_TOTP_ISSUER/i);
    expect(() =>
      assertAdminAuthConfig(
        cfg({
          JWT_SECRET: REAL_JWT,
          ADMIN_JWT_SECRET: REAL_ADMIN_JWT,
          ADMIN_MFA_REQUIRED: "true",
          ADMIN_TOTP_ISSUER: " ",
        }),
        "production",
      ),
    ).toThrow(/ADMIN_TOTP_ISSUER/i);
  });

  it("PASSES in production with a real, DISTINCT admin secret and a complete MFA config", () => {
    expect(() =>
      assertAdminAuthConfig(
        cfg({ JWT_SECRET: REAL_JWT, ADMIN_JWT_SECRET: REAL_ADMIN_JWT }),
        "production",
      ),
    ).not.toThrow();
  });

  it("ADMIN_MFA_REQUIRED defaults ON (owner OQ-1: MFA for ALL roles) and parses falsey strings off", () => {
    expect(cfg().ADMIN_MFA_REQUIRED).toBe(true);
    expect(cfg({ ADMIN_MFA_REQUIRED: "false" }).ADMIN_MFA_REQUIRED).toBe(false);
    expect(cfg({ ADMIN_MFA_REQUIRED: "0" }).ADMIN_MFA_REQUIRED).toBe(false);
    expect(cfg({ ADMIN_MFA_REQUIRED: "true" }).ADMIN_MFA_REQUIRED).toBe(true);
  });

  it("isUsingDevAdminJwtDefault flags the dev secret (boot warning) and clears once overridden", () => {
    expect(isUsingDevAdminJwtDefault(cfg())).toBe(true);
    expect(cfg().ADMIN_JWT_SECRET).toBe(DEV_ADMIN_JWT_SECRET);
    expect(isUsingDevAdminJwtDefault(cfg({ ADMIN_JWT_SECRET: REAL_ADMIN_JWT }))).toBe(false);
  });
});
