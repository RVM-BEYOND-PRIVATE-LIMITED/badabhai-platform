import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  UnauthorizedException,
} from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import { validateEvent } from "@badabhai/event-schema";
import type { RequestContext } from "../common/request-context";
import { OtpSendCapExceededException } from "../common/otp-send-cap";
import { PayerAuthService } from "./payer-auth.service";

const CTX: RequestContext = { correlationId: "11111111-1111-4111-8111-111111111111", requestId: "req-1" };
const PAYER_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const EMAIL = "boss@acme.com";
const ORG = "Acme Manufacturing Pvt Ltd";
const PHONE = "+919876543210";

function setup(over: { method?: "email_otp" | "whatsapp" | "supabase" } = {}) {
  const config = {
    PAYER_LOGIN_METHOD: over.method ?? "email_otp",
    OTP_RESEND_COOLDOWN_SECONDS: 30,
  } as unknown as ServerConfig;

  const account = { id: PAYER_ID, role: "employer", status: "active" } as never;
  const payers = {
    createOrGet: vi.fn(async () => ({ id: PAYER_ID, created: true })),
    findByEmail: vi.fn(async () => account),
    findById: vi.fn(async () => account),
    // ADR-0037 — first successful verify promotes pending → active. Default: the account
    // is already active in this fixture, so the guarded update moves no row (undefined)
    // and no `payer.activated` event fires. Tests that exercise activation override this.
    activate: vi.fn(async () => undefined),
    decryptContact: vi.fn(() => ({ id: PAYER_ID, role: "employer", status: "active", email: EMAIL, phone: PHONE })),
  };
  const otp = {
    // Real-only: PayerOtpIssued is { resendInSeconds } — the code is delivered to the payer's
    // email by the channel and is NEVER echoed back to the auth service.
    issueAndSend: vi.fn(async () => ({ resendInSeconds: 30 })),
    issueWithoutDelivery: vi.fn(async () => ({ resendInSeconds: 30 })),
    verify: vi.fn(async () => undefined),
  };
  const orgs = {
    // Default: the payer already has an org (backfilled / prior signup) so login does NOT
    // re-ensure. Tests override resolveOrgForPayer→null to exercise the gap-payer repair.
    ensureSoloOrg: vi.fn(async () => ({ orgId: "org-1", orgRole: "owner" })),
    resolveOrgForPayer: vi.fn(async () => ({ orgId: "org-1", orgRole: "owner" })),
  };
  const sessions = {
    create: vi.fn(async () => ({ token: "jwt-token", expiresInSeconds: 2592000 })),
    mint: vi.fn(async () => ({ token: "fresh-jwt", expiresInSeconds: 2592000 })),
    revoke: vi.fn(async () => undefined),
  };
  const events = {
    emit: vi.fn(
      (_evt: { event_name: string; payload: Record<string, unknown> }): Promise<void> =>
        Promise.resolve(),
    ),
  };
  const pii = { hmac: (v: string) => `hmac<${v}>` };
  const freeTier = { grantQuietly: vi.fn().mockResolvedValue(undefined) };

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
  );
  return { svc, payers, orgs, otp, sessions, events, freeTier };
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
    const res = await d.svc.signup({ role: "employer", email: EMAIL, org_name: ORG, phone: PHONE }, CTX);
    expect(d.payers.createOrGet).toHaveBeenCalledWith({ role: "employer", email: EMAIL, orgName: ORG, phone: PHONE });

    const created = d.events.emit.mock.calls.find((c) => c[0].event_name === "payer.created");
    expect(created).toBeDefined();
    expect(created![0].payload).toEqual({ payer_id: PAYER_ID, role: "employer", method: "email_otp" });
    expect(d.otp.issueAndSend).toHaveBeenCalledTimes(1);
    // Real-only: the response is the neutral { status, resend_in_seconds } only — no dev_otp echo.
    expect(res).toEqual({ status: "code_sent", resend_in_seconds: 30 });
    // B5: a new payer founds a solo org with themselves as owner.
    expect(d.orgs.ensureSoloOrg).toHaveBeenCalledWith(PAYER_ID);
    assertNoPiiInEvents(d.events);
  });

  it("an EXISTING email does NOT emit payer.created (no overwrite) but returns the IDENTICAL response (XB-H)", async () => {
    d.payers.createOrGet.mockResolvedValueOnce({ id: PAYER_ID, created: false });
    const res = await d.svc.signup({ role: "employer", email: EMAIL, org_name: ORG, phone: PHONE }, CTX);
    expect(d.events.emit.mock.calls.find((c) => c[0].event_name === "payer.created")).toBeUndefined();
    // B5: an existing account is NEVER mutated on the signup path — no org ensure either.
    expect(d.orgs.ensureSoloOrg).not.toHaveBeenCalled();
    expect(res).toMatchObject({ status: "code_sent" }); // same neutral shape as a new signup
  });
});

describe("PayerAuthService.requestLogin (no user-enumeration)", () => {
  it("a KNOWN email issues+delivers a code and emits payer.login_requested (PII-free)", async () => {
    const d = setup();
    const res = await d.svc.requestLogin({ email: EMAIL }, CTX);
    expect(d.otp.issueAndSend).toHaveBeenCalledTimes(1);
    expect(d.otp.issueWithoutDelivery).not.toHaveBeenCalled();
    const reqEvt = d.events.emit.mock.calls.find((c) => c[0].event_name === "payer.login_requested");
    expect(reqEvt![0].payload).toEqual({ payer_id: PAYER_ID, method: "email_otp" });
    expect(res).toMatchObject({ status: "code_sent" });
    assertNoPiiInEvents(d.events);
  });

  it("an UNKNOWN email runs the no-delivery reserve, emits NOTHING, and returns the SAME shape", async () => {
    const d = setup();
    d.payers.findByEmail.mockResolvedValueOnce(undefined as never);
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
    unknown.payers.findByEmail.mockResolvedValueOnce(undefined as never);
    unknown.otp.issueWithoutDelivery.mockRejectedValueOnce(breach());
    const unknownRes = await unknown.svc.requestLogin({ email: "ghost@nowhere.com" }, CTX);

    // Byte-identical body — a caller cannot tell whether the account exists.
    expect(knownRes).toEqual(unknownRes);
    expect(knownRes).toEqual({ status: "code_sent", resend_in_seconds: 30 });
  });

  it("signup on a breach also degrades to the neutral code_sent (account already created)", async () => {
    const d = setup();
    d.otp.issueAndSend.mockRejectedValueOnce(breach());
    const res = await d.svc.signup({ role: "employer", email: EMAIL, org_name: ORG, phone: PHONE }, CTX);
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
    expect(d.sessions.create).toHaveBeenCalledWith(PAYER_ID, "employer");
    const evt = d.events.emit.mock.calls.find((c) => c[0].event_name === "payer.session_started");
    expect(evt![0].payload).toEqual({ payer_id: PAYER_ID, method: "email_otp", is_new_payer: false });
    expect(res).toMatchObject({ access_token: "jwt-token", token_type: "Bearer", payer_id: PAYER_ID, role: "employer" });
    assertNoPiiInEvents(d.events);
  });

  it("a verified code for an UNKNOWN account does NOT mint a session — returns the SAME 401 (no oracle)", async () => {
    const d = setup();
    d.payers.findByEmail.mockResolvedValueOnce(undefined as never); // reserved code, no account
    await expect(d.svc.verifyLogin({ email: "ghost@nowhere.com", code: "999999" }, CTX)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(d.sessions.create).not.toHaveBeenCalled();
    expect(d.events.emit).not.toHaveBeenCalled();
  });

  it("does NOT re-ensure the org when the payer already has one (cheap common path)", async () => {
    const d = setup(); // resolveOrgForPayer defaults to an existing org
    await d.svc.verifyLogin({ email: EMAIL, code: "123456" }, CTX);
    expect(d.orgs.resolveOrgForPayer).toHaveBeenCalledWith(PAYER_ID);
    expect(d.orgs.ensureSoloOrg).not.toHaveBeenCalled();
  });

  it("repairs a gap payer (no org yet) by ensuring the solo org on first login (B5.1→B5.2 gap)", async () => {
    const d = setup();
    d.orgs.resolveOrgForPayer.mockResolvedValueOnce(null as never); // created before B5.2 shipped
    await d.svc.verifyLogin({ email: EMAIL, code: "123456" }, CTX);
    expect(d.orgs.ensureSoloOrg).toHaveBeenCalledWith(PAYER_ID);
    // Still mints the session normally.
    expect(d.sessions.create).toHaveBeenCalledWith(PAYER_ID, "employer");
  });
});

describe("PayerAuthService.refresh + logout", () => {
  it("refresh mints a fresh token for the validated payer+session", async () => {
    const d = setup();
    const res = await d.svc.refresh(PAYER_ID, "sid-1");
    expect(d.sessions.mint).toHaveBeenCalledWith(PAYER_ID, "sid-1");
    expect(res).toMatchObject({ access_token: "fresh-jwt", token_type: "Bearer" });
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
    d.payers.activate.mockResolvedValue(undefined as never);

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
