import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { validateEvent } from "@badabhai/event-schema";
import type { RequestContext } from "../common/request-context";
import { OtpSendCapExceededException } from "../common/otp-send-cap";
import { PAYER_TEST_LOGIN_DOMAIN } from "../payers/payer-test-login.guard";
import { PayerAuthService } from "./payer-auth.service";
import { PayerTenantScopeService } from "../payers/payer-tenant-scope.service";
import type { PayerOrgsRepository } from "../payers/payer-orgs.repository";
import type { ActiveMembershipFacts } from "../payers/payer-tenant-scope";

const CTX: RequestContext = {
  correlationId: "11111111-1111-4111-8111-111111111111",
  requestId: "req-1",
};
const PAYER_ID = "aaaaaaaa-0000-4000-8000-000000000001";
/** Opaque test-double password hash (deterministic, never embeds the raw password). */
const pwHashFor = (p: string): string => `pw$${[...p].reverse().join("")}${p.length}`;
const EMAIL = "boss@acme.com";
/** Inside the reserved RFC 2606 `.invalid` domain the test-login seam is allowed to mint for. */
const SYNTHETIC_EMAIL = `e2e-1${PAYER_TEST_LOGIN_DOMAIN}`;
const ORG = "Acme Manufacturing Pvt Ltd";
const PHONE = "+919876543210";

function setup(over: { method?: "email_otp" | "whatsapp" | "supabase" } = {}) {
  const config = {
    PAYER_LOGIN_METHOD: over.method ?? "email_otp",
    OTP_RESEND_COOLDOWN_SECONDS: 30,
    PAYER_PASSWORD_MAX_ATTEMPTS: 5,
    PAYER_PASSWORD_LOCKOUT_SECONDS: 900,
    PAYER_TEMP_PASSWORD_TTL_HOURS: 168,
  } as unknown as ServerConfig;

  const account: Record<string, unknown> = {
    id: PAYER_ID,
    role: "employer",
    status: "active",
    // #2563 — defaults for every fixture: an ordinary, non-revoked, self-set password.
    mustChangePassword: false,
    passwordRevokedAt: null,
    passwordSetAt: new Date(),
  };
  const payers = {
    createOrGet: vi.fn(async () => ({ id: PAYER_ID, created: true })),
    findByEmail: vi.fn(async (): Promise<Record<string, unknown> | undefined> => account),
    findByPhone: vi.fn(async (): Promise<Record<string, unknown>[]> => []),
    findByOrgName: vi.fn(async (): Promise<Record<string, unknown>[]> => []),
    setPassword: vi.fn(async () => ({})),
    replaceTemporaryPassword: vi.fn(
      async (): Promise<Record<string, unknown> | undefined> => ({}),
    ),
    setTemporaryPassword: vi.fn(async () => ({})),
    revokePassword: vi.fn(async () => ({})),
    recordLogin: vi.fn(async () => undefined),
    withTransaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work({})),
    ensureOrgLookupHash: vi.fn(async () => undefined),
    clearOrgLookupHash: vi.fn(async () => undefined),
    findById: vi.fn(async (): Promise<Record<string, unknown> | undefined> => account),
    // ADR-0037 — first successful verify promotes pending → active. Default: the account
    // is already active in this fixture, so the guarded update moves no row (undefined)
    // and no `payer.activated` event fires. Tests that exercise activation override this.
    activate: vi.fn(async () => undefined),
    decryptContact: vi.fn(() => ({
      id: PAYER_ID,
      role: "employer",
      status: "active",
      email: EMAIL,
      phone: PHONE,
    })),
  };
  const otp = {
    // Real-only: PayerOtpIssued is { resendInSeconds } — the code is delivered to the payer's
    // email by the channel and is NEVER echoed back to the auth service.
    issueAndSend: vi.fn(async () => ({ resendInSeconds: 30 })),
    issueWithoutDelivery: vi.fn(async () => ({ resendInSeconds: 30 })),
    verify: vi.fn(async () => undefined),
  };
  const orgs = {
    ensureSoloOrg: vi.fn(async () => ({ orgId: "org-1", orgRole: "owner" })),
    // #2563 — the lazy company-name hash backfill runs only for an org ROOT.
    isRootPayer: vi.fn(async () => true),
    // #2563 follow-up — a payer who ever held another org's membership never gets the backfill.
    hasEverBeenMemberOfOtherOrg: vi.fn(async () => false),
  };
  // ADR-0053 — the acting-org choice. `resolveActingOrg` serves refresh (no heal); login asks
  // `ensureActingOrg`, the ONE place a missing org is repaired (the real heal is exercised by
  // the "heals a missing org ONCE" suite below, over the real resolver). Default: an existing org.
  const tenancy = {
    resolveActingOrg: vi.fn(async () => ({ orgId: "org-1", orgRole: "owner" })),
    ensureActingOrg: vi.fn(async () => ({ orgId: "org-1", orgRole: "owner" })),
  };
  const sessions = {
    create: vi.fn(async () => ({ token: "jwt-token", sid: "sid-jwt", expiresInSeconds: 2592000 })),
    mint: vi.fn(async () => ({ token: "fresh-jwt", expiresInSeconds: 2592000 })),
    revoke: vi.fn(async () => undefined),
    revokeAllForPayer: vi.fn(async () => 0),
    revokeAllForPayerExcept: vi.fn(async () => 0),
  };
  const events = {
    emit: vi.fn(
      (_evt: { event_name: string; payload: Record<string, unknown> }): Promise<void> =>
        Promise.resolve(),
    ),
  };
  const pii = {
    hmac: (v: string) => `hmac<${v}>`,
    hashPhone: (v: string) => `phone<${v}>`,
    hashOrgName: (v: string) => `org<${v}>`,
    hashPassword: (v: string) => pwHashFor(v),
    verifyPassword: (v: string, t: string) => t === pwHashFor(v),
  };
  const freeTier = { grantQuietly: vi.fn().mockResolvedValue(undefined) };
  const notice = { notify: vi.fn(async () => undefined) };
  // Per-account password-attempt lockout (Redis). Defaults: no lockout recorded.
  const redis = {
    incr: vi.fn(async () => 1),
    expire: vi.fn(async () => 1),
    get: vi.fn(async () => null as string | null),
    del: vi.fn(async () => 1),
  };
  const queue = { client: redis };

  const svc = new PayerAuthService(
    config,
    payers as never,
    orgs as never,
    otp as never,
    sessions as never,
    events as never,
    pii as never,
    // ADR-0036 §8 — the free-tier grant. `grantQuietly` is contractually never-throwing.
    freeTier as never,
    tenancy as never,
    queue as never,
    notice as never,
  );
  return { svc, payers, orgs, tenancy, otp, sessions, events, freeTier, queue, redis, pii, notice };
}

/** Every string the raw contact PII could be — must NEVER appear in an emitted event. */
function assertNoPiiInEvents(events: { emit: ReturnType<typeof vi.fn> }) {
  const blob = JSON.stringify(events.emit.mock.calls);
  for (const pii of [EMAIL, ORG, PHONE]) expect(blob).not.toContain(pii);
}

describe("PayerAuthService.signup", () => {
  let d: ReturnType<typeof setup>;
  beforeEach(() => {
    d = setup();
  });

  it("creates a NEW account, emits a PII-free payer.created, and issues a code", async () => {
    const res = await d.svc.signup(
      { role: "employer", email: EMAIL, org_name: ORG, phone: PHONE },
      CTX,
    );
    expect(d.payers.createOrGet).toHaveBeenCalledWith({
      role: "employer",
      email: EMAIL,
      orgName: ORG,
      phone: PHONE,
    });

    const created = d.events.emit.mock.calls.find((c) => c[0].event_name === "payer.created");
    expect(created).toBeDefined();
    expect(created![0].payload).toEqual({
      payer_id: PAYER_ID,
      role: "employer",
      method: "email_otp",
    });
    expect(d.otp.issueAndSend).toHaveBeenCalledTimes(1);
    // Real-only: the response is the neutral { status, resend_in_seconds } only — no dev_otp echo.
    expect(res).toEqual({ status: "code_sent", resend_in_seconds: 30 });
    // B5: a new payer founds a solo org with themselves as owner.
    expect(d.orgs.ensureSoloOrg).toHaveBeenCalledWith(PAYER_ID);
    assertNoPiiInEvents(d.events);
  });

  it("an EXISTING email does NOT emit payer.created (no overwrite) but returns the IDENTICAL response (XB-H)", async () => {
    d.payers.createOrGet.mockResolvedValueOnce({ id: PAYER_ID, created: false });
    const res = await d.svc.signup(
      { role: "employer", email: EMAIL, org_name: ORG, phone: PHONE },
      CTX,
    );
    expect(
      d.events.emit.mock.calls.find((c) => c[0].event_name === "payer.created"),
    ).toBeUndefined();
    // B5: an existing account is NEVER mutated on the signup path — no org ensure either.
    expect(d.orgs.ensureSoloOrg).not.toHaveBeenCalled();
    expect(res).toMatchObject({ status: "code_sent" }); // same neutral shape as a new signup
  });
});

describe("PayerAuthService.testLogin (Phase 2.1 seam)", () => {
  let d: ReturnType<typeof setup>;
  beforeEach(() => {
    d = setup();
  });

  // The drift this suite exists to prevent (#902): `testLogin`'s JSDoc used to claim it ran
  // "the ordinary account path ... + the free-tier grant". It never has. Locking the ABSENCE is
  // the only thing that stops the doc — or an e2e assertion trusting it — drifting back.
  it("does NOT grant free-tier credits — a test-minted payer starts with zero unlock credits", async () => {
    await d.svc.testLogin(SYNTHETIC_EMAIL, CTX);
    expect(d.freeTier.grantQuietly).not.toHaveBeenCalled();
  });

  // Contrast, so the assertion above can never pass vacuously (e.g. a renamed/unwired mock):
  // the SAME fixture does grant on the signup path.
  it("...while signup on the same fixture DOES grant — the mock is wired", async () => {
    await d.svc.signup({ role: "employer", email: EMAIL, org_name: ORG, phone: PHONE }, CTX);
    expect(d.freeTier.grantQuietly).toHaveBeenCalledWith(PAYER_ID);
  });

  it("mints a session for a synthetic address, force-activates, and emits payer.test_login (not session_started)", async () => {
    const res = await d.svc.testLogin(SYNTHETIC_EMAIL, CTX);
    // Force-activated: without this PayerAuthGuard 403s the very next request.
    expect(d.payers.activate).toHaveBeenCalledWith(PAYER_ID);
    expect(res).toMatchObject({
      access_token: "jwt-token",
      payer_id: PAYER_ID,
      role: "employer",
      is_new_payer: true,
    });

    const names = d.events.emit.mock.calls.map((c) => c[0].event_name);
    expect(names).toContain("payer.test_login");
    // A synthetic session must never be indistinguishable from a real login on the spine.
    expect(names).not.toContain("payer.session_started");
    assertNoPiiInEvents(d.events);
    // #2079: the test session carries the org claim exactly like a real login.
    expect(d.sessions.create).toHaveBeenCalledWith(PAYER_ID, "employer", {
      orgId: "org-1",
      orgRole: "owner",
    });
  });

  it("refuses an address OUTSIDE the reserved .invalid domain with the guard's neutral 404 — no account touched", async () => {
    await expect(d.svc.testLogin(EMAIL, CTX)).rejects.toBeInstanceOf(NotFoundException);
    expect(d.payers.createOrGet).not.toHaveBeenCalled();
    expect(d.sessions.create).not.toHaveBeenCalled();
    expect(d.events.emit).not.toHaveBeenCalled();
  });
});

describe("PayerAuthService.requestLogin (no user-enumeration)", () => {
  it("a KNOWN email issues+delivers a code and emits payer.login_requested (PII-free)", async () => {
    const d = setup();
    const res = await d.svc.requestLogin({ email: EMAIL }, CTX);
    expect(d.otp.issueAndSend).toHaveBeenCalledTimes(1);
    expect(d.otp.issueWithoutDelivery).not.toHaveBeenCalled();
    const reqEvt = d.events.emit.mock.calls.find(
      (c) => c[0].event_name === "payer.login_requested",
    );
    expect(reqEvt![0].payload).toEqual({ payer_id: PAYER_ID, method: "email_otp" });
    expect(res).toMatchObject({ status: "code_sent" });
    assertNoPiiInEvents(d.events);
  });

  it("an UNKNOWN email runs the no-delivery reserve, emits NOTHING, and returns the SAME shape", async () => {
    const d = setup();
    d.payers.findByEmail.mockResolvedValueOnce(undefined);
    const res = await d.svc.requestLogin({ email: "ghost@nowhere.com" }, CTX);
    expect(d.otp.issueWithoutDelivery).toHaveBeenCalledTimes(1);
    expect(d.otp.issueAndSend).not.toHaveBeenCalled();
    expect(d.events.emit).not.toHaveBeenCalled(); // no subject → no event (not observable)
    expect(res).toMatchObject({ status: "code_sent", resend_in_seconds: 30 }); // identical to known
  });

  it("a delivery failure for a KNOWN account is swallowed to the neutral response (no oracle)", async () => {
    const d = setup();
    d.otp.issueAndSend.mockRejectedValueOnce(
      new HttpException("send failed", HttpStatus.BAD_GATEWAY),
    );
    const res = await d.svc.requestLogin({ email: EMAIL }, CTX);
    expect(res).toMatchObject({ status: "code_sent" }); // 502 neutralized
  });

  it("a 429 (cooldown/cap) PROPAGATES (existence-independent — same in both branches)", async () => {
    const d = setup();
    d.otp.issueAndSend.mockRejectedValueOnce(
      new HttpException("too many", HttpStatus.TOO_MANY_REQUESTS),
    );
    await expect(d.svc.requestLogin({ email: EMAIL }, CTX)).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });
  });
});

describe("PayerAuthService global send-cap breach (OTP-5 — PII-free event + no-enumeration parity)", () => {
  const breach = () =>
    new OtpSendCapExceededException({ channel: "payer_email", limit: 2000, window: "20260626" });

  it("requestLogin (KNOWN) on a breach emits exactly one PII-free payer.otp_send_cap_exceeded and degrades to the neutral code_sent", async () => {
    const d = setup();
    d.otp.issueAndSend.mockRejectedValueOnce(breach());
    const res = await d.svc.requestLogin({ email: EMAIL }, CTX);

    // Degrades to the SAME neutral response the unknown-account path returns (no 429 leak).
    expect(res).toEqual({ status: "code_sent", resend_in_seconds: 30 });
    const capEvts = d.events.emit.mock.calls.filter(
      (c) => c[0].event_name === "payer.otp_send_cap_exceeded",
    );
    expect(capEvts).toHaveLength(1); // exactly once
    expect(capEvts[0]![0].payload).toEqual({
      channel: "payer_email",
      cap: "global_daily",
      limit: 2000,
      window: "20260626",
    });
    assertNoPiiInEvents(d.events);
    // It validates against the schema.
    const built = validateEvent({
      event_id: "11111111-1111-4111-8111-111111111111",
      event_name: "payer.otp_send_cap_exceeded",
      event_version: 1,
      occurred_at: "2026-06-26T00:00:00.000Z",
      actor: { actor_type: "system" },
      subject: { subject_type: "payer", subject_id: null },
      source: "api",
      correlation_id: "22222222-2222-4222-8222-222222222222",
      causation_id: null,
      payload: capEvts[0]![0].payload,
      metadata: { environment: "test", service: "api" },
    });
    expect(built.success).toBe(true);
  });

  it("NO-ENUMERATION: the breach response for a KNOWN account == the response for an UNKNOWN account (byte-identical)", async () => {
    // KNOWN account → issueAndSend trips the breaker.
    const known = setup();
    known.otp.issueAndSend.mockRejectedValueOnce(breach());
    const knownRes = await known.svc.requestLogin({ email: EMAIL }, CTX);

    // UNKNOWN account → the existence-independent issueWithoutDelivery trips the SAME breaker.
    const unknown = setup();
    unknown.payers.findByEmail.mockResolvedValueOnce(undefined);
    unknown.otp.issueWithoutDelivery.mockRejectedValueOnce(breach());
    const unknownRes = await unknown.svc.requestLogin({ email: "ghost@nowhere.com" }, CTX);

    // Byte-identical body — a caller cannot tell whether the account exists.
    expect(knownRes).toEqual(unknownRes);
    expect(knownRes).toEqual({ status: "code_sent", resend_in_seconds: 30 });
  });

  it("signup on a breach also degrades to the neutral code_sent (account already created)", async () => {
    const d = setup();
    d.otp.issueAndSend.mockRejectedValueOnce(breach());
    const res = await d.svc.signup(
      { role: "employer", email: EMAIL, org_name: ORG, phone: PHONE },
      CTX,
    );
    expect(res).toEqual({ status: "code_sent", resend_in_seconds: 30 });
    // payer.created still fired (account creation precedes the code issue); the breach event fired too.
    const names = d.events.emit.mock.calls.map((c) => c[0].event_name);
    expect(names).toContain("payer.created");
    expect(names.filter((n) => n === "payer.otp_send_cap_exceeded")).toHaveLength(1);
    assertNoPiiInEvents(d.events);
  });

  it("a NON-cap error (e.g. 503 Redis) still PROPAGATES — only the cap breach is neutralized", async () => {
    const d = setup();
    d.otp.issueAndSend.mockRejectedValueOnce(
      new HttpException("temporarily unavailable", HttpStatus.SERVICE_UNAVAILABLE),
    );
    await expect(d.svc.requestLogin({ email: EMAIL }, CTX)).rejects.toMatchObject({
      status: HttpStatus.SERVICE_UNAVAILABLE,
    });
  });
});

describe("PayerAuthService.verifyLogin", () => {
  it("verifies the code, mints a session, and emits a PII-free payer.session_started", async () => {
    const d = setup();
    const res = await d.svc.verifyLogin({ email: EMAIL, code: "123456" }, CTX);
    expect(d.otp.verify).toHaveBeenCalledWith(`hmac<${EMAIL}>`, "123456");
    // ADR-0022: the account role is carried onto the session so PayerRoleGuard gates without a DB hit.
    // #2079: the CURRENT membership rides the session as the org_id/org_role claim.
    expect(d.sessions.create).toHaveBeenCalledWith(PAYER_ID, "employer", {
      orgId: "org-1",
      orgRole: "owner",
    });
    const evt = d.events.emit.mock.calls.find((c) => c[0].event_name === "payer.session_started");
    expect(evt![0].payload).toEqual({
      payer_id: PAYER_ID,
      method: "email_otp",
      is_new_payer: false,
    });
    expect(res).toMatchObject({
      access_token: "jwt-token",
      token_type: "Bearer",
      payer_id: PAYER_ID,
      role: "employer",
    });
    assertNoPiiInEvents(d.events);
  });

  it("a verified code for an UNKNOWN account does NOT mint a session — returns the SAME 401 (no oracle)", async () => {
    const d = setup();
    d.payers.findByEmail.mockResolvedValueOnce(undefined); // reserved code, no account
    await expect(
      d.svc.verifyLogin({ email: "ghost@nowhere.com", code: "999999" }, CTX),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(d.sessions.create).not.toHaveBeenCalled();
    expect(d.events.emit).not.toHaveBeenCalled();
  });

  it("login asks the resolver's HEALING entry point, and never repairs the org itself", async () => {
    const d = setup(); // ensureActingOrg defaults to an existing org
    await d.svc.verifyLogin({ email: EMAIL, code: "123456" }, CTX);
    expect(d.tenancy.ensureActingOrg).toHaveBeenCalledExactlyOnceWith(PAYER_ID);
    expect(d.orgs.ensureSoloOrg).not.toHaveBeenCalled();
  });

  it("a gap payer (B5.1→B5.2) gets the org the healing entry point returns", async () => {
    const d = setup();
    d.tenancy.ensureActingOrg.mockResolvedValueOnce({
      orgId: "org-healed",
      orgRole: "owner",
    } as never);
    await d.svc.verifyLogin({ email: EMAIL, code: "123456" }, CTX);
    // Still mints the session normally — carrying the freshly-ensured solo-org OWNER claim.
    expect(d.sessions.create).toHaveBeenCalledWith(PAYER_ID, "employer", {
      orgId: "org-healed",
      orgRole: "owner",
    });
  });

  it("no org even after the repair → the session carries NO org claim (least privilege)", async () => {
    const d = setup();
    d.tenancy.ensureActingOrg.mockResolvedValueOnce(null as never);
    await d.svc.verifyLogin({ email: EMAIL, code: "123456" }, CTX);
    expect(d.sessions.create).toHaveBeenCalledWith(PAYER_ID, "employer", undefined);
  });

  it("#2079: a RECRUITER member's session carries org_role 'recruiter' (decided server-side)", async () => {
    const d = setup();
    d.tenancy.ensureActingOrg.mockResolvedValueOnce({
      orgId: "org-9",
      orgRole: "recruiter",
    } as never);
    await d.svc.verifyLogin({ email: EMAIL, code: "123456" }, CTX);
    expect(d.sessions.create).toHaveBeenCalledWith(PAYER_ID, "employer", {
      orgId: "org-9",
      orgRole: "recruiter",
    });
    expect(d.orgs.ensureSoloOrg).not.toHaveBeenCalled();
  });
});

describe("PayerAuthService.signup/request/verify with phone (#2497)", () => {
  it("signup with PHONE ONLY creates keyed on the phone hash and issues via the phone-keyed reserve", async () => {
    const d = setup();
    const res = await d.svc.signup({ role: "employer", org_name: ORG, phone: PHONE }, CTX);
    expect(d.payers.createOrGet).toHaveBeenCalledWith({
      role: "employer",
      email: undefined,
      orgName: ORG,
      phone: PHONE,
    });
    // The OTP reserve/store is keyed on the phone hash (never the email hash, never raw).
    expect(d.otp.issueAndSend).toHaveBeenCalledWith(
      expect.objectContaining({ emailHash: `phone<${PHONE}>`, payerId: PAYER_ID }),
    );
    expect(res).toEqual({ status: "code_sent", resend_in_seconds: 30 });
    assertNoPiiInEvents(d.events);
  });

  it("login/request by phone looks the account up by phone hash (not email)", async () => {
    const d = setup();
    d.payers.findByPhone.mockResolvedValueOnce([{ id: PAYER_ID }]);
    await d.svc.requestLogin({ phone: PHONE }, CTX);
    expect(d.payers.findByPhone).toHaveBeenCalledWith(PHONE);
    expect(d.payers.findByEmail).not.toHaveBeenCalled();
    expect(d.otp.issueAndSend).toHaveBeenCalledWith(
      expect.objectContaining({ emailHash: `phone<${PHONE}>` }),
    );
  });

  it("login/verify by phone verifies the phone-keyed code", async () => {
    const d = setup();
    d.payers.findByPhone.mockResolvedValueOnce([
      { id: PAYER_ID, role: "employer", status: "active" },
    ]);
    await d.svc.verifyLogin({ phone: PHONE, code: "123456" }, CTX);
    expect(d.otp.verify).toHaveBeenCalledWith(`phone<${PHONE}>`, "123456");
  });

  it("email wins when BOTH contacts are supplied (deterministic OTP key)", async () => {
    const d = setup();
    await d.svc.requestLogin({ email: EMAIL, phone: PHONE }, CTX);
    expect(d.payers.findByEmail).toHaveBeenCalledWith(EMAIL);
    expect(d.otp.issueWithoutDelivery).not.toHaveBeenCalled();
    expect(d.otp.issueAndSend).toHaveBeenCalledWith(
      expect.objectContaining({ emailHash: `hmac<${EMAIL}>` }),
    );
  });
});

describe("PayerAuthService.setPassword (#2497)", () => {
  it("stores the scrypt hash + pepper version, emits payer.password_set, and keeps the caller session", async () => {
    const d = setup();
    await d.svc.setPassword(PAYER_ID, "CorrectHorse9", "sid-1", CTX);
    expect(d.payers.setPassword).toHaveBeenCalledWith(
      PAYER_ID,
      {
        hash: pwHashFor("CorrectHorse9"),
        pepperVersion: 1,
      },
      { tx: {} },
    );
    expect(d.events.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        event_name: "payer.password_set",
        payload: { payer_id: PAYER_ID },
      }),
    );
    // #2563: the caller stays signed in; only the OTHER sessions end.
    expect(d.sessions.revokeAllForPayerExcept).toHaveBeenCalledWith(PAYER_ID, "sid-1");
    expect(d.notice.notify).toHaveBeenCalledWith(PAYER_ID, "changed");
    const blob = JSON.stringify([d.payers.setPassword.mock.calls, d.events.emit.mock.calls]);
    expect(blob).not.toContain("CorrectHorse9");
  });
});

describe("PayerAuthService.loginWithPassword (#2497)", () => {
  const PW = "CorrectHorse9";
  /** An active account WITH a versioned password hash and a filled org lookup hash. */
  const pwAccount = (over: Record<string, unknown> = {}) => ({
    id: PAYER_ID,
    role: "employer",
    status: "active",
    orgNameLookupHash: "org<acme manufacturing pvt ltd>",
    passwordHash: pwHashFor(PW),
    passwordPepperVersion: 1,
    mustChangePassword: false,
    passwordRevokedAt: null,
    passwordSetAt: new Date(),
    ...over,
  });

  it("email login: verifies, clears attempts, mints a session, emits session_started with method password", async () => {
    const d = setup();
    d.payers.findByEmail.mockResolvedValueOnce(pwAccount());
    const res = await d.svc.loginWithPassword(EMAIL, PW, CTX);
    expect(d.payers.findByEmail).toHaveBeenCalledWith(EMAIL);
    // Success clears the failure counter.
    expect(d.redis.del).toHaveBeenCalledWith(`payer_pw:attempts:${PAYER_ID}`);
    expect(d.sessions.create).toHaveBeenCalledWith(PAYER_ID, "employer", {
      orgId: "org-1",
      orgRole: "owner",
    });
    const evt = d.events.emit.mock.calls.find((c) => c[0].event_name === "payer.session_started");
    expect(evt![0].payload).toEqual({
      payer_id: PAYER_ID,
      method: "password",
      is_new_payer: false,
    });
    expect(res).toMatchObject({ payer_id: PAYER_ID, role: "employer", is_new_payer: false });
    const blob = JSON.stringify(d.events.emit.mock.calls);
    expect(blob).not.toContain(PW);
    expect(blob).not.toContain(EMAIL);
  });

  it("phone login resolves by phone hash (and email is never consulted)", async () => {
    const d = setup();
    d.payers.findByPhone.mockResolvedValueOnce([pwAccount()]);
    const res = await d.svc.loginWithPassword(PHONE, PW, CTX);
    expect(d.payers.findByPhone).toHaveBeenCalledWith(PHONE);
    expect(d.payers.findByEmail).not.toHaveBeenCalled();
    expect((res as { payer_id?: string }).payer_id).toBe(PAYER_ID);
  });

  it("org-name login is trimmed + case-insensitive, and requires EXACTLY one match", async () => {
    const d = setup();
    d.payers.findByOrgName.mockResolvedValueOnce([pwAccount()]);
    await d.svc.loginWithPassword("  ACME Manufacturing Pvt Ltd ", PW, CTX);
    // Trimmed, original case preserved for the repository's own normalization + keyed hash —
    // the raw casing never reaches a lookup (and over-long input never reaches the DB).
    expect(d.payers.findByOrgName).toHaveBeenCalledWith("ACME Manufacturing Pvt Ltd");
    expect(d.sessions.create).toHaveBeenCalledTimes(1);
  });

  it("an over-long identifier never reaches the org lookup (no HMAC on attacker-width input)", async () => {
    const d = setup();
    await expect(d.svc.loginWithPassword("x".repeat(250), PW, CTX)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(d.payers.findByEmail).not.toHaveBeenCalled();
    expect(d.payers.findByPhone).not.toHaveBeenCalled();
    expect(d.payers.findByOrgName).not.toHaveBeenCalled();
  });

  it.each([
    ["unknown identifier", "ghost@nowhere.example"],
    ["unknown phone", "+919800000000"],
    ["unknown org name", "No Such Company"],
    ["colliding org name (2 matches)", "Sharma Trading"],
    ["garbage identifier", "!!!"],
  ])("%s → the SAME neutral 401, no session, no event", async (_, identifier) => {
    const d = setup();
    // Default mocks resolve an account for any EMAIL (existing-suite fixture) — the unknown
    // cases must explicitly resolve nothing; phone/org default to empty already.
    if (identifier === "Sharma Trading") {
      d.payers.findByOrgName.mockResolvedValueOnce([pwAccount(), pwAccount()]);
    } else if (identifier.includes("@")) {
      d.payers.findByEmail.mockResolvedValueOnce(undefined);
    }
    await expect(d.svc.loginWithPassword(identifier, PW, CTX)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(d.sessions.create).not.toHaveBeenCalled();
    expect(d.events.emit).not.toHaveBeenCalled();
  });

  it("a wrong password burns a full KDF, records the attempt, and stays neutral 401", async () => {
    const d = setup();
    d.payers.findByEmail.mockResolvedValueOnce(pwAccount());
    await expect(d.svc.loginWithPassword(EMAIL, "Wrongpass1", CTX)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(d.redis.incr).toHaveBeenCalledWith(`payer_pw:attempts:${PAYER_ID}`);
    // First failure arms the TTL = the lockout window.
    expect(d.redis.expire).toHaveBeenCalledWith(`payer_pw:attempts:${PAYER_ID}`, 900);
    expect(d.sessions.create).not.toHaveBeenCalled();
  });

  it("an OTP-only account (no hash) is a neutral 401 — and still counts the attempt", async () => {
    const d = setup();
    d.payers.findByEmail.mockResolvedValueOnce(
      pwAccount({ passwordHash: null, passwordPepperVersion: null }) as never,
    );
    await expect(d.svc.loginWithPassword(EMAIL, PW, CTX)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(d.redis.incr).toHaveBeenCalledTimes(1);
  });

  it("a stale pepper version fails closed (no verify against the old token)", async () => {
    const d = setup();
    d.payers.findByEmail.mockResolvedValueOnce(pwAccount({ passwordPepperVersion: 0 }) as never);
    await expect(d.svc.loginWithPassword(EMAIL, PW, CTX)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it("a locked-out account answers the SAME neutral 401 without touching the real hash", async () => {
    const d = setup();
    d.payers.findByEmail.mockResolvedValueOnce(pwAccount());
    d.redis.get.mockResolvedValueOnce("5");
    await expect(d.svc.loginWithPassword(EMAIL, PW, CTX)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    // No second attempt recorded while locked (would extend/refresh nothing useful).
    expect(d.redis.incr).not.toHaveBeenCalled();
    expect(d.sessions.create).not.toHaveBeenCalled();
  });

  it("a SUSPENDED account with the RIGHT password gets the distinct 403 (proven credential, no oracle)", async () => {
    const d = setup();
    d.payers.findByEmail.mockResolvedValueOnce(pwAccount({ status: "suspended" }));
    await expect(d.svc.loginWithPassword(EMAIL, PW, CTX)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(d.sessions.create).not.toHaveBeenCalled();
  });

  it("a PENDING account never promotes on password alone — neutral 401, no activation event", async () => {
    const d = setup();
    d.payers.findByEmail.mockResolvedValueOnce(pwAccount({ status: "pending" }));
    await expect(d.svc.loginWithPassword(EMAIL, PW, CTX)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(d.sessions.create).not.toHaveBeenCalled();
    expect(
      d.events.emit.mock.calls.find((c) => c[0].event_name === "payer.activated"),
    ).toBeUndefined();
  });

  it("lazily fills a missing org lookup hash on success (and never fails the login on it)", async () => {
    const d = setup();
    d.payers.findByEmail.mockResolvedValueOnce(pwAccount({ orgNameLookupHash: null }));
    await d.svc.loginWithPassword(EMAIL, PW, CTX);
    expect(d.payers.ensureOrgLookupHash).toHaveBeenCalledTimes(1);
    expect(d.sessions.create).toHaveBeenCalledTimes(1);
  });

  it("skips the org-hash fill when the row already has one", async () => {
    const d = setup();
    d.payers.findByEmail.mockResolvedValueOnce(pwAccount());
    await d.svc.loginWithPassword(EMAIL, PW, CTX);
    expect(d.payers.ensureOrgLookupHash).not.toHaveBeenCalled();
  });

  it("a Redis outage LOCKS the login out (fail-closed 503) rather than uncapping it", async () => {
    const failing = setup();
    failing.redis.get.mockRejectedValueOnce(new Error("redis down"));
    await expect(failing.svc.loginWithPassword(EMAIL, PW, CTX)).rejects.toMatchObject({
      status: 503,
    });
    const counting = setup();
    counting.payers.findByEmail.mockResolvedValueOnce(pwAccount());
    counting.redis.incr.mockRejectedValueOnce(new Error("redis down"));
    await expect(counting.svc.loginWithPassword(EMAIL, "Wrongpass1", CTX)).rejects.toMatchObject({
      status: 503,
    });
  });

  it("no password, identifier, or org name ever reaches an event or a log line", async () => {
    const d = setup();
    d.payers.findByEmail.mockResolvedValueOnce(pwAccount());
    await d.svc.loginWithPassword(EMAIL, PW, CTX).catch(() => undefined);
    await d.svc.loginWithPassword(EMAIL, "Wrongpass1", CTX).catch(() => undefined);
    const blob = JSON.stringify(d.events.emit.mock.calls);
    for (const secret of [PW, "Wrongpass1", EMAIL, "Acme"]) {
      expect(blob).not.toContain(secret);
    }
  });
});

describe("PayerAuthService — #2563 forced change, revoke and last sign-in", () => {
  const PW = "CorrectHorse9";
  const NEW_PW = "BrandNewPass7";
  const pwAccount = (over: Record<string, unknown> = {}) => ({
    id: PAYER_ID,
    role: "employer",
    status: "active",
    orgNameLookupHash: "org<acme manufacturing pvt ltd>",
    passwordHash: pwHashFor(PW),
    passwordPepperVersion: 1,
    mustChangePassword: false,
    passwordRevokedAt: null,
    passwordSetAt: new Date(),
    ...over,
  });

  it("a temporary password without new_password returns password_change_required and NO session", async () => {
    const d = setup();
    d.payers.findByEmail.mockResolvedValueOnce(pwAccount({ mustChangePassword: true }));

    await expect(d.svc.loginWithPassword(EMAIL, PW, CTX)).resolves.toEqual({
      status: "password_change_required",
    });
    expect(d.sessions.create).not.toHaveBeenCalled();
    expect(d.payers.recordLogin).not.toHaveBeenCalled();
    expect(d.events.emit).not.toHaveBeenCalledWith(
      expect.objectContaining({ event_name: "payer.session_started" }),
    );
  });

  it("a temporary password PLUS a policy-valid new_password stores the new one, emits password_set and mints a session", async () => {
    const d = setup();
    d.payers.findByEmail.mockResolvedValueOnce(pwAccount({ mustChangePassword: true }));

    const res = await d.svc.loginWithPassword(EMAIL, PW, CTX, NEW_PW);

    expect(res).toMatchObject({ payer_id: PAYER_ID, role: "employer" });
    expect(d.payers.replaceTemporaryPassword).toHaveBeenCalledWith(
      PAYER_ID,
      { hash: pwHashFor(NEW_PW), pepperVersion: 1 },
      pwHashFor(PW),
      {},
    );
    expect(d.events.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        event_name: "payer.password_set",
        payload: { payer_id: PAYER_ID },
      }),
    );
    // No caller session exists yet: every earlier session must end.
    expect(d.sessions.revokeAllForPayer).toHaveBeenCalledWith(PAYER_ID);
    expect(d.sessions.create).toHaveBeenCalledTimes(1);
    expect(d.payers.recordLogin).toHaveBeenCalledWith(PAYER_ID);
    // Review fix 5 — the payer is emailed that the password changed.
    expect(d.notice.notify).toHaveBeenCalledWith(PAYER_ID, "changed");
  });

  it("a temporary password is valid just BEFORE the 7-day TTL", async () => {
    const d = setup();
    d.payers.findByEmail.mockResolvedValueOnce(
      pwAccount({
        mustChangePassword: true,
        passwordSetAt: new Date(Date.now() - (168 * 3600_000 - 60_000)),
      }),
    );
    await expect(d.svc.loginWithPassword(EMAIL, PW, CTX)).resolves.toEqual({
      status: "password_change_required",
    });
  });

  it("a temporary password is a neutral 401 just AFTER the 7-day TTL", async () => {
    const d = setup();
    d.payers.findByEmail.mockResolvedValueOnce(
      pwAccount({
        mustChangePassword: true,
        passwordSetAt: new Date(Date.now() - (168 * 3600_000 + 60_000)),
      }),
    );
    await expect(d.svc.loginWithPassword(EMAIL, PW, CTX)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(d.sessions.create).not.toHaveBeenCalled();
  });

  it("two concurrent forced-change requests: exactly one wins", async () => {
    const d = setup();
    d.payers.findByEmail.mockResolvedValue(pwAccount({ mustChangePassword: true }));
    d.payers.replaceTemporaryPassword
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(undefined);

    const results = await Promise.allSettled([
      d.svc.loginWithPassword(EMAIL, PW, CTX, NEW_PW),
      d.svc.loginWithPassword(EMAIL, PW, CTX, NEW_PW),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(UnauthorizedException);
    expect(d.sessions.create).toHaveBeenCalledTimes(1);
  });

  it("revokes the just-minted session when the password is revoked concurrently", async () => {
    const d = setup();
    d.payers.findByEmail.mockResolvedValueOnce(pwAccount());
    d.payers.findById.mockResolvedValueOnce(
      pwAccount({ passwordRevokedAt: new Date(Date.now() + 1000) }),
    );
    d.sessions.create.mockResolvedValueOnce({
      token: "racing-jwt",
      sid: "racing-sid",
      expiresInSeconds: 2592000,
    });

    await expect(d.svc.loginWithPassword(EMAIL, PW, CTX)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(d.sessions.revoke).toHaveBeenCalledWith("racing-sid", PAYER_ID);
    expect(d.payers.recordLogin).not.toHaveBeenCalled();
  });

  it("sends the forced-change notice even when the session sweep throws", async () => {
    const d = setup();
    d.payers.findByEmail.mockResolvedValueOnce(pwAccount({ mustChangePassword: true }));
    d.sessions.revokeAllForPayer.mockRejectedValueOnce(new Error("redis down"));

    await expect(d.svc.loginWithPassword(EMAIL, PW, CTX, NEW_PW)).rejects.toThrow("redis down");
    expect(d.notice.notify).toHaveBeenCalledWith(PAYER_ID, "changed");
  });

  it("never writes the founder's company-name hash onto a team-member row", async () => {
    const d = setup();
    d.orgs.isRootPayer.mockResolvedValueOnce(false);
    d.payers.findByEmail.mockResolvedValueOnce(pwAccount({ orgNameLookupHash: null }));

    await d.svc.loginWithPassword(EMAIL, PW, CTX);

    expect(d.orgs.isRootPayer).toHaveBeenCalledWith(PAYER_ID);
    expect(d.payers.ensureOrgLookupHash).not.toHaveBeenCalled();

    // ...and the ROOT still gets the lazy backfill.
    const root = setup();
    root.orgs.isRootPayer.mockResolvedValueOnce(true);
    root.payers.findByEmail.mockResolvedValueOnce(pwAccount({ orgNameLookupHash: null }));
    await root.svc.loginWithPassword(EMAIL, PW, CTX);
    expect(root.payers.ensureOrgLookupHash).toHaveBeenCalledTimes(1);
  });

  it("clears a stale founder hash for a payer who ever held another org membership", async () => {
    const d = setup();
    d.orgs.hasEverBeenMemberOfOtherOrg.mockResolvedValueOnce(true);
    d.payers.findByEmail.mockResolvedValueOnce(
      pwAccount({ orgNameLookupHash: "stale-founder-hash" }),
    );

    await d.svc.loginWithPassword(EMAIL, PW, CTX);

    expect(d.payers.ensureOrgLookupHash).not.toHaveBeenCalled();
    expect(d.payers.clearOrgLookupHash).toHaveBeenCalledWith(PAYER_ID);
  });

  it("rejects a new_password equal to the temporary one", async () => {
    const d = setup();
    d.payers.findByEmail.mockResolvedValueOnce(pwAccount({ mustChangePassword: true }));

    await expect(d.svc.loginWithPassword(EMAIL, PW, CTX, PW)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(d.payers.replaceTemporaryPassword).not.toHaveBeenCalled();
    expect(d.sessions.create).not.toHaveBeenCalled();
  });

  it("a revoked password is a neutral 401 even when the old password is correct", async () => {
    const d = setup();
    d.payers.findByEmail.mockResolvedValueOnce(
      pwAccount({ passwordRevokedAt: new Date("2026-11-04T00:00:00Z") }),
    );

    await expect(d.svc.loginWithPassword(EMAIL, PW, CTX)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(d.sessions.create).not.toHaveBeenCalled();
  });

  it("OTP verify refuses a temporary-password account with 409 and no session", async () => {
    const d = setup();
    d.payers.findByEmail.mockResolvedValueOnce(pwAccount({ mustChangePassword: true }));

    await expect(
      d.svc.verifyLogin({ email: EMAIL, code: "123456" } as never, CTX),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(d.sessions.create).not.toHaveBeenCalled();
    expect(d.payers.recordLogin).not.toHaveBeenCalled();
  });

  it("stamps last_login_at on a successful OTP login and on a successful password login", async () => {
    const otp = setup();
    otp.payers.findByEmail.mockResolvedValueOnce(pwAccount());
    await otp.svc.verifyLogin({ email: EMAIL, code: "123456" } as never, CTX);
    expect(otp.payers.recordLogin).toHaveBeenCalledWith(PAYER_ID);

    const pw = setup();
    pw.payers.findByEmail.mockResolvedValueOnce(pwAccount());
    await pw.svc.loginWithPassword(EMAIL, PW, CTX);
    expect(pw.payers.recordLogin).toHaveBeenCalledWith(PAYER_ID);
  });

  it("the emitted payer.password_set payload validates against the registry", async () => {
    const d = setup();
    await d.svc.setPassword(PAYER_ID, NEW_PW, "sid-1", CTX);
    const emitted = d.events.emit.mock.calls.find(
      (c) => (c[0] as { event_name: string }).event_name === "payer.password_set",
    )![0] as { payload: Record<string, unknown> };

    const result = validateEvent({
      event_id: "66666666-6666-4666-8666-666666666666",
      event_name: "payer.password_set",
      event_version: 1,
      occurred_at: "2026-11-04T00:00:00.000Z",
      actor: { actor_type: "payer", actor_id: PAYER_ID },
      subject: { subject_type: "payer", subject_id: PAYER_ID },
      payload: emitted.payload,
      source: "api",
      correlation_id: CTX.correlationId,
      causation_id: null,
      metadata: { environment: "test", service: "api" },
      request_id: CTX.requestId,
    });
    expect(result.success).toBe(true);
  });
});

describe("login heals a missing org ONCE, through the resolver (ADR-0053 R4; review L1)", () => {
  /**
   * The REAL resolver over a fake membership read: login's org repair must have one entry point.
   * Before the fix, `on` healed inside the resolver AND again in the auth service (three
   * `ensureSoloOrg` calls when the repair could not produce a membership), and healed a payer
   * who HAS a membership but is denied (pointless: a heal cannot fix a denial).
   */
  function realResolver(mode: "off" | "on", reads: ActiveMembershipFacts[][]) {
    const queue = [...reads];
    const orgs = {
      listActiveMembershipsWithAnchor: vi.fn(async () =>
        queue.length > 1 ? queue.shift()! : queue[0]!,
      ),
      ensureSoloOrg: vi.fn(async () => null),
    };
    const tenancy = new PayerTenantScopeService(
      { PAYER_ORG_TENANCY_MODE: mode } as unknown as ServerConfig,
      orgs as unknown as PayerOrgsRepository,
    );
    return { orgs, tenancy };
  }

  function serviceWith(r: ReturnType<typeof realResolver>) {
    const d = setup();
    const svc = new PayerAuthService(
      {
        PAYER_LOGIN_METHOD: "email_otp",
        OTP_RESEND_COOLDOWN_SECONDS: 30,
        PAYER_TEMP_PASSWORD_TTL_HOURS: 168,
      } as unknown as ServerConfig,
      d.payers as never,
      r.orgs as never,
      d.otp as never,
      d.sessions as never,
      d.events as never,
      { hmac: (v: string) => `hmac<${v}>` } as never,
      d.freeTier as never,
      r.tenancy,
      d.queue as never,
      d.notice as never,
    );
    return { svc, d };
  }

  const solo = (over: Partial<ActiveMembershipFacts> = {}): ActiveMembershipFacts => ({
    orgId: "0aaaaaaa-0000-4000-8000-000000000001",
    orgRole: "owner",
    acceptedAt: new Date("2026-06-01T00:00:00.000Z"),
    orgStatus: "active",
    anchorPayerId: PAYER_ID,
    anchorRole: "employer",
    anchorStatus: "active",
    memberRole: "employer",
    ...over,
  });

  it.each<"off" | "on">(["off", "on"])(
    "%s: a payer the repair cannot fix is healed exactly once, then logs in without an org claim",
    async (mode) => {
      const r = realResolver(mode, [[]]);
      const { svc, d } = serviceWith(r);
      await svc.verifyLogin({ email: EMAIL, code: "123456" }, CTX);
      expect(r.orgs.ensureSoloOrg).toHaveBeenCalledTimes(1);
      expect(d.sessions.create).toHaveBeenCalledWith(PAYER_ID, "employer", undefined);
    },
  );

  it.each<"off" | "on">(["off", "on"])(
    "%s: a gap payer is healed once and gets the solo org",
    async (mode) => {
      const r = realResolver(mode, [[], [solo()]]);
      const { svc, d } = serviceWith(r);
      await svc.verifyLogin({ email: EMAIL, code: "123456" }, CTX);
      expect(r.orgs.ensureSoloOrg).toHaveBeenCalledTimes(1);
      expect(d.sessions.create).toHaveBeenCalledWith(PAYER_ID, "employer", {
        orgId: solo().orgId,
        orgRole: "owner",
      });
    },
  );

  it("on: a DENIED team member (suspended founder) is never 'healed' — a heal cannot fix a denial", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const team = solo({
      orgId: "0bbbbbbb-0000-4000-8000-000000000002",
      orgRole: "recruiter",
      anchorPayerId: "bbbbbbbb-0000-4000-8000-000000000002",
      anchorStatus: "suspended",
    });
    const r = realResolver("on", [[solo(), team]]);
    const { svc, d } = serviceWith(r);
    await svc.verifyLogin({ email: EMAIL, code: "123456" }, CTX);
    expect(r.orgs.ensureSoloOrg).not.toHaveBeenCalled();
    expect(d.sessions.create).toHaveBeenCalledWith(PAYER_ID, "employer", undefined);
  });
});

describe("PayerAuthService.refresh + logout", () => {
  it("refresh mints a fresh token for the validated payer+session", async () => {
    const d = setup();
    const res = await d.svc.refresh(PAYER_ID, "sid-1");
    // #2079: the org claim is RE-DECIDED from the current membership (not copied from the token).
    expect(d.tenancy.resolveActingOrg).toHaveBeenCalledWith(PAYER_ID);
    expect(d.sessions.mint).toHaveBeenCalledWith(PAYER_ID, "sid-1", undefined, {
      orgId: "org-1",
      orgRole: "owner",
    });
    expect(res).toMatchObject({ access_token: "fresh-jwt", token_type: "Bearer" });
  });

  it("#2079: refresh after a DEMOTION carries 'recruiter', not the old 'owner'", async () => {
    const d = setup();
    d.tenancy.resolveActingOrg.mockResolvedValueOnce({
      orgId: "org-1",
      orgRole: "recruiter",
    } as never);
    await d.svc.refresh(PAYER_ID, "sid-1");
    expect(d.sessions.mint).toHaveBeenCalledWith(PAYER_ID, "sid-1", undefined, {
      orgId: "org-1",
      orgRole: "recruiter",
    });
  });

  it("#2079: refresh for a REMOVED member (no membership) or a resolve error omits the claim", async () => {
    const d = setup();
    d.tenancy.resolveActingOrg.mockResolvedValueOnce(null as never);
    await d.svc.refresh(PAYER_ID, "sid-1");
    expect(d.sessions.mint).toHaveBeenLastCalledWith(PAYER_ID, "sid-1", undefined, undefined);

    d.tenancy.resolveActingOrg.mockRejectedValueOnce(new Error("pg blip"));
    await expect(d.svc.refresh(PAYER_ID, "sid-1")).resolves.toMatchObject({
      access_token: "fresh-jwt",
    });
    expect(d.sessions.mint).toHaveBeenLastCalledWith(PAYER_ID, "sid-1", undefined, undefined);
  });

  it("logout revokes the current session", async () => {
    const d = setup();
    await d.svc.logout("sid-1");
    expect(d.sessions.revoke).toHaveBeenCalledWith("sid-1");
  });
});

/**
 * ADR-0037 — the payer lifecycle at the verify seam.
 *
 * Before this, `payers.status` defaulted to `pending` and NOTHING ever promoted it: signup
 * never set it and verify never touched it, so every real payer sat at `pending` forever.
 * That is also why admin suspend 409'd for every payer — it required `active`.
 */
describe("PayerAuthService.verifyLogin — lifecycle (ADR-0037)", () => {
  it("promotes a pending payer to active on first successful verification", async () => {
    const d = setup();
    d.payers.findByEmail.mockResolvedValue({
      id: PAYER_ID,
      role: "employer",
      status: "pending",
    } as never);
    d.payers.activate.mockResolvedValue({ id: PAYER_ID } as never);

    await d.svc.verifyLogin({ email: EMAIL, code: "123456" } as never, CTX);

    expect(d.payers.activate).toHaveBeenCalledExactlyOnceWith(PAYER_ID);
  });

  it("emits payer.activated ONCE, carrying both ends of the transition", async () => {
    const d = setup();
    d.payers.findByEmail.mockResolvedValue({
      id: PAYER_ID,
      role: "employer",
      status: "pending",
    } as never);
    d.payers.activate.mockResolvedValue({ id: PAYER_ID } as never);

    await d.svc.verifyLogin({ email: EMAIL, code: "123456" } as never, CTX);

    const activated = d.events.emit.mock.calls
      .map((c) => c[0] as { event_name?: string; payload?: Record<string, unknown> })
      .filter((e) => e.event_name === "payer.activated");
    expect(activated).toHaveLength(1);
    expect(activated[0]!.payload).toEqual({
      payer_id: PAYER_ID,
      previous_status: "pending",
      new_status: "active",
    });
  });

  it("emits NOTHING on a later login — activation is once per payer, not per session", async () => {
    const d = setup();
    // The guarded UPDATE matched no row (already active), so activate() returns undefined.
    d.payers.activate.mockResolvedValue(undefined);

    await d.svc.verifyLogin({ email: EMAIL, code: "123456" } as never, CTX);

    const activated = d.events.emit.mock.calls
      .map((c) => c[0] as { event_name?: string })
      .filter((e) => e.event_name === "payer.activated");
    expect(activated).toHaveLength(0);
  });

  it("a SUSPENDED payer gets a distinct 403 and NO session is minted", async () => {
    const d = setup();
    d.payers.findByEmail.mockResolvedValue({
      id: PAYER_ID,
      role: "employer",
      status: "suspended",
    } as never);

    // Distinct from the neutral 401 an unknown/expired code returns. No enumeration cost:
    // to reach this line the caller already presented a valid single-use code for a real
    // account, so they have proven the account exists AND that they control its mailbox.
    await expect(
      d.svc.verifyLogin({ email: EMAIL, code: "123456" } as never, CTX),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(d.sessions.create).not.toHaveBeenCalled();
  });

  it("a suspended payer is never activated, and no session_started is recorded", async () => {
    const d = setup();
    d.payers.findByEmail.mockResolvedValue({
      id: PAYER_ID,
      role: "employer",
      status: "suspended",
    } as never);

    await d.svc.verifyLogin({ email: EMAIL, code: "123456" } as never, CTX).catch(() => null);

    expect(d.payers.activate).not.toHaveBeenCalled();
    const started = d.events.emit.mock.calls
      .map((c) => c[0] as { event_name?: string })
      .filter((e) => e.event_name === "payer.session_started");
    expect(started).toHaveLength(0);
  });
});

describe("PayerAuthService — OTP suppression for a suspended account (ADR-0037 Decision 5)", () => {
  /** Re-point both lookups at a SUSPENDED account. */
  function suspended(d: ReturnType<typeof setup>) {
    const row = { id: PAYER_ID, role: "employer", status: "suspended" } as never;
    d.payers.findByEmail.mockResolvedValue(row);
    d.payers.findById.mockResolvedValue(row);
    return d;
  }

  it("reserves the code but NEVER delivers it", async () => {
    const d = suspended(setup());
    await d.svc.requestLogin({ email: EMAIL } as never, CTX);

    // The reserve still runs — so the cooldown, the hourly cap and the GLOBAL daily send
    // breaker all still apply and still produce the same 429s a normal request would.
    expect(d.otp.issueWithoutDelivery).toHaveBeenCalledTimes(1);
    // ...but nothing is mailed. This is the whole point: no spend on a banned account.
    expect(d.otp.issueAndSend).not.toHaveBeenCalled();
  });

  it("returns the SAME body as an active account (no enumeration through the response)", async () => {
    const active = await setup().svc.requestLogin({ email: EMAIL } as never, CTX);
    const banned = await suspended(setup()).svc.requestLogin({ email: EMAIL } as never, CTX);
    expect(banned).toEqual(active);
  });

  it("records the attempt on the spine as the ONLY trace, and not as a login", async () => {
    const d = suspended(setup());
    await d.svc.requestLogin({ email: EMAIL } as never, CTX);

    const names = d.events.emit.mock.calls.map((c) => (c[0] as { event_name: string }).event_name);
    expect(names).toEqual(["payer.otp_suppressed"]);
    // NOT also payer.login_requested: no code was delivered, so counting it as a login
    // would overstate the funnel and bury repeated probing of a banned account.
    expect(names).not.toContain("payer.login_requested");

    const evt = d.events.emit.mock.calls[0]![0] as { payload: Record<string, unknown> };
    expect(evt.payload).toEqual({ payer_id: PAYER_ID, reason: "account_suspended" });
  });

  it("suppresses on the SIGNUP door too (an existing email resolves to the same account)", async () => {
    // The hole this closes: signup on an already-registered email `createOrGet`s back to
    // the SAME payer, so without a shared chokepoint a suspended payer could re-trigger
    // delivery just by "signing up" again.
    const d = suspended(setup());
    d.payers.createOrGet.mockResolvedValue({ id: PAYER_ID, created: false });

    await d.svc.signup({ email: EMAIL, role: "employer", org_name: ORG } as never, CTX);

    expect(d.otp.issueAndSend).not.toHaveBeenCalled();
    expect(d.otp.issueWithoutDelivery).toHaveBeenCalledTimes(1);
  });

  it("never decrypts contact PII for a message it will not send", async () => {
    const d = suspended(setup());
    await d.svc.requestLogin({ email: EMAIL } as never, CTX);
    expect(d.payers.decryptContact).not.toHaveBeenCalled();
    assertNoPiiInEvents(d.events);
  });

  it("emits an event that VALIDATES against the registry", async () => {
    const d = suspended(setup());
    await d.svc.requestLogin({ email: EMAIL } as never, CTX);
    const emitted = d.events.emit.mock.calls[0]![0] as { payload: Record<string, unknown> };
    const result = validateEvent({
      event_id: "55555555-5555-4555-8555-555555555555",
      event_name: "payer.otp_suppressed",
      event_version: 1,
      occurred_at: "2026-08-03T00:00:00.000Z",
      actor: { actor_type: "payer", actor_id: PAYER_ID },
      subject: { subject_type: "payer", subject_id: PAYER_ID },
      source: "api",
      correlation_id: CTX.correlationId,
      causation_id: null,
      payload: emitted.payload,
      metadata: { environment: "test", service: "api" },
    });
    expect(result.success).toBe(true);
  });

  it("an ACTIVE account is unaffected — it still gets a real delivery", async () => {
    // The control. Without it, a mutation that suppressed EVERY send would pass every
    // assertion above while silently taking payer login down for the whole platform.
    const d = setup();
    await d.svc.requestLogin({ email: EMAIL } as never, CTX);
    expect(d.otp.issueAndSend).toHaveBeenCalledTimes(1);
    expect(d.otp.issueWithoutDelivery).not.toHaveBeenCalled();
  });
});
