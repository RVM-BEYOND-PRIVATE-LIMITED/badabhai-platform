import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";
import type { ServerConfig } from "@badabhai/config";
import { OtpSendFailedException } from "../common/otp-send-failure";
import { AuthController } from "./auth.controller";
import type { AuthService } from "./auth.service";
import type { SessionService } from "./session.service";
import type { OtpService } from "./otp.service";
import type { PiiCryptoService } from "../common/pii-crypto.service";
import type { AccountDeletionService } from "./account-deletion.service";
import type { WorkersRepository } from "../workers/workers.repository";
import type { IpRateLimit } from "../common/rate-limit/ip-rate-limit.service";
import type { ConsentRepository } from "../consent/consent.repository";
import type { AuthenticatedWorker } from "./worker-auth.guard";
import type { RequestContext } from "../common/request-context";

const CTX = { correlationId: "c", requestId: "r" } as RequestContext;
const WORKER: AuthenticatedWorker = { id: "11111111-1111-4111-8111-111111111111", sid: "sid-1" };
// D-3 (review M1): a phone in the reserved synthetic range the test-login mint serves.
// The synthetic-range REFUSAL itself is the SERVICE's chokepoint (auth.service.test.ts);
// here the service is a double, so these cases cover the controller's caps/compose only.
const SYNTHETIC_PHONE = "+910000000000";

function make() {
  const auth = {
    requestOtp: vi.fn(async () => ({ success: true, channel: "sms" })),
    // pin_set is surfaced on the login response (ADR-0026 Phase 4) — the controller passes it through.
    verifyOtp: vi.fn(async () => ({ worker_id: WORKER.id, access_token: "tok", pin_set: false })),
    // D-3 — the gated test-login mint (same login shape; the guard gates the route).
    testLogin: vi.fn(async () => ({ worker_id: WORKER.id, access_token: "tok", pin_set: false })),
    // F4 (#168): the shared failure-signal seam — the account-delete step-up request
    // routes its Fast2SMS send through this so a delivery failure emits worker.otp_send_failed.
    issueAndSendWithSignals: vi.fn(async () => ({ resendInSeconds: 30 })),
  };
  const MINTED = {
    access: { token: "fresh", expiresInSeconds: 3600 },
    refresh: { token: "rt_new", expiresInSeconds: 7776000 },
    session: { tier: 1, expiresAtMs: Date.UTC(2026, 6, 27), requiresOtpAfterMs: Date.UTC(2026, 8, 25) },
  };
  const sessions = {
    refresh: vi.fn(async () => ({ token: "fresh", expiresInSeconds: 3600 })),
    revoke: vi.fn(async () => undefined),
    refreshByToken: vi.fn(async () => ({ ok: true, minted: MINTED })),
    resolveRefreshToken: vi.fn(async () => ({ workerId: WORKER.id, sid: WORKER.sid, familyId: "fam-1" })),
    revokeAll: vi.fn(async () => 2),
    describe: vi.fn(async () => ({ tier: 1, expiresAtMs: Date.UTC(2026, 6, 27), requiresOtpAfterMs: null })),
  };
  const workers = {
    // SELECT * — the account-delete step-up path needs the encrypted phone to send the OTP.
    findById: vi.fn(async () => ({ id: WORKER.id, status: "active", phoneE164: "ENC(+91999)" })),
    // ADR-0031 — GET /auth/me's EXPLICIT-projection read: status + the deletion marker only.
    // The absence of PII keys here is the point (see the /auth/me tests below).
    findSelfView: vi.fn(async (): Promise<{ status: string; deletionScheduledAt: Date | null } | undefined> => ({
      status: "active",
      deletionScheduledAt: null,
    })),
  };
  const ipRateLimit = {
    assertWithinHourlyIpCap: vi.fn(async () => undefined),
    // Review L1 — the IP-INDEPENDENT daily backstop on the test-login mint.
    assertWithinGlobalDailyCap: vi.fn(async () => undefined),
  };
  const otp = {
    issueAndSend: vi.fn(async () => ({ resendInSeconds: 30 })),
    verify: vi.fn(async () => undefined),
  };
  const pii = { decrypt: vi.fn((t: string) => t.replace(/^ENC\(|\)$/g, "")) };
  // ADR-0031 — confirm SCHEDULES (never executes in-request); cancel is idempotent.
  const accountDeletion = {
    execute: vi.fn(async () => undefined),
    schedule: vi.fn(async () => ({ scheduled_for: "2026-07-21T10:00:00.000Z" })),
    cancel: vi.fn(async () => ({ cancelled: true })),
  };
  const consents = { findLatestByWorker: vi.fn(async () => undefined) };
  const config = { OTP_MAX_SENDS_PER_HOUR: 5, TEST_LOGIN_MAX_PER_DAY: 200 } as ServerConfig;
  const controller = new AuthController(
    auth as unknown as AuthService,
    sessions as unknown as SessionService,
    workers as unknown as WorkersRepository,
    ipRateLimit as unknown as IpRateLimit,
    otp as unknown as OtpService,
    pii as unknown as PiiCryptoService,
    accountDeletion as unknown as AccountDeletionService,
    consents as unknown as ConsentRepository,
    config,
  );
  return { controller, auth, sessions, workers, ipRateLimit, otp, pii, accountDeletion, consents };
}

const reqWith = (overrides: Partial<Request> = {}): Request =>
  ({ ip: "1.2.3.4", header: (k: string) => (k === "authorization" ? "Bearer tok" : undefined), ...overrides }) as unknown as Request;

/** A request carrying the required Idempotency-Key header for POST /auth/token/refresh. */
const reqIdem = (): Request =>
  ({ ip: "1.2.3.4", header: (k: string) => (k === "idempotency-key" ? "idem-1" : undefined) }) as unknown as Request;

describe("AuthController — consent-on-resume (A5 · ADR-0026 amendment)", () => {
  it("token/refresh: REVOKED consent → 403 and the token is NOT rotated", async () => {
    const { controller, sessions, consents } = make();
    (consents.findLatestByWorker as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      revokedAt: new Date(),
    });
    await expect(
      controller.tokenRefresh({ refresh_token: "rt" } as never, reqIdem()),
    ).rejects.toBeInstanceOf(ForbiddenException);
    // Denied BEFORE any rotation — the presented token is not consumed.
    expect(sessions.refreshByToken).not.toHaveBeenCalled();
  });

  it("token/refresh: NEVER-consented (no row) is ALLOWED — onboarding window not broken", async () => {
    const { controller, sessions, consents } = make();
    (consents.findLatestByWorker as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    await controller.tokenRefresh({ refresh_token: "rt" } as never, reqIdem());
    expect(sessions.refreshByToken).toHaveBeenCalled();
  });

  it("token/refresh: ACTIVE consent (revokedAt null) is ALLOWED", async () => {
    const { controller, sessions, consents } = make();
    (consents.findLatestByWorker as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ revokedAt: null });
    await controller.tokenRefresh({ refresh_token: "rt" } as never, reqIdem());
    expect(sessions.refreshByToken).toHaveBeenCalled();
  });

  it("token/refresh: an UNRESOLVABLE token skips the consent check (no oracle) and falls through", async () => {
    const { controller, sessions, consents } = make();
    (sessions.resolveRefreshToken as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    await controller.tokenRefresh({ refresh_token: "rt" } as never, reqIdem());
    expect(consents.findLatestByWorker).not.toHaveBeenCalled();
    expect(sessions.refreshByToken).toHaveBeenCalled();
  });
});

describe("AuthController", () => {
  it("requestOtp applies the per-IP cap FIRST, then delegates the phone", async () => {
    const { controller, auth, ipRateLimit } = make();
    await controller.requestOtp({ phone: "+91999" } as never, reqWith(), CTX);
    expect(ipRateLimit.assertWithinHourlyIpCap).toHaveBeenCalledWith("otp_request", "1.2.3.4", 5);
    expect(auth.requestOtp).toHaveBeenCalledWith("+91999", CTX);
  });

  it("requestOtp cap rejection blocks the send", async () => {
    const { controller, auth, ipRateLimit } = make();
    (ipRateLimit.assertWithinHourlyIpCap as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new ConflictException("cap"),
    );
    await expect(controller.requestOtp({ phone: "+91999" } as never, reqWith(), CTX)).rejects.toBeTruthy();
    expect(auth.requestOtp).not.toHaveBeenCalled();
  });

  it("verifyOtp delegates phone + otp (+ optional device_info) and passes through pin_set", async () => {
    const { controller, auth } = make();
    const res = await controller.verifyOtp({ phone: "+91999", otp: "1234" } as never, CTX);
    // device_info is undefined when the client omits it (ADR-0026 Phase 2 — additive/opt-in).
    expect(auth.verifyOtp).toHaveBeenCalledWith("+91999", "1234", CTX, undefined);
    // ADR-0026 Phase 4 — the controller surfaces pin_set unchanged from the service.
    expect(res.pin_set).toBe(false);
  });

  // ---- TD62 — additive consent_accepted on the login response ----

  it("verifyOtp: NEVER-consented worker (no row) → consent_accepted false", async () => {
    const { controller, consents } = make();
    (consents.findLatestByWorker as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    const res = await controller.verifyOtp({ phone: "+91999", otp: "1234" } as never, CTX);
    expect(consents.findLatestByWorker).toHaveBeenCalledWith(WORKER.id);
    expect(res.consent_accepted).toBe(false);
  });

  it("verifyOtp: ACTIVE consent (revokedAt null) → consent_accepted true", async () => {
    const { controller, consents } = make();
    (consents.findLatestByWorker as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      revokedAt: null,
    });
    const res = await controller.verifyOtp({ phone: "+91999", otp: "1234" } as never, CTX);
    expect(res.consent_accepted).toBe(true);
  });

  it("verifyOtp: REVOKED consent → consent_accepted false (client routes back to /consent)", async () => {
    const { controller, consents } = make();
    (consents.findLatestByWorker as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      revokedAt: new Date(),
    });
    const res = await controller.verifyOtp({ phone: "+91999", otp: "1234" } as never, CTX);
    expect(res.consent_accepted).toBe(false);
  });

  it("verifyOtp: a consent-read FAILURE still returns the 200 login — field OMITTED (F1)", async () => {
    // The OTP is consumed + session minted by the time the compose runs; a repo blip
    // must not 500 the succeeded login (the worker would burn another OTP against the
    // TD60 daily cap). The field is omitted; the app's tri-state passes through.
    const { controller, consents } = make();
    (consents.findLatestByWorker as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("db blip"),
    );
    const res = await controller.verifyOtp({ phone: "+91999", otp: "1234" } as never, CTX);
    expect(res.worker_id).toBe(WORKER.id);
    expect(res.access_token).toBe("tok");
    expect("consent_accepted" in res).toBe(false); // omitted, never a defaulted value
  });

  // ---- D-3 — POST /auth/test-login (the guard 404s/401s the route; here: handler behaviour) ----

  it("testLogin applies BOTH caps (per-IP hour + global day) BEFORE delegating to the mint seam", async () => {
    const { controller, auth, ipRateLimit } = make();
    await controller.testLogin({ phone: SYNTHETIC_PHONE } as never, reqWith(), CTX);
    expect(ipRateLimit.assertWithinHourlyIpCap).toHaveBeenCalledWith("test_login", "1.2.3.4", 5);
    // Review L1 — the IP-INDEPENDENT backstop: a token holder rotating IPs is still bounded.
    expect(ipRateLimit.assertWithinGlobalDailyCap).toHaveBeenCalledWith("test_login", 200);
    expect(auth.testLogin).toHaveBeenCalledWith(SYNTHETIC_PHONE, CTX);
  });

  it("testLogin per-IP cap rejection blocks the mint (fail closed)", async () => {
    const { controller, auth, ipRateLimit } = make();
    (ipRateLimit.assertWithinHourlyIpCap as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new ConflictException("cap"),
    );
    await expect(controller.testLogin({ phone: SYNTHETIC_PHONE } as never, reqWith(), CTX)).rejects.toBeTruthy();
    expect(auth.testLogin).not.toHaveBeenCalled();
  });

  it("testLogin GLOBAL daily cap rejection blocks the mint (L1 — the IP-rotation backstop)", async () => {
    const { controller, auth, ipRateLimit } = make();
    (ipRateLimit.assertWithinGlobalDailyCap as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new ConflictException("global cap"),
    );
    await expect(controller.testLogin({ phone: SYNTHETIC_PHONE } as never, reqWith(), CTX)).rejects.toBeTruthy();
    expect(auth.testLogin).not.toHaveBeenCalled();
  });

  it("testLogin does NOT mark consent: a never-consented worker gets consent_accepted false and consent is only READ", async () => {
    // Consent is NOT bypassed — the minted session behaves exactly like an OTP session:
    // the response carries the same TD62 tri-state compose (false here), and the only
    // consent interaction is the READ (ConsentRepository has no write called; the §6
    // ConsentGuard still denies the profiling routes until the worker accepts).
    const { controller, consents } = make();
    (consents.findLatestByWorker as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    const res = await controller.testLogin({ phone: SYNTHETIC_PHONE } as never, reqWith(), CTX);
    expect(consents.findLatestByWorker).toHaveBeenCalledWith(WORKER.id);
    expect(res.consent_accepted).toBe(false);
  });

  it("testLogin returns the SAME login shape as verifyOtp (session/token pass-through, no PII)", async () => {
    const { controller } = make();
    const res = await controller.testLogin({ phone: SYNTHETIC_PHONE } as never, reqWith(), CTX);
    expect(res.worker_id).toBe(WORKER.id);
    expect(res.access_token).toBe("tok");
    expect(res.pin_set).toBe(false);
    expect(JSON.stringify(res)).not.toMatch(/phone|full_?name/i);
  });

  it("testLogin: a consent-read FAILURE still returns the 200 login — field OMITTED (F1 parity with verifyOtp)", async () => {
    const { controller, consents } = make();
    (consents.findLatestByWorker as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("db blip"),
    );
    const res = await controller.testLogin({ phone: SYNTHETIC_PHONE } as never, reqWith(), CTX);
    expect(res.worker_id).toBe(WORKER.id);
    expect("consent_accepted" in res).toBe(false);
  });

  it("me returns the authed worker id + status (no PII)", async () => {
    const { controller } = make();
    const res = await controller.me(WORKER);
    expect(res).toEqual({ worker_id: WORKER.id, status: "active" });
    expect(JSON.stringify(res)).not.toMatch(/phone|full_?name/i);
  });

  // ---- ADR-0031 — /auth/me is the pending-deletion seam for EVERY entry path ----

  it("me CARRIES deletion_scheduled_for (ISO-8601) while a deletion is pending", async () => {
    const { controller, workers } = make();
    (workers.findSelfView as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: "active",
      deletionScheduledAt: new Date("2026-07-21T10:00:00.000Z"),
    });

    const res = await controller.me(WORKER);

    // The seam a PIN-unlock / refresh cold start can reach — OTP-verify is never hit there,
    // so without this the app has no banner and no way to cancel for the rest of the grace.
    expect(res).toEqual({
      worker_id: WORKER.id,
      status: "active",
      deletion_scheduled_for: "2026-07-21T10:00:00.000Z",
    });
  });

  it("me OMITS deletion_scheduled_for when nothing is pending (absent — never null)", async () => {
    const { controller } = make();
    const res = await controller.me(WORKER);
    // Absent vs null matters: the client's rule is `field present ⇔ deletion pending`.
    expect("deletion_scheduled_for" in res).toBe(false);
    expect(JSON.stringify(res)).not.toMatch(/deletion_scheduled_for/);
  });

  it("me reads the marker EXPLICITLY (findSelfView) — never the SELECT-* findById that carries PII", async () => {
    const { controller, workers } = make();
    (workers.findSelfView as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: "active",
      deletionScheduledAt: new Date("2026-07-21T10:00:00.000Z"),
    });

    const res = await controller.me(WORKER);

    expect(workers.findSelfView).toHaveBeenCalledWith(WORKER.id);
    expect(workers.findById).not.toHaveBeenCalled();
    // The pending response is PII-free: no phone/name/hash key, and no encrypted blob
    // (findById's row carries phoneE164: "ENC(+91999)" — it must not reach the wire).
    const serialized = JSON.stringify(res);
    expect(serialized).not.toMatch(/phone|full_?name|hash|ENC\(|\+91/i);
    expect(Object.keys(res).sort()).toEqual([
      "deletion_scheduled_for",
      "status",
      "worker_id",
    ]);
  });

  it("me never FABRICATES a date: a worker row that vanished mid-session → status fallback, no field", async () => {
    const { controller, workers } = make();
    (workers.findSelfView as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    const res = await controller.me(WORKER);
    expect(res).toEqual({ worker_id: WORKER.id, status: "active" });
  });

  it("refresh mints a fresh token from the bearer", async () => {
    const { controller, sessions } = make();
    const res = await controller.refresh(reqWith());
    expect(sessions.refresh).toHaveBeenCalledWith("tok");
    expect(res).toEqual({ access_token: "fresh", token_type: "Bearer", expires_in_seconds: 3600 });
  });

  it("refresh 401s when the session is invalid/expired", async () => {
    const { controller, sessions } = make();
    (sessions.refresh as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    await expect(controller.refresh(reqWith())).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("logout revokes the current session id (and drops it from the worker set)", async () => {
    const { controller, sessions } = make();
    await controller.logout(WORKER);
    expect(sessions.revoke).toHaveBeenCalledWith(WORKER.sid, WORKER.id);
  });

  // ---- ADR-0026 Phase 1 endpoints ----

  const reqWithIdem = (key?: string): Request =>
    ({
      ip: "1.2.3.4",
      header: (k: string) => (k.toLowerCase() === "idempotency-key" ? key : undefined),
    }) as unknown as Request;

  it("tokenRefresh rejects a missing Idempotency-Key header with 400", async () => {
    const { controller, sessions } = make();
    await expect(
      controller.tokenRefresh({ refresh_token: "rt_old" } as never, reqWithIdem(undefined)),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(sessions.refreshByToken).not.toHaveBeenCalled();
  });

  it("tokenRefresh rotates and returns the new access + refresh + session block", async () => {
    const { controller, sessions } = make();
    const res = await controller.tokenRefresh(
      { refresh_token: "rt_old" } as never,
      reqWithIdem("idem-1"),
    );
    expect(sessions.refreshByToken).toHaveBeenCalledWith("rt_old", "idem-1");
    expect(res.access_token).toBe("fresh");
    expect(res.refresh_token).toBe("rt_new");
    expect(res.token_type).toBe("Bearer");
    expect(res.session.tier).toBe(1);
    expect(typeof res.session.expires_at).toBe("string");
    expect(typeof res.session.requires_otp_after).toBe("string");
  });

  it("tokenRefresh 401s on an invalid/reused/expired refresh token (no oracle on which)", async () => {
    const { controller, sessions } = make();
    (sessions.refreshByToken as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      reason: "reuse_detected",
    });
    await expect(
      controller.tokenRefresh({ refresh_token: "rt_used" } as never, reqWithIdem("idem-2")),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("logoutAll revokes all sessions for the worker (204, count in the event)", async () => {
    const { controller, sessions } = make();
    await controller.logoutAll(WORKER);
    expect(sessions.revokeAll).toHaveBeenCalledWith(WORKER.id);
  });

  it("session returns the tier/expiry introspection for the current session", async () => {
    const { controller, sessions } = make();
    const res = await controller.session(WORKER);
    expect(sessions.describe).toHaveBeenCalledWith(WORKER.id, WORKER.sid);
    expect(res.tier).toBe(1);
    expect(res.requires_otp_after).toBeNull();
    expect(typeof res.expires_at).toBe("string");
  });

  it("session 401s when the session record is gone", async () => {
    const { controller, sessions } = make();
    (sessions.describe as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    await expect(controller.session(WORKER)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  // ---- ADR-0026 Phase 5 — DPDP account deletion (step-up OTP) ----

  it("accountDeleteRequest resolves the TOKEN worker's phone (never a body) and sends the OTP via the F4 signal seam", async () => {
    const { controller, workers, pii, auth } = make();
    const res = await controller.accountDeleteRequest(WORKER, CTX);
    expect(workers.findById).toHaveBeenCalledWith(WORKER.id);
    expect(pii.decrypt).toHaveBeenCalledWith("ENC(+91999)");
    // The send rides the SHARED AuthService seam (never otp.issueAndSend directly), so a
    // delivery failure emits worker.otp_send_failed exactly like the login path.
    expect(auth.issueAndSendWithSignals).toHaveBeenCalledWith("+91999", CTX);
    expect(res).toEqual({ success: true, resend_in_seconds: 30 });
  });

  it("accountDeleteRequest 401s when the token worker row is gone (no oracle, fail closed)", async () => {
    const { controller, workers, auth } = make();
    (workers.findById as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    await expect(controller.accountDeleteRequest(WORKER, CTX)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(auth.issueAndSendWithSignals).not.toHaveBeenCalled();
  });

  it("accountDeleteRequest on a send failure surfaces the neutral 502 THROUGH the emitting seam (F4)", async () => {
    // The seam (AuthService.issueAndSendWithSignals) emits worker.otp_send_failed once and
    // re-throws — proven in auth.service.test.ts. Here: the delete-request path delegates to
    // that exact seam and propagates the SAME neutral 502 unchanged.
    const { controller, auth } = make();
    (auth.issueAndSendWithSignals as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new OtpSendFailedException({ provider: "fast2sms", reason: "transport" }),
    );
    await expect(controller.accountDeleteRequest(WORKER, CTX)).rejects.toMatchObject({
      status: 502,
      message: "Could not send the code, please retry",
    });
    expect(auth.issueAndSendWithSignals).toHaveBeenCalledWith("+91999", CTX);
  });

  it("accountDeleteConfirm verifies the step-up OTP THEN schedules (ADR-0031) — 200 {success, scheduled_for}", async () => {
    const { controller, otp, accountDeletion } = make();
    const res = await controller.accountDeleteConfirm(WORKER, { otp: "123456" } as never, CTX);
    expect(otp.verify).toHaveBeenCalledWith("+91999", "123456");
    // Confirm SCHEDULES — the erasure itself runs in the sweep after the grace elapses.
    expect(accountDeletion.schedule).toHaveBeenCalledWith(WORKER.id, CTX);
    expect(accountDeletion.execute).not.toHaveBeenCalled();
    expect(res).toEqual({ success: true, scheduled_for: "2026-07-21T10:00:00.000Z" });
  });

  it("accountDeleteConfirm schedules NOTHING when the OTP verify throws (fail closed)", async () => {
    const { controller, otp, accountDeletion } = make();
    (otp.verify as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new UnauthorizedException("bad otp"));
    await expect(
      controller.accountDeleteConfirm(WORKER, { otp: "000000" } as never, CTX),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(accountDeletion.schedule).not.toHaveBeenCalled();
    expect(accountDeletion.execute).not.toHaveBeenCalled();
  });

  // ---- Phase 5 added coverage (QA gap-closure) ----

  it("accountDeleteConfirm IDENTITY is the GUARD's worker.id — a body worker_id is IGNORED (no IDOR)", async () => {
    // The handler signature only accepts {otp}; even if a hostile body smuggles a worker_id,
    // schedule() must always run against the TOKEN's worker.id, never the body. Assert the
    // scheduling + the OTP gate both target the guard identity, not the injected victim id.
    const { controller, otp, accountDeletion } = make();
    const VICTIM = "99999999-9999-4999-8999-999999999999";
    await controller.accountDeleteConfirm(
      WORKER,
      {
        otp: "123456",
        worker_id: VICTIM,
      } as never,
      CTX,
    );
    // The OTP was verified against the TOKEN worker's phone (resolved from WORKER.id).
    expect(otp.verify).toHaveBeenCalledWith("+91999", "123456");
    // The schedule targets the GUARD's id — never the injected victim id.
    expect(accountDeletion.schedule).toHaveBeenCalledWith(WORKER.id, CTX);
    expect(accountDeletion.schedule).not.toHaveBeenCalledWith(VICTIM, expect.anything());
  });

  it("accountDeleteRequest resolves the phone from the GUARD worker (not a body) — body is unused", async () => {
    // /request takes no body param at all; the phone is derived from the token worker's
    // decrypted ciphertext. A would-be body worker_id can never redirect the OTP send.
    const { controller, workers, auth } = make();
    const VICTIM = "99999999-9999-4999-8999-999999999999";
    await controller.accountDeleteRequest(WORKER, CTX);
    expect(workers.findById).toHaveBeenCalledWith(WORKER.id);
    expect(workers.findById).not.toHaveBeenCalledWith(VICTIM);
    expect(auth.issueAndSendWithSignals).toHaveBeenCalledWith("+91999", CTX);
  });

  it("accountDeleteRequest NEVER returns the phone or the OTP — only success + resend_in_seconds", async () => {
    const { controller } = make();
    const res = await controller.accountDeleteRequest(WORKER, CTX);
    expect(res).toEqual({ success: true, resend_in_seconds: 30 });
    const json = JSON.stringify(res);
    // No decrypted phone, no E.164 run, no OTP code in the response body.
    expect(json).not.toContain("+91999");
    expect(json).not.toMatch(/\d{6,}/); // no OTP-length / phone-length digit run
    expect(json).not.toMatch(/otp/i);
  });

  it("accountDeleteConfirm returns 200 {success, scheduled_for} and surfaces no PII", async () => {
    const { controller } = make();
    const res = await controller.accountDeleteConfirm(WORKER, { otp: "123456" } as never, CTX);
    expect(res).toEqual({ success: true, scheduled_for: "2026-07-21T10:00:00.000Z" });
    const json = JSON.stringify(res);
    // No decrypted phone, no OTP code — only the success flag + the PII-free due time.
    expect(json).not.toContain("+91999");
    expect(json).not.toMatch(/otp/i);
  });

  // ---- ADR-0031 — cancel-anytime during the grace window ----

  it("accountDeleteCancel delegates to cancel(worker.id, ctx) and returns { success: true }", async () => {
    const { controller, accountDeletion } = make();
    const res = await controller.accountDeleteCancel(WORKER, CTX);
    expect(accountDeletion.cancel).toHaveBeenCalledWith(WORKER.id, CTX);
    expect(res).toEqual({ success: true });
  });

  it("accountDeleteCancel is idempotent: still { success: true } when nothing was pending (no oracle)", async () => {
    const { controller, accountDeletion } = make();
    (accountDeletion.cancel as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ cancelled: false });
    const res = await controller.accountDeleteCancel(WORKER, CTX);
    expect(res).toEqual({ success: true });
  });

  it("accountDeleteCancel NEVER runs the erasure or the OTP gate (purely recoverable action)", async () => {
    const { controller, otp, accountDeletion } = make();
    await controller.accountDeleteCancel(WORKER, CTX);
    expect(otp.verify).not.toHaveBeenCalled();
    expect(accountDeletion.execute).not.toHaveBeenCalled();
    expect(accountDeletion.schedule).not.toHaveBeenCalled();
  });
});

// Guard metadata (401 for an unauthenticated caller) is asserted structurally in
// account-deletion.module.boot.test.ts: all three deletion routes (request/confirm/cancel)
// carry @UseGuards(WorkerAuthGuard), so an unauthenticated request is rejected by the guard
// before any handler body runs. Cancel deliberately carries NO ConsentGuard (ADR-0031).
