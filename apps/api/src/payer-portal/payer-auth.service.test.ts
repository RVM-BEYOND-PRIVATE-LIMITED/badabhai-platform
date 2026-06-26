import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { HttpException, HttpStatus, UnauthorizedException } from "@nestjs/common";
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
    decryptContact: vi.fn(() => ({ id: PAYER_ID, role: "employer", status: "active", email: EMAIL, phone: PHONE })),
  };
  const otp = {
    issueAndSend: vi.fn(async () => ({ resendInSeconds: 30, devCode: "123456" })),
    issueWithoutDelivery: vi.fn(async () => ({ resendInSeconds: 30, devCode: "999999" })),
    verify: vi.fn(async () => undefined),
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

  const svc = new PayerAuthService(
    config,
    payers as never,
    otp as never,
    sessions as never,
    events as never,
    pii as never,
  );
  return { svc, payers, otp, sessions, events };
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
    expect(res).toMatchObject({ status: "code_sent", resend_in_seconds: 30, dev_otp: "123456" });
    assertNoPiiInEvents(d.events);
  });

  it("an EXISTING email does NOT emit payer.created (no overwrite) but returns the IDENTICAL response (XB-H)", async () => {
    d.payers.createOrGet.mockResolvedValueOnce({ id: PAYER_ID, created: false });
    const res = await d.svc.signup({ role: "employer", email: EMAIL, org_name: ORG, phone: PHONE }, CTX);
    expect(d.events.emit.mock.calls.find((c) => c[0].event_name === "payer.created")).toBeUndefined();
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
