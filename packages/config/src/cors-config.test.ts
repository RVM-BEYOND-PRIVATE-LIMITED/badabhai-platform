import { describe, it, expect } from "vitest";
import { loadServerConfig, assertCorsConfig, corsOptions } from "./server";

const cfg = (over: Record<string, string> = {}) =>
  loadServerConfig({ DATABASE_URL: "postgresql://u:p@localhost:5432/db", ...over });

const OPS = "https://ops.staging.badabhai.in";
const PAYER = "https://app.staging.badabhai.in";

describe("CORS_ALLOWED_ORIGINS parsing (CSV → trimmed, de-blanked string[])", () => {
  it("defaults to an empty list when unset", () => {
    expect(cfg().CORS_ALLOWED_ORIGINS).toEqual([]);
  });

  it("splits a CSV, trims whitespace, and drops blank entries", () => {
    expect(cfg({ CORS_ALLOWED_ORIGINS: ` ${OPS} , ${PAYER} , ,` }).CORS_ALLOWED_ORIGINS).toEqual([
      OPS,
      PAYER,
    ]);
  });
});

describe("assertCorsConfig (TD30 — fail closed outside dev/test)", () => {
  it("THROWS on an empty allow-list outside an explicit development/test env", () => {
    // production, staging, a blank raw value, and a typo all fail closed (the R14 footgun:
    // anything that isn't EXPLICITLY "development"/"test" enforces the allow-list). We pass a
    // blank "" rather than `undefined` because `undefined` would re-trigger the default
    // parameter (= process.env.NODE_ENV); isDevEnv's own unset→false case is covered in
    // dev-env.test.ts.
    expect(() => assertCorsConfig(cfg(), "production")).toThrow(/CORS_ALLOWED_ORIGINS is empty/);
    expect(() => assertCorsConfig(cfg(), "staging")).toThrow(/fail closed/);
    expect(() => assertCorsConfig(cfg(), "")).toThrow(/CORS_ALLOWED_ORIGINS is empty/);
    expect(() => assertCorsConfig(cfg(), "Production")).toThrow(); // typo ≠ dev → still closed
  });

  it("does NOT throw with an empty list in an explicit development/test env (permissive)", () => {
    expect(() => assertCorsConfig(cfg(), "development")).not.toThrow();
    expect(() => assertCorsConfig(cfg(), "test")).not.toThrow();
  });

  it("does NOT throw outside dev once the allow-list is non-empty", () => {
    const c = cfg({ CORS_ALLOWED_ORIGINS: `${OPS},${PAYER}` });
    expect(() => assertCorsConfig(c, "production")).not.toThrow();
    expect(() => assertCorsConfig(c, "staging")).not.toThrow();
  });
});

describe("corsOptions (TD30 — the applied policy)", () => {
  it("reflects any origin (true) ONLY in an explicit development/test env", () => {
    expect(corsOptions(cfg(), "development").origin).toBe(true);
    expect(corsOptions(cfg(), "test").origin).toBe(true);
  });

  it("uses the exact allow-list (never true) outside dev/test", () => {
    const origin = corsOptions(cfg({ CORS_ALLOWED_ORIGINS: `${OPS},${PAYER}` }), "production").origin;
    expect(origin).toEqual([OPS, PAYER]);
    expect(origin).not.toBe(true); // never wildcard/reflect-any in prod
  });

  it("never pairs credentials with the origin policy (Bearer-header auth, not cookies)", () => {
    expect(corsOptions(cfg(), "production").credentials).toBe(false);
    expect(corsOptions(cfg(), "development").credentials).toBe(false);
  });

  it("exposes x-session-token so apps/payer-web can read the rolling payer session cross-origin", () => {
    expect(corsOptions(cfg(), "production").exposedHeaders).toContain("x-session-token");
  });

  it("allows the Authorization header (Bearer) and standard request headers", () => {
    const allowed = corsOptions(cfg(), "production").allowedHeaders;
    expect(allowed).toContain("Authorization");
    expect(allowed).toContain("Content-Type");
    // the internal-service token is server-only and deliberately NOT advertised to browsers
    expect(allowed).not.toContain("x-internal-service-token");
  });
});
