import { describe, it, expect } from "vitest";
import {
  loadServerConfig,
  realAiCallsBlockedReason,
  areRealAiCallsEnabled,
  realPaymentsBlockedReason,
  areRealPaymentsEnabled,
  assertPaymentsConfig,
  getRazorpayCredentials,
  type ServerConfig,
  realMessagingBlockedReason,
  areRealMessagesEnabled,
  assertMessagingConfig,
  realMemberInvitesBlockedReason,
  areRealMemberInvitesEnabled,
  assertMemberInvitesConfig,
  isCapacityEnforcementEnabled,
  isRealOtpSmsActive,
  isRealPayerEmailActive,
  resolveCorsOrigins,
} from "./server";
import { loadPublicConfig } from "./public";

describe("CORS origin resolution (no `*`; fail-closed outside dev)", () => {
  it("reflects the request origin (true) in an explicit dev/test env", () => {
    const config = loadServerConfig({ CORS_ALLOWED_ORIGINS: "" });
    expect(resolveCorsOrigins(config, "development")).toBe(true);
    expect(resolveCorsOrigins(config, "test")).toBe(true);
  });

  it("uses the explicit allow-list outside dev (trimmed, empties dropped)", () => {
    const config = loadServerConfig({
      CORS_ALLOWED_ORIGINS: "https://ops.badabhai.in, https://app.badabhai.in ,",
    });
    expect(resolveCorsOrigins(config, "production")).toEqual([
      "https://ops.badabhai.in",
      "https://app.badabhai.in",
    ]);
  });

  it("DENIES all cross-origin (false) when the list is empty outside dev — fail closed, never `*`", () => {
    const config = loadServerConfig({ CORS_ALLOWED_ORIGINS: "" });
    expect(resolveCorsOrigins(config, "production")).toBe(false);
    expect(resolveCorsOrigins(config, "staging")).toBe(false);
  });

  it("treats UNSET NODE_ENV as non-dev → fail closed (no arg → default reads process.env)", () => {
    const prev = process.env.NODE_ENV;
    delete process.env.NODE_ENV; // passing `undefined` would re-trigger the default param
    try {
      const config = loadServerConfig({ CORS_ALLOWED_ORIGINS: "" });
      expect(resolveCorsOrigins(config)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
    }
  });

  it("never returns the literal '*' wildcard", () => {
    const config = loadServerConfig({ CORS_ALLOWED_ORIGINS: "*" });
    // A literal "*" in the list is treated as an (unusual) exact origin entry, not
    // a wildcard expansion — the resolver itself never emits "*" as the mode.
    const out = resolveCorsOrigins(config, "production");
    expect(out).not.toBe(true);
    expect(typeof out === "boolean" || Array.isArray(out)).toBe(true);
  });
});

describe("ai_jobs retention knobs (PERF-3 — 90-day owner decision, dry-run by default)", () => {
  it("AI_JOBS_RETENTION_DAYS defaults to 90 (the recorded owner decision) and must be positive", () => {
    expect(loadServerConfig({}).AI_JOBS_RETENTION_DAYS).toBe(90);
    expect(loadServerConfig({ AI_JOBS_RETENTION_DAYS: "30" }).AI_JOBS_RETENTION_DAYS).toBe(30);
    // 0 would mean "prune everything terminal immediately" — must be a code change, not env.
    expect(() => loadServerConfig({ AI_JOBS_RETENTION_DAYS: "0" })).toThrow();
    expect(() => loadServerConfig({ AI_JOBS_RETENTION_DAYS: "-1" })).toThrow();
  });

  it("AI_JOBS_RETENTION_SWEEP_INTERVAL_HOURS defaults to 24, allows fractional, rejects 0", () => {
    expect(loadServerConfig({}).AI_JOBS_RETENTION_SWEEP_INTERVAL_HOURS).toBe(24);
    expect(
      loadServerConfig({ AI_JOBS_RETENTION_SWEEP_INTERVAL_HOURS: "0.5" })
        .AI_JOBS_RETENTION_SWEEP_INTERVAL_HOURS,
    ).toBe(0.5);
    expect(() => loadServerConfig({ AI_JOBS_RETENTION_SWEEP_INTERVAL_HOURS: "0" })).toThrow();
  });

  it("AI_JOBS_RETENTION_DELETE_ENABLED defaults OFF (dry-run) and falsey strings stay OFF", () => {
    expect(loadServerConfig({}).AI_JOBS_RETENTION_DELETE_ENABLED).toBe(false);
    expect(
      loadServerConfig({ AI_JOBS_RETENTION_DELETE_ENABLED: "false" }).AI_JOBS_RETENTION_DELETE_ENABLED,
    ).toBe(false);
    expect(
      loadServerConfig({ AI_JOBS_RETENTION_DELETE_ENABLED: "0" }).AI_JOBS_RETENTION_DELETE_ENABLED,
    ).toBe(false);
  });

  it("arming real deletion requires the explicit 'true'/'1' flag", () => {
    expect(
      loadServerConfig({ AI_JOBS_RETENTION_DELETE_ENABLED: "true" }).AI_JOBS_RETENTION_DELETE_ENABLED,
    ).toBe(true);
    expect(
      loadServerConfig({ AI_JOBS_RETENTION_DELETE_ENABLED: "1" }).AI_JOBS_RETENTION_DELETE_ENABLED,
    ).toBe(true);
  });
});

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
    expect(
      loadServerConfig({ CAPACITY_DEFAULT_MAX_ACTIVE_VACANCIES: "0" })
        .CAPACITY_DEFAULT_MAX_ACTIVE_VACANCIES,
    ).toBe(0);
  });

  it("capacity enforcement defaults OFF (shadow/inert; fail-safe default)", () => {
    const config = loadServerConfig({});
    expect(config.CAPACITY_ENFORCEMENT_ENABLED).toBe(false);
    expect(isCapacityEnforcementEnabled(config)).toBe(false);
  });

  it("capacity enforcement is tunable to ON (coerced from 'true'/'1')", () => {
    expect(
      isCapacityEnforcementEnabled(loadServerConfig({ CAPACITY_ENFORCEMENT_ENABLED: "true" })),
    ).toBe(true);
    expect(
      isCapacityEnforcementEnabled(loadServerConfig({ CAPACITY_ENFORCEMENT_ENABLED: "1" })),
    ).toBe(true);
    // and stays OFF for the falsey forms
    expect(
      isCapacityEnforcementEnabled(loadServerConfig({ CAPACITY_ENFORCEMENT_ENABLED: "false" })),
    ).toBe(false);
    expect(
      isCapacityEnforcementEnabled(loadServerConfig({ CAPACITY_ENFORCEMENT_ENABLED: "0" })),
    ).toBe(false);
  });

  it("ADMIN-3b PII-reveal defaults OFF (the route is inert until its security review; Control 1)", () => {
    const config = loadServerConfig({});
    expect(config.ADMIN_PII_REVEAL_ENABLED).toBe(false);
  });

  it("ADMIN-3b PII-reveal flag is tunable to ON (coerced from 'true'/'1'; stays OFF on falsey forms)", () => {
    expect(loadServerConfig({ ADMIN_PII_REVEAL_ENABLED: "true" }).ADMIN_PII_REVEAL_ENABLED).toBe(true);
    expect(loadServerConfig({ ADMIN_PII_REVEAL_ENABLED: "1" }).ADMIN_PII_REVEAL_ENABLED).toBe(true);
    expect(loadServerConfig({ ADMIN_PII_REVEAL_ENABLED: "false" }).ADMIN_PII_REVEAL_ENABLED).toBe(false);
    expect(loadServerConfig({ ADMIN_PII_REVEAL_ENABLED: "0" }).ADMIN_PII_REVEAL_ENABLED).toBe(false);
    expect(loadServerConfig({ ADMIN_PII_REVEAL_ENABLED: "" }).ADMIN_PII_REVEAL_ENABLED).toBe(false);
  });

  it("ADMIN-3b per-admin reveal caps expose sane positive defaults (config-driven, tunable)", () => {
    const config = loadServerConfig({});
    expect(config.ADMIN_PII_REVEAL_MAX_PER_HOUR).toBe(10);
    expect(config.ADMIN_PII_REVEAL_MAX_PER_DAY).toBe(30);
    expect(loadServerConfig({ ADMIN_PII_REVEAL_MAX_PER_HOUR: "3" }).ADMIN_PII_REVEAL_MAX_PER_HOUR).toBe(3);
    expect(loadServerConfig({ ADMIN_PII_REVEAL_MAX_PER_DAY: "5" }).ADMIN_PII_REVEAL_MAX_PER_DAY).toBe(5);
    // positive-only: a non-positive cap is rejected (an unbounded/zero reveal cap is unsafe).
    expect(() => loadServerConfig({ ADMIN_PII_REVEAL_MAX_PER_HOUR: "0" })).toThrow();
  });

  it("the NAME-egress caps are a SEPARATE, larger budget (300/hour, 1000/day) and positive-only", () => {
    // A second budget, not a share of the reveal's: these count NAMES disclosed by a list read,
    // where one page can be fifty, while the reveal's 10/hour counts single-subject phone
    // reveals. Sharing either number would either strangle the console or gut the reveal cap.
    const config = loadServerConfig({});
    expect(config.ADMIN_IDENTITY_MAX_PER_HOUR).toBe(300);
    expect(config.ADMIN_IDENTITY_MAX_PER_DAY).toBe(1000);
    // ...and they are genuinely independent of the reveal's, not aliases of it.
    expect(config.ADMIN_IDENTITY_MAX_PER_HOUR).not.toBe(config.ADMIN_PII_REVEAL_MAX_PER_HOUR);
    expect(loadServerConfig({ ADMIN_IDENTITY_MAX_PER_HOUR: "7" }).ADMIN_IDENTITY_MAX_PER_HOUR).toBe(7);
    expect(loadServerConfig({ ADMIN_IDENTITY_MAX_PER_DAY: "9" }).ADMIN_IDENTITY_MAX_PER_DAY).toBe(9);
    // Zero would mean "names are off", which must be a capability decision, not an env typo.
    expect(() => loadServerConfig({ ADMIN_IDENTITY_MAX_PER_HOUR: "0" })).toThrow();
    expect(() => loadServerConfig({ ADMIN_IDENTITY_MAX_PER_DAY: "-1" })).toThrow();
  });

  it("the AI-TRACE read flag is OFF by default and stays off for every falsey string", () => {
    // Migration 0083. This one gates a WHOLE SURFACE (list and decrypt), not just a field on a
    // response — with it off, `AdminAiTraceFlagGuard` answers a neutral 404 to every admin role.
    // Same `booleanFromString` posture as ADMIN_PII_REVEAL_ENABLED above, and the `""` case is
    // the one that matters on the box: a compose `${VAR:-false}` pass-through with an unset
    // GitHub secret arrives as an empty string, and that must read as OFF, not throw.
    expect(loadServerConfig({}).ADMIN_AI_TRACE_READ_ENABLED).toBe(false);
    expect(loadServerConfig({ ADMIN_AI_TRACE_READ_ENABLED: "true" }).ADMIN_AI_TRACE_READ_ENABLED).toBe(true);
    expect(loadServerConfig({ ADMIN_AI_TRACE_READ_ENABLED: "1" }).ADMIN_AI_TRACE_READ_ENABLED).toBe(true);
    expect(loadServerConfig({ ADMIN_AI_TRACE_READ_ENABLED: "false" }).ADMIN_AI_TRACE_READ_ENABLED).toBe(false);
    expect(loadServerConfig({ ADMIN_AI_TRACE_READ_ENABLED: "0" }).ADMIN_AI_TRACE_READ_ENABLED).toBe(false);
    expect(loadServerConfig({ ADMIN_AI_TRACE_READ_ENABLED: "" }).ADMIN_AI_TRACE_READ_ENABLED).toBe(false);
  });

  it("the AI-TRACE decrypt caps are a THIRD budget (20/hour, 60/day) and REJECT an empty string", () => {
    // Sized in DISCLOSURES and deliberately small — a debugging session, not a corpus — and
    // genuinely independent of the other two budgets rather than an alias of either.
    const config = loadServerConfig({});
    expect(config.ADMIN_AI_TRACE_MAX_PER_HOUR).toBe(20);
    expect(config.ADMIN_AI_TRACE_MAX_PER_DAY).toBe(60);
    expect(config.ADMIN_AI_TRACE_MAX_PER_HOUR).not.toBe(config.ADMIN_IDENTITY_MAX_PER_HOUR);
    expect(config.ADMIN_AI_TRACE_MAX_PER_HOUR).not.toBe(config.ADMIN_PII_REVEAL_MAX_PER_HOUR);
    expect(loadServerConfig({ ADMIN_AI_TRACE_MAX_PER_HOUR: "7" }).ADMIN_AI_TRACE_MAX_PER_HOUR).toBe(7);
    expect(loadServerConfig({ ADMIN_AI_TRACE_MAX_PER_DAY: "9" }).ADMIN_AI_TRACE_MAX_PER_DAY).toBe(9);
    // Zero/negative would mean "the read is off", which must be the FLAG's decision, not a typo.
    expect(() => loadServerConfig({ ADMIN_AI_TRACE_MAX_PER_HOUR: "0" })).toThrow();
    expect(() => loadServerConfig({ ADMIN_AI_TRACE_MAX_PER_DAY: "-1" })).toThrow();
    // ⚠ THE BOOT-CRASH TRAP, PINNED. Unlike the flag above, these are `z.coerce.number()`:
    // `""` coerces to 0, `.positive()` rejects it, and the WHOLE config parse throws — so a
    // `${ADMIN_AI_TRACE_MAX_PER_HOUR:-}` pass-through in compose would kill every boot on that
    // box (BL-21 / #858). This assertion is what makes that a known refusal rather than an
    // outage somebody debugs at 2am, and it must fail if the schema is ever softened to
    // `optionalSecret()`-style empty tolerance without the compose line being written first.
    expect(() => loadServerConfig({ ADMIN_AI_TRACE_MAX_PER_HOUR: "" })).toThrow();
    expect(() => loadServerConfig({ ADMIN_AI_TRACE_MAX_PER_DAY: "" })).toThrow();
  });

  // ── #858: the two service-to-service tokens, now empty-tolerant ────────────────────
  //
  // Both are declared in docker-compose as `${VAR:-}` pass-throughs so the box can arm them
  // with no code change. That form sets the variable to the EMPTY STRING when unconfigured,
  // and a bare `.optional()` REJECTS "" — which is why neither could be bridged at all, and
  // why the FORK-B-1 seam sat unwired and the ai-service ran unauthenticated on the box.
  //
  // The contrast with ADMIN_AI_TRACE_MAX_PER_HOUR above is the whole point: that one is still
  // deliberately empty-INtolerant, because no compose line declares it. Empty tolerance is
  // earned per-variable by the pass-through existing, never applied as a blanket.
  it("SKILLS_INTERNAL_TOKEN treats an ABSENT secret and an EMPTY pass-through identically", () => {
    expect(loadServerConfig({}).SKILLS_INTERNAL_TOKEN).toBeUndefined();
    expect(loadServerConfig({ SKILLS_INTERNAL_TOKEN: "" }).SKILLS_INTERNAL_TOKEN).toBeUndefined();
    // A real value still arrives intact — the seam is armed by presence, never by shape.
    expect(loadServerConfig({ SKILLS_INTERNAL_TOKEN: "s3cr3t" }).SKILLS_INTERNAL_TOKEN).toBe("s3cr3t");
  });

  it("AI_INTERNAL_TOKEN does the same, and STILL rejects a short non-empty value", () => {
    expect(loadServerConfig({}).AI_INTERNAL_TOKEN).toBeUndefined();
    expect(loadServerConfig({ AI_INTERNAL_TOKEN: "" }).AI_INTERNAL_TOKEN).toBeUndefined();
    const valid = "x".repeat(20);
    expect(loadServerConfig({ AI_INTERNAL_TOKEN: valid }).AI_INTERNAL_TOKEN).toBe(valid);
    // THE HALF THAT MUST NOT MOVE. `.min(16)` still applies to every non-empty value: a short
    // token is a REAL value that would arm a weak gate, and it is still a boot failure. Only
    // "" was reclassified, and only to the meaning it already had everywhere else.
    expect(() => loadServerConfig({ AI_INTERNAL_TOKEN: "short" })).toThrow();
    expect(() => loadServerConfig({ AI_INTERNAL_TOKEN: "x".repeat(15) })).toThrow();
  });

  it("neither token is REQUIRED — an unarmed deployment still boots", () => {
    // The regression this exists to prevent: making a secret mandatory would take down every
    // box that has not created it yet, which is precisely the failure mode #858 describes.
    expect(() => loadServerConfig({})).not.toThrow();
    expect(() =>
      loadServerConfig({ SKILLS_INTERNAL_TOKEN: "", AI_INTERNAL_TOKEN: "" }),
    ).not.toThrow();
  });

  it("empty tolerance did not leak into UNRELATED secrets", () => {
    // `optionalSecret()` was applied to exactly two fields. A blanket application would have
    // silently reclassified every credential in the schema, so this pins the blast radius.
    expect(() => loadServerConfig({ ADMIN_AI_TRACE_MAX_PER_HOUR: "" })).toThrow();
    expect(() => loadServerConfig({ DATABASE_URL: "not-a-url" })).toThrow();
    expect(() => loadServerConfig({ AI_SERVICE_URL: "not-a-url" })).toThrow();
  });

  it("assertPaymentsConfig is a no-op in the alpha mock default", () => {
    expect(() => assertPaymentsConfig(loadServerConfig({}))).not.toThrow();
  });

  it("assertPaymentsConfig THROWS when real is enabled without a provider key (fail closed)", () => {
    const config = loadServerConfig({ PAYMENTS_ENABLE_REAL: "true" });
    expect(() => assertPaymentsConfig(config)).toThrow(/PAYMENTS_PROVIDER_KEY/);
  });

  it("real payments require the flag AND the FULL Razorpay credential set", () => {
    const config = loadServerConfig({
      PAYMENTS_ENABLE_REAL: "true",
      PAYMENTS_PROVIDER_KEY: "rzp_test_xxx",
      PAYMENTS_PROVIDER_SECRET: "sec_xxx",
      RAZORPAY_WEBHOOK_SECRET: "whsec_xxx",
    });
    expect(realPaymentsBlockedReason(config)).toBeNull();
    expect(areRealPaymentsEnabled(config)).toBe(true);
    expect(() => assertPaymentsConfig(config)).not.toThrow();
  });
});

/**
 * REAL RAZORPAY BOOT GATE — money code, so the fail-closed posture is asserted per-secret
 * and per-failure-mode rather than once. Three secrets are required and each is load-bearing:
 * without the webhook secret every webhook verification fails, so a captured payment would
 * only ever be credited through the browser fallback — a payer on a dropped mobile connection
 * would pay and never receive credits. "Flag + key id" is therefore NOT live.
 */
describe("real Razorpay payments — fail-closed boot gate (all three secrets)", () => {
  const FULL = {
    PAYMENTS_ENABLE_REAL: "true",
    PAYMENTS_PROVIDER_KEY: "rzp_test_keyid",
    PAYMENTS_PROVIDER_SECRET: "rzp_key_secret",
    RAZORPAY_WEBHOOK_SECRET: "rzp_webhook_secret",
  };
  const SECRET_NAMES = [
    "PAYMENTS_PROVIDER_KEY",
    "PAYMENTS_PROVIDER_SECRET",
    "RAZORPAY_WEBHOOK_SECRET",
  ] as const;

  for (const name of SECRET_NAMES) {
    it(`refuses to boot when ${name} is MISSING`, () => {
      const env = { ...FULL };
      delete (env as Record<string, string | undefined>)[name];
      const config = loadServerConfig(env);
      expect(realPaymentsBlockedReason(config)).toBe(`${name} is not set`);
      expect(areRealPaymentsEnabled(config)).toBe(false);
      expect(() => assertPaymentsConfig(config)).toThrow(new RegExp(name));
    });

    it(`refuses to boot when ${name} is an EMPTY STRING (never arms vacuously — TD67)`, () => {
      // A blank is rejected at PARSE time by z.string().min(1) — the earliest possible
      // failure. The process dies at loadServerConfig, long before any money path exists.
      expect(() => loadServerConfig({ ...FULL, [name]: "" })).toThrow(new RegExp(name));

      // …and if a ServerConfig is built by any OTHER means (fixture / partial object), the
      // gate still treats blank + whitespace-only as NOT configured (structural backstop).
      for (const blank of ["", "   ", "\t\n"]) {
        const config = { ...loadServerConfig(FULL), [name]: blank } as ServerConfig;
        expect(realPaymentsBlockedReason(config)).toBe(`${name} is not set`);
        expect(areRealPaymentsEnabled(config)).toBe(false);
        expect(getRazorpayCredentials(config)).toBeNull();
        expect(() => assertPaymentsConfig(config)).toThrow(new RegExp(name));
      }
    });
  }

  it("the boot error names the missing VARS and never echoes a secret VALUE", () => {
    const config = { ...loadServerConfig(FULL), PAYMENTS_PROVIDER_SECRET: "" } as ServerConfig;
    let message = "";
    try {
      assertPaymentsConfig(config);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toContain("PAYMENTS_PROVIDER_SECRET");
    // None of the configured values may appear in the message.
    expect(message).not.toContain(FULL.PAYMENTS_PROVIDER_KEY);
    expect(message).not.toContain(FULL.RAZORPAY_WEBHOOK_SECRET);
    expect(message).not.toContain("rzp_key_secret");
  });

  it("reports EVERY missing var at once (one boot, one complete fix list)", () => {
    const config = loadServerConfig({ PAYMENTS_ENABLE_REAL: "true" });
    expect(() => assertPaymentsConfig(config)).toThrow(/PAYMENTS_PROVIDER_KEY/);
    expect(() => assertPaymentsConfig(config)).toThrow(/PAYMENTS_PROVIDER_SECRET/);
    expect(() => assertPaymentsConfig(config)).toThrow(/RAZORPAY_WEBHOOK_SECRET/);
  });

  it("getRazorpayCredentials is null unless real payments are FULLY enabled", () => {
    expect(getRazorpayCredentials(loadServerConfig({}))).toBeNull(); // mock default
    expect(
      getRazorpayCredentials(
        loadServerConfig({ PAYMENTS_ENABLE_REAL: "true", PAYMENTS_PROVIDER_KEY: "rzp_test_x" }),
      ),
    ).toBeNull(); // flag + key id only — not live
    // Credentials present but the master flag OFF ⇒ still null (the flag is the master gate).
    expect(getRazorpayCredentials(loadServerConfig({ ...FULL, PAYMENTS_ENABLE_REAL: "false" }))).toBeNull();
    expect(getRazorpayCredentials(loadServerConfig(FULL))).toEqual({
      keyId: "rzp_test_keyid",
      keySecret: "rzp_key_secret",
      webhookSecret: "rzp_webhook_secret",
    });
  });
});

describe("messaging config (ADR-0020 — mock WhatsApp in alpha, fail-closed boot)", () => {
  it("defaults to mock: MESSAGING_ENABLE_REAL false and real messaging blocked", () => {
    const config = loadServerConfig({});
    expect(config.MESSAGING_ENABLE_REAL).toBe(false);
    expect(areRealMessagesEnabled(config)).toBe(false);
    expect(realMessagingBlockedReason(config)).toBe("MESSAGING_ENABLE_REAL is false");
  });

  it("assertMessagingConfig is a no-op in the alpha mock default", () => {
    expect(() => assertMessagingConfig(loadServerConfig({}))).not.toThrow();
  });

  it("assertMessagingConfig THROWS when real is enabled without the Meta credentials (fail closed)", () => {
    const config = loadServerConfig({ MESSAGING_ENABLE_REAL: "true" });
    expect(() => assertMessagingConfig(config)).toThrow(/WHATSAPP_API_KEY/);
    expect(() => assertMessagingConfig(config)).toThrow(/WHATSAPP_PHONE_NUMBER_ID/);
  });

  it("assertMessagingConfig THROWS when only one credential is set (still half-configured)", () => {
    const config = loadServerConfig({
      MESSAGING_ENABLE_REAL: "true",
      WHATSAPP_API_KEY: "k",
    });
    expect(() => assertMessagingConfig(config)).toThrow(/WHATSAPP_PHONE_NUMBER_ID/);
  });

  it("real messaging is allowed only with the flag AND both credentials", () => {
    const config = loadServerConfig({
      MESSAGING_ENABLE_REAL: "true",
      WHATSAPP_API_KEY: "k",
      WHATSAPP_PHONE_NUMBER_ID: "p",
    });
    expect(realMessagingBlockedReason(config)).toBeNull();
    expect(areRealMessagesEnabled(config)).toBe(true);
    expect(() => assertMessagingConfig(config)).not.toThrow();
  });
});

describe("member-invite config (ADR-0027 B5.4 — mock mailer in alpha, fail-closed boot)", () => {
  // A fully-satisfiable real email + accept-URL set (ZeptoMail default provider).
  const REAL_ENV = {
    MEMBER_INVITES_ENABLE_REAL: "true",
    ZEPTOMAIL_API_TOKEN: "t",
    ZEPTOMAIL_MAIL_AGENT: "a",
    ZEPTOMAIL_API_URL: "https://api.zeptomail.example/send",
    EMAIL_FROM_ADDRESS: "no-reply@badabhai.example",
    MEMBER_INVITE_ACCEPT_URL: "https://app.badabhai.example/team/accept",
  };

  it("defaults to mock: MEMBER_INVITES_ENABLE_REAL false and real invites blocked", () => {
    const config = loadServerConfig({});
    expect(config.MEMBER_INVITES_ENABLE_REAL).toBe(false);
    expect(areRealMemberInvitesEnabled(config)).toBe(false);
    expect(realMemberInvitesBlockedReason(config)).toBe("MEMBER_INVITES_ENABLE_REAL is false");
    expect(config.MEMBER_INVITE_MAX_PER_ORG).toBe(25);
  });

  it("assertMemberInvitesConfig is a no-op in the alpha mock default", () => {
    expect(() => assertMemberInvitesConfig(loadServerConfig({}))).not.toThrow();
  });

  it("THROWS when real is enabled without the email provider creds (fail closed)", () => {
    const config = loadServerConfig({ MEMBER_INVITES_ENABLE_REAL: "true" });
    expect(() => assertMemberInvitesConfig(config)).toThrow(/ZEPTOMAIL_API_TOKEN/);
  });

  it("THROWS when real is enabled with email creds but no accept URL (fail closed)", () => {
    const { MEMBER_INVITE_ACCEPT_URL: _drop, ...noUrl } = REAL_ENV;
    const config = loadServerConfig(noUrl);
    expect(() => assertMemberInvitesConfig(config)).toThrow(/MEMBER_INVITE_ACCEPT_URL/);
  });

  it("real invites are allowed only with the flag AND full email creds AND the accept URL", () => {
    const config = loadServerConfig(REAL_ENV);
    expect(realMemberInvitesBlockedReason(config)).toBeNull();
    expect(areRealMemberInvitesEnabled(config)).toBe(true);
    expect(() => assertMemberInvitesConfig(config)).not.toThrow();
  });
});

describe("OTP per-caller send/verify budgets (#1306)", () => {
  it("defaults the per-device send cap to 200 — a runaway-client breaker, not an attacker control", () => {
    // WHY THIS IS PINNED AT ALL. `X-Device-Id` is an unauthenticated, caller-chosen header
    // (`senderOf` takes any 8-256 char string, no attestation), so this cap never bound an
    // abuser — they mint a fresh uuid per request. At its old value of 20 the population it
    // reliably bound was our own QA testing many numbers from one handset, which is #1306. Its
    // remaining job is the ACCIDENT: one handset with a stuck resend button or a retry loop in
    // a bad build must not bill us at Fast2SMS line rate. Unasserted, this number could drift
    // back down and reintroduce the outage with nothing failing.
    expect(loadServerConfig({}).OTP_MAX_SENDS_PER_DEVICE_PER_HOUR).toBe(200);
  });

  it("keeps the verify budget DERIVED from the send budget (sends x OTP_MAX_ATTEMPTS)", () => {
    // NOT TWO INDEPENDENT NUMBERS. A handset inside its send budget can legitimately produce
    // OTP_MAX_SENDS_PER_DEVICE_PER_HOUR x OTP_MAX_ATTEMPTS verifies in the same hour, so moving
    // the send cap without this one makes VERIFY the binding constraint at a fraction of the
    // sends it is meant to service — trading a send-side 429 for the strictly worse verify-side
    // one, where the worker is holding a valid code they cannot spend.
    //
    // ASSERTED AS THE RATIO, not as 1000, so the next person to move either number is told
    // about the other. The controller test asserts the same relation against its fixture; this
    // is the copy that binds the REAL shipped defaults.
    const c = loadServerConfig({});
    expect(c.OTP_MAX_VERIFY_PER_DEVICE_PER_HOUR).toBe(
      c.OTP_MAX_SENDS_PER_DEVICE_PER_HOUR * c.OTP_MAX_ATTEMPTS,
    );
  });

  it("keeps the per-phone SMS budgets DISTINCT from the per-caller ones", () => {
    // The category error this file has caught before: a per-PHONE budget (how many texts one
    // NUMBER may receive — real Fast2SMS spend) passed to a per-CALLER limiter. Equal numbers
    // would let the next such swap pass unnoticed.
    const c = loadServerConfig({});
    expect(c.OTP_MAX_SENDS_PER_DEVICE_PER_HOUR).not.toBe(c.OTP_MAX_SENDS_PER_HOUR);
    expect(c.OTP_MAX_SENDS_PER_DEVICE_PER_HOUR).not.toBe(c.OTP_MAX_SENDS_PER_DAY);
    // The per-phone caps are what actually bound spend. The DAILY one was raised 10 -> 30 by
    // owner ruling 2026-09-04: 10 was reachable across a failed onboarding plus a PIN reset,
    // which share one per-phone budget. The HOURLY one stays at 5 deliberately — it is read by
    // admin-otp.service.ts and payer-otp.service.ts too, so it cannot be moved for workers
    // alone. Both numbers are pinned here so neither drifts without that reasoning being read.
    expect(c.OTP_MAX_SENDS_PER_HOUR).toBe(5);
    expect(c.OTP_MAX_SENDS_PER_DAY).toBe(30);
  });

  it("keeps the per-phone HOURLY cap strictly below the DAILY one, or the hourly cap is dead", () => {
    // NOT A STYLE RULE. Both counters INCR on every accepted send (`otp.service.ts`), so if the
    // hourly limit ever equals or exceeds the daily one it can never refuse a request the daily
    // limit would not also refuse inside the same UTC day: it becomes dead configuration that
    // still reads like a live control, and the `phone_hourly_cap` refusal reason stops being
    // reachable in logs. PR #1305 proposed 50/50 and would have shipped precisely that.
    const c = loadServerConfig({});
    expect(c.OTP_MAX_SENDS_PER_HOUR).toBeLessThan(c.OTP_MAX_SENDS_PER_DAY);
  });
});

describe("OTP global daily send circuit-breaker (OTP-5 — the spend ceiling + kill-switch)", () => {
  it("defaults the worker cap to 10000 (#1306) and leaves the payer cap at 2000", () => {
    // THE TWO ARE NOT ONE NUMBER, and #1306 is why they diverged. The worker breaker stopped
    // being a backstop and became THE backstop when the per-network ceiling was dropped from the
    // OTP send path and the per-device one was recognised as rotatable — and because the fuse is
    // SHARED, tripping it 429s every worker until UTC midnight rather than throttling whoever
    // burned it. At 2000 that outage cost a single actor ~2000 requests. The payer path kept its
    // per-IP ceilings and its own channel, so its number did not move; asserting both here keeps
    // the next person from "tidying" them back together.
    const config = loadServerConfig({});
    expect(config.OTP_GLOBAL_MAX_SENDS_PER_DAY).toBe(10000);
    expect(config.PAYER_OTP_GLOBAL_MAX_SENDS_PER_DAY).toBe(2000);
  });

  it("accepts 0 (paused = kill-switch) on both caps — min(0) is deliberate", () => {
    expect(loadServerConfig({ OTP_GLOBAL_MAX_SENDS_PER_DAY: "0" }).OTP_GLOBAL_MAX_SENDS_PER_DAY).toBe(
      0,
    );
    expect(
      loadServerConfig({ PAYER_OTP_GLOBAL_MAX_SENDS_PER_DAY: "0" }).PAYER_OTP_GLOBAL_MAX_SENDS_PER_DAY,
    ).toBe(0);
  });

  it("is tunable (coerced from a string)", () => {
    expect(loadServerConfig({ OTP_GLOBAL_MAX_SENDS_PER_DAY: "500" }).OTP_GLOBAL_MAX_SENDS_PER_DAY).toBe(
      500,
    );
  });

  it("rejects a negative cap (min(0) floor)", () => {
    expect(() => loadServerConfig({ OTP_GLOBAL_MAX_SENDS_PER_DAY: "-1" })).toThrow();
    expect(() => loadServerConfig({ PAYER_OTP_GLOBAL_MAX_SENDS_PER_DAY: "-1" })).toThrow();
  });

  it("isRealOtpSmsActive: ALWAYS true — worker OTP is real-only (fast2sms; no console fallback)", () => {
    // The SMS path is real-only (the literal default is fast2sms), so the spend signal —
    // and therefore the global daily send circuit-breaker — always enforces.
    expect(isRealOtpSmsActive(loadServerConfig({}))).toBe(true); // fast2sms default
    expect(isRealOtpSmsActive(loadServerConfig({ SMS_PROVIDER: "fast2sms" }))).toBe(true);
  });

  it("isRealPayerEmailActive: ALWAYS true — the payer email channel is real-only (zeptomail/smtp)", () => {
    // The email channel is real-only (no "none"/mock), so the spend signal always fires;
    // boot-time creds are gated separately (assertPayerAuthConfig / emailProviderBlockedReason).
    expect(isRealPayerEmailActive(loadServerConfig({}))).toBe(true); // zeptomail default
    expect(
      isRealPayerEmailActive(
        loadServerConfig({
          EMAIL_PROVIDER: "smtp",
          SMTP_HOST: "h",
          SMTP_USER: "u",
          SMTP_PASS: "p",
          EMAIL_FROM_ADDRESS: "otp@example.com",
        }),
      ),
    ).toBe(true);
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
