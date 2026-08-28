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

// D-3 — the gated test-login (worker session-mint) seam. OFF by default; enabled
// requires a >=32-char token; STRUCTURALLY impossible to arm in production.
describe("TEST_LOGIN_* (D-3 gated test-login seam — prod-boot-blocked, TD67 fail-closed)", () => {
  const TEST_TOKEN = "t".repeat(32);
  const PROD_SECRETS = { JWT_SECRET: REAL_JWT, PIN_PEPPER: REAL_PIN_PEPPER };

  it("defaults OFF with no token (inert) and a falsey string stays OFF", () => {
    expect(cfg().TEST_LOGIN_ENABLED).toBe(false);
    expect(cfg().TEST_LOGIN_TOKEN).toBeUndefined();
    expect(cfg({ TEST_LOGIN_ENABLED: "false" }).TEST_LOGIN_ENABLED).toBe(false);
    expect(cfg({ TEST_LOGIN_ENABLED: "0" }).TEST_LOGIN_ENABLED).toBe(false);
  });

  it("token set but NOT enabled → inert, passes in every env (incl. production)", () => {
    const c = cfg({ ...FAST2SMS_CREDS, ...PROD_SECRETS, TEST_LOGIN_TOKEN: TEST_TOKEN });
    expect(() => assertAuthConfig(c, "production")).not.toThrow();
    expect(() => assertAuthConfig(cfg({ ...FAST2SMS_CREDS, TEST_LOGIN_TOKEN: TEST_TOKEN }), "development")).not.toThrow();
  });

  it("enabled + a >=32-char token passes in development/test/staging", () => {
    const over = { ...FAST2SMS_CREDS, TEST_LOGIN_ENABLED: "true", TEST_LOGIN_TOKEN: TEST_TOKEN };
    expect(() => assertAuthConfig(cfg(over), "development")).not.toThrow();
    expect(() => assertAuthConfig(cfg(over), "test")).not.toThrow();
    // staging needs the non-dev secrets too (dev JWT/PIN defaults are rejected outside dev/test).
    expect(() => assertAuthConfig(cfg({ ...over, ...PROD_SECRETS }), "staging")).not.toThrow();
  });

  it("enabled in PRODUCTION fails boot even fully configured (hard structural block)", () => {
    const c = cfg({
      ...FAST2SMS_CREDS,
      ...PROD_SECRETS,
      TEST_LOGIN_ENABLED: "true",
      TEST_LOGIN_TOKEN: TEST_TOKEN,
    });
    expect(() => assertAuthConfig(c, "production")).toThrow(/TEST_LOGIN_ENABLED/i);
  });

  it("enabled with an UNSET / unknown NODE_ENV fails boot (can't prove it's not production)", () => {
    const c = cfg({
      ...FAST2SMS_CREDS,
      ...PROD_SECRETS,
      TEST_LOGIN_ENABLED: "true",
      TEST_LOGIN_TOKEN: TEST_TOKEN,
    });
    expect(() => assertAuthConfig(c, "")).toThrow(/TEST_LOGIN_ENABLED/i);
    expect(() => assertAuthConfig(c, "prod")).toThrow(/TEST_LOGIN_ENABLED/i); // typo ≠ staging
    // CASE-typos must NOT slip through the allow-list (the match is exact, never
    // case-folded): "Production"/"Staging"/"DEVELOPMENT" are all unknown envs ⇒ refuse.
    for (const typo of ["Production", "PRODUCTION", "Staging", "STAGING", "DEVELOPMENT", "Test"]) {
      expect(() => assertAuthConfig(c, typo), `${typo} must not arm the seam`).toThrow(
        /TEST_LOGIN_ENABLED/i,
      );
    }
    // Truly UNSET env: an explicit `undefined` arg falls back to process.env.NODE_ENV
    // (the default param), so delete it for the assertion — same pattern as the
    // "treats UNSET NODE_ENV as non-dev" test above.
    const prev = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    try {
      expect(() => assertAuthConfig(c)).toThrow(/TEST_LOGIN_ENABLED/i);
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
    }
  });

  it("enabled WITHOUT a token fails boot (TD67 — never arm vacuously)", () => {
    const c = cfg({ ...FAST2SMS_CREDS, TEST_LOGIN_ENABLED: "true" });
    expect(() => assertAuthConfig(c, "development")).toThrow(/TEST_LOGIN_TOKEN/i);
  });

  it("an EMPTY-STRING or short token is a PARSE error in every env (never 'silently off')", () => {
    expect(() => cfg({ TEST_LOGIN_TOKEN: "" })).toThrow();
    expect(() => cfg({ TEST_LOGIN_TOKEN: "short" })).toThrow();
    expect(() => cfg({ TEST_LOGIN_ENABLED: "true", TEST_LOGIN_TOKEN: "" })).toThrow();
  });

  // Review L1 — the IP-INDEPENDENT daily backstop (a token holder rotating IPs).
  it("TEST_LOGIN_MAX_PER_DAY defaults to 200, coerces, and allows 0 as the kill-switch", () => {
    expect(cfg().TEST_LOGIN_MAX_PER_DAY).toBe(200);
    expect(cfg({ TEST_LOGIN_MAX_PER_DAY: "25" }).TEST_LOGIN_MAX_PER_DAY).toBe(25);
    // 0 = PAUSED (refuse the next mint) — deliberate, mirrors OTP_GLOBAL_MAX_SENDS_PER_DAY.
    expect(cfg({ TEST_LOGIN_MAX_PER_DAY: "0" }).TEST_LOGIN_MAX_PER_DAY).toBe(0);
    // Negative is nonsense — rejected (fail closed).
    expect(() => cfg({ TEST_LOGIN_MAX_PER_DAY: "-1" })).toThrow();
  });
});

describe("isUsingDevJwtDefault", () => {
  it("is true with the dev default and false with a real secret", () => {
    expect(isUsingDevJwtDefault(cfg())).toBe(true);
    expect(cfg().JWT_SECRET).toBe(DEV_JWT_SECRET);
    expect(isUsingDevJwtDefault(cfg({ JWT_SECRET: REAL_JWT }))).toBe(false);
  });
});

describe("throttle/edge knobs (TD25 trust proxy + TD60 per-phone daily cap)", () => {
  it("TRUST_PROXY_HOP_COUNT defaults to 0 (disabled, fail-safe) and coerces strings", () => {
    expect(cfg().TRUST_PROXY_HOP_COUNT).toBe(0);
    expect(cfg({ TRUST_PROXY_HOP_COUNT: "2" }).TRUST_PROXY_HOP_COUNT).toBe(2);
    // A negative hop count is nonsense — nonnegative() rejects it (fail closed).
    expect(() => cfg({ TRUST_PROXY_HOP_COUNT: "-1" })).toThrow();
  });

  it("OTP_MAX_SENDS_PER_DAY defaults to 50 and must be positive (0-as-kill-switch is the GLOBAL cap's job)", () => {
    // 50/day per phone — the owner ruling (2026-08-27) gating the send path by phone number ONLY.
    expect(cfg().OTP_MAX_SENDS_PER_DAY).toBe(50);
    expect(cfg({ OTP_MAX_SENDS_PER_DAY: "25" }).OTP_MAX_SENDS_PER_DAY).toBe(25);
    expect(() => cfg({ OTP_MAX_SENDS_PER_DAY: "0" })).toThrow();
  });
});

describe("account-deletion grace knobs (ADR-0031)", () => {
  it("ACCOUNT_DELETION_GRACE_DAYS defaults to 7 (the disclosed '7 din' promise) and must be positive", () => {
    expect(cfg().ACCOUNT_DELETION_GRACE_DAYS).toBe(7);
    expect(cfg({ ACCOUNT_DELETION_GRACE_DAYS: "14" }).ACCOUNT_DELETION_GRACE_DAYS).toBe(14);
    // 0 would silently restore immediate erasure — must be an explicit code change, not env.
    expect(() => cfg({ ACCOUNT_DELETION_GRACE_DAYS: "0" })).toThrow();
  });

  it("ACCOUNT_DELETION_SWEEP_INTERVAL_HOURS defaults to 1, allows fractional, rejects 0", () => {
    expect(cfg().ACCOUNT_DELETION_SWEEP_INTERVAL_HOURS).toBe(1);
    expect(cfg({ ACCOUNT_DELETION_SWEEP_INTERVAL_HOURS: "0.25" }).ACCOUNT_DELETION_SWEEP_INTERVAL_HOURS).toBe(0.25);
    expect(() => cfg({ ACCOUNT_DELETION_SWEEP_INTERVAL_HOURS: "0" })).toThrow();
  });

  it("grace (pre-erasure, days) and cooldown (post-erasure, seconds) are independent knobs", () => {
    const c = cfg({ ACCOUNT_DELETION_GRACE_DAYS: "3", ACCOUNT_DELETION_COOLDOWN_SECONDS: "0" });
    expect(c.ACCOUNT_DELETION_GRACE_DAYS).toBe(3);
    expect(c.ACCOUNT_DELETION_COOLDOWN_SECONDS).toBe(0); // cooldown still disable-able
  });
});

// ===========================================================================
// #1187 — TEST_IMMEDIATE_DELETE_ENABLED: the QA-only immediate hard-delete seam.
//
// Mirrors the TEST_LOGIN_ENABLED structural block above, for a strictly worse failure: test-login
// mints a session, this seam DESTROYS a worker row with no OTP, no ADR-0031 grace and no undo.
// OFF-by-default alone was never enough — it left ONE env var between production and permanent
// data loss. These tests exist so that guarantee cannot be quietly removed.
// ===========================================================================
describe("assertAuthConfig — TEST_IMMEDIATE_DELETE_ENABLED (#1187)", () => {
  const PROD = { JWT_SECRET: REAL_JWT, PIN_PEPPER: REAL_PIN_PEPPER };
  const armed = () =>
    cfg({ ...FAST2SMS_CREDS, ...PROD, TEST_IMMEDIATE_DELETE_ENABLED: "true" });

  it("defaults OFF, and a falsey string stays OFF (fail-safe to inert)", () => {
    expect(cfg().TEST_IMMEDIATE_DELETE_ENABLED).toBe(false);
    expect(cfg({ TEST_IMMEDIATE_DELETE_ENABLED: "false" }).TEST_IMMEDIATE_DELETE_ENABLED).toBe(
      false,
    );
    expect(cfg({ TEST_IMMEDIATE_DELETE_ENABLED: "0" }).TEST_IMMEDIATE_DELETE_ENABLED).toBe(false);
    expect(cfg({ TEST_IMMEDIATE_DELETE_ENABLED: "" }).TEST_IMMEDIATE_DELETE_ENABLED).toBe(false);
  });

  it("a non-boolean string is a PARSE error, never a silent arm", () => {
    // booleanFromString is a strict enum union, so "yes"/"TRUE" cannot coerce to true. A
    // fat-fingered value fails loudly at boot rather than arming irreversible deletion.
    expect(() => cfg({ TEST_IMMEDIATE_DELETE_ENABLED: "yes" })).toThrow();
    expect(() => cfg({ TEST_IMMEDIATE_DELETE_ENABLED: "TRUE" })).toThrow();
  });

  // ⚠ THESE TWO CASES ARE INVERTED FROM WHAT #1187 SHIPPED, and that is the point of keeping
  // them rather than deleting them. #1187 asserted a production boot REFUSAL; the owner removed
  // that guard on 2026-08-27 so the seam can be armed on the production backend. They now assert
  // the opposite, so that re-adding the refusal — by edit, by revert, or by a well-meaning reader
  // who finds the removal alarming — FAILS LOUDLY here instead of silently breaking the shipped
  // product. A removed guard with no test is how a decision quietly becomes a regression.
  it("armed in PRODUCTION now BOOTS — the #1187 refusal was removed by owner decision", () => {
    expect(() => assertAuthConfig(armed(), "production")).not.toThrow();
  });

  it("armed with an UNSET / unknown / mis-cased NODE_ENV also boots — no env is special now", () => {
    const c = armed();
    expect(() => assertAuthConfig(c, "")).not.toThrow();
    expect(() => assertAuthConfig(c, "prod")).not.toThrow();
    // These used to be the typo cases that must NOT arm the seam. There is no longer an
    // environment in which the flag is refused, so a typo cannot change the outcome either.
    for (const typo of ["Production", "PRODUCTION", "Staging", "STAGING", "DEVELOPMENT", "Test"]) {
      expect(() => assertAuthConfig(c, typo), `${typo} must boot`).not.toThrow();
    }
    // Truly UNSET: an explicit `undefined` falls back to process.env.NODE_ENV (the default
    // param), so delete it for the assertion — the same pattern the test-login block uses.
    const prev = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    try {
      expect(() => assertAuthConfig(c)).not.toThrow();
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
    }
  });

  it("armed in development/test/staging boots — staging IS the QA box this seam serves", () => {
    for (const env of ["development", "test", "staging"]) {
      expect(() => assertAuthConfig(armed(), env), `${env} must be allowed`).not.toThrow();
    }
  });

  it("OFF in production boots normally — the flag only ever blocks when explicitly armed", () => {
    const c = cfg({ ...FAST2SMS_CREDS, ...PROD });
    expect(() => assertAuthConfig(c, "production")).not.toThrow();
  });
});

// ===========================================================================
// #1264 — TEST_IMMEDIATE_DELETE_WORKER_IDS: the SECOND NAME the seam was missing.
//
// #1187 made the gate structural because the boolean "left one env var between production and
// permanent data loss", with a blast radius of every authenticated worker. The allowlist makes
// that radius enumerable, which is what lets the seam exist on a production backend at all —
// so production is permitted ONLY alongside a non-empty list, and the boolean alone still
// refuses exactly as it did before. These tests pin both halves.
// ===========================================================================
describe("assertAuthConfig — TEST_IMMEDIATE_DELETE_WORKER_IDS (#1264)", () => {
  const PROD = { JWT_SECRET: REAL_JWT, PIN_PEPPER: REAL_PIN_PEPPER };
  const DEV_A = "11111111-1111-4111-8111-111111111111";
  const DEV_B = "22222222-2222-4222-8222-222222222222";
  const armedWith = (ids: string) =>
    cfg({
      ...FAST2SMS_CREDS,
      ...PROD,
      TEST_IMMEDIATE_DELETE_ENABLED: "true",
      TEST_IMMEDIATE_DELETE_WORKER_IDS: ids,
    });

  it("defaults to an EMPTY list, and empty/whitespace parse to [] rather than throwing", () => {
    // The 2026-08-25 crash-loop shape: compose's `${VAR:-}` passes VAR="" INTO the container, so
    // a schema that threw on the empty string would take the API down on a variable nobody set.
    expect(cfg().TEST_IMMEDIATE_DELETE_WORKER_IDS).toEqual([]);
    expect(cfg({ TEST_IMMEDIATE_DELETE_WORKER_IDS: "" }).TEST_IMMEDIATE_DELETE_WORKER_IDS).toEqual(
      [],
    );
    expect(
      cfg({ TEST_IMMEDIATE_DELETE_WORKER_IDS: "   " }).TEST_IMMEDIATE_DELETE_WORKER_IDS,
    ).toEqual([]);
  });

  it("parses a comma-separated list, tolerating spacing, and collapses duplicates", () => {
    expect(
      cfg({ TEST_IMMEDIATE_DELETE_WORKER_IDS: ` ${DEV_A} , ${DEV_B} ,${DEV_A}, ` })
        .TEST_IMMEDIATE_DELETE_WORKER_IDS,
    ).toEqual([DEV_A, DEV_B]);
  });

  it("a MALFORMED id is a parse error, never silently dropped", () => {
    // Dropping would be fail-safe in the narrow sense (fewer ids permitted) but turns a typo
    // into a silent 404 that gets debugged against the client. Fail at boot, name the value.
    expect(() => cfg({ TEST_IMMEDIATE_DELETE_WORKER_IDS: "not-a-uuid" })).toThrow();
    expect(() => cfg({ TEST_IMMEDIATE_DELETE_WORKER_IDS: `${DEV_A},nope` })).toThrow();
  });

  it("PRODUCTION + armed + a NON-EMPTY allowlist boots — this is the whole point of #1264", () => {
    expect(() => assertAuthConfig(armedWith(DEV_A), "production")).not.toThrow();
    expect(() => assertAuthConfig(armedWith(`${DEV_A},${DEV_B}`), "production")).not.toThrow();
  });

  it("PRODUCTION + armed + an EMPTY allowlist BOOTS — the allowlist is optional, not required", () => {
    // INVERTED on 2026-08-27, deliberately. This case previously asserted a crash, on the
    // grounds that a boolean-only production box must never get a live seam. The owner decided
    // the opposite: the button deletes whoever taps it, and the gate is which APK ships it.
    // The assertion is kept and flipped so re-adding the requirement fails here rather than
    // crash-looping the production API on a config that is now the intended one.
    expect(() => assertAuthConfig(armedWith(""), "production")).not.toThrow();
    expect(() => assertAuthConfig(armedWith("   "), "production")).not.toThrow();
  });

  it("an UNSET or mis-cased NODE_ENV with an empty list also boots — no env is special now", () => {
    for (const env of ["", "prod", "Production", "PRODUCTION", "Staging"]) {
      expect(() => assertAuthConfig(armedWith(""), env), `${env} must boot`).not.toThrow();
    }
  });

  it("dev/test/staging keep booting with an EMPTY list — nothing that works today breaks", () => {
    // The asymmetry is deliberate: the permissive reading of an empty list is confined to the
    // environments where the boolean was ALREADY the whole gate, so this cannot widen anything.
    for (const env of ["development", "test", "staging"]) {
      expect(() => assertAuthConfig(armedWith(""), env), `${env} must still boot`).not.toThrow();
    }
  });

  it("an allowlist WITHOUT the flag arms nothing, in any environment", () => {
    // The list is not a second way to turn the seam on. Both names, or nothing.
    const listOnly = cfg({
      ...FAST2SMS_CREDS,
      ...PROD,
      TEST_IMMEDIATE_DELETE_ENABLED: "false",
      TEST_IMMEDIATE_DELETE_WORKER_IDS: DEV_A,
    });
    expect(listOnly.TEST_IMMEDIATE_DELETE_ENABLED).toBe(false);
    expect(() => assertAuthConfig(listOnly, "production")).not.toThrow();
  });
});
