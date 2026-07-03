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

function make() {
  const auth = {
    requestOtp: vi.fn(async () => ({ success: true, channel: "sms" })),
    // pin_set is surfaced on the login response (ADR-0026 Phase 4) — the controller passes it through.
    verifyOtp: vi.fn(async () => ({ worker_id: WORKER.id, access_token: "tok", pin_set: false })),
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
    findById: vi.fn(async () => ({ id: WORKER.id, status: "active", phoneE164: "ENC(+91999)" })),
  };
  const ipRateLimit = { assertWithinHourlyIpCap: vi.fn(async () => undefined) };
  const otp = {
    issueAndSend: vi.fn(async () => ({ resendInSeconds: 30 })),
    verify: vi.fn(async () => undefined),
  };
  const pii = { decrypt: vi.fn((t: string) => t.replace(/^ENC\(|\)$/g, "")) };
  const accountDeletion = { execute: vi.fn(async () => undefined) };
  const consents = { findLatestByWorker: vi.fn(async () => undefined) };
  const config = { OTP_MAX_SENDS_PER_HOUR: 5 } as ServerConfig;
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

  it("me returns the authed worker id + status (no PII)", async () => {
    const { controller } = make();
    const res = await controller.me(WORKER);
    expect(res).toEqual({ worker_id: WORKER.id, status: "active" });
    expect(JSON.stringify(res)).not.toMatch(/phone|full_?name/i);
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

  it("accountDeleteRequest resolves the TOKEN worker's phone (never a body) and sends the OTP", async () => {
    const { controller, workers, pii, otp } = make();
    const res = await controller.accountDeleteRequest(WORKER);
    expect(workers.findById).toHaveBeenCalledWith(WORKER.id);
    expect(pii.decrypt).toHaveBeenCalledWith("ENC(+91999)");
    expect(otp.issueAndSend).toHaveBeenCalledWith("+91999");
    expect(res).toEqual({ success: true, resend_in_seconds: 30 });
  });

  it("accountDeleteRequest 401s when the token worker row is gone (no oracle, fail closed)", async () => {
    const { controller, workers, otp } = make();
    (workers.findById as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    await expect(controller.accountDeleteRequest(WORKER)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(otp.issueAndSend).not.toHaveBeenCalled();
  });

  it("accountDeleteConfirm verifies the step-up OTP THEN runs the erasure (204)", async () => {
    const { controller, otp, accountDeletion } = make();
    await controller.accountDeleteConfirm(WORKER, { otp: "123456" } as never);
    expect(otp.verify).toHaveBeenCalledWith("+91999", "123456");
    expect(accountDeletion.execute).toHaveBeenCalledWith(WORKER.id);
  });

  it("accountDeleteConfirm does NOT delete when the OTP verify throws (fail closed)", async () => {
    const { controller, otp, accountDeletion } = make();
    (otp.verify as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new UnauthorizedException("bad otp"));
    await expect(
      controller.accountDeleteConfirm(WORKER, { otp: "000000" } as never),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(accountDeletion.execute).not.toHaveBeenCalled();
  });

  // ---- Phase 5 added coverage (QA gap-closure) ----

  it("accountDeleteConfirm IDENTITY is the GUARD's worker.id — a body worker_id is IGNORED (no IDOR)", async () => {
    // The handler signature only accepts {otp}; even if a hostile body smuggles a worker_id,
    // execute() must always run against the TOKEN's worker.id, never the body. Assert the
    // erasure + the OTP gate both target the guard identity, not the injected victim id.
    const { controller, otp, accountDeletion } = make();
    const VICTIM = "99999999-9999-4999-8999-999999999999";
    await controller.accountDeleteConfirm(WORKER, {
      otp: "123456",
      worker_id: VICTIM,
    } as never);
    // The OTP was verified against the TOKEN worker's phone (resolved from WORKER.id).
    expect(otp.verify).toHaveBeenCalledWith("+91999", "123456");
    // The erasure targets the GUARD's id — never the injected victim id.
    expect(accountDeletion.execute).toHaveBeenCalledWith(WORKER.id);
    expect(accountDeletion.execute).not.toHaveBeenCalledWith(VICTIM);
  });

  it("accountDeleteRequest resolves the phone from the GUARD worker (not a body) — body is unused", async () => {
    // /request takes no body param at all; the phone is derived from the token worker's
    // decrypted ciphertext. A would-be body worker_id can never redirect the OTP send.
    const { controller, workers, otp } = make();
    const VICTIM = "99999999-9999-4999-8999-999999999999";
    await controller.accountDeleteRequest(WORKER);
    expect(workers.findById).toHaveBeenCalledWith(WORKER.id);
    expect(workers.findById).not.toHaveBeenCalledWith(VICTIM);
    expect(otp.issueAndSend).toHaveBeenCalledWith("+91999");
  });

  it("accountDeleteRequest NEVER returns the phone or the OTP — only success + resend_in_seconds", async () => {
    const { controller } = make();
    const res = await controller.accountDeleteRequest(WORKER);
    expect(res).toEqual({ success: true, resend_in_seconds: 30 });
    const json = JSON.stringify(res);
    // No decrypted phone, no E.164 run, no OTP code in the response body.
    expect(json).not.toContain("+91999");
    expect(json).not.toMatch(/\d{6,}/); // no OTP-length / phone-length digit run
    expect(json).not.toMatch(/otp/i);
  });

  it("accountDeleteConfirm returns void (204) and surfaces no PII", async () => {
    const { controller } = make();
    const res = await controller.accountDeleteConfirm(WORKER, { otp: "123456" } as never);
    expect(res).toBeUndefined(); // 204 No Content — body is the PII-free event, not the response
  });
});

// Guard metadata (401 for an unauthenticated caller) is asserted structurally in
// account-deletion.module.boot.test.ts: both routes carry @UseGuards(WorkerAuthGuard), so an
// unauthenticated request is rejected by the guard before either handler body runs.
