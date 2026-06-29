import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { BadRequestException, ConflictException, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import type { ServerConfig } from "@badabhai/config";
import { AuthController } from "./auth.controller";
import type { AuthService } from "./auth.service";
import type { SessionService } from "./session.service";
import type { WorkersRepository } from "../workers/workers.repository";
import type { IpRateLimit } from "../common/rate-limit/ip-rate-limit.service";
import type { AuthenticatedWorker } from "./worker-auth.guard";
import type { RequestContext } from "../common/request-context";

const CTX = { correlationId: "c", requestId: "r" } as RequestContext;
const WORKER: AuthenticatedWorker = { id: "11111111-1111-4111-8111-111111111111", sid: "sid-1" };

function make() {
  const auth = {
    requestOtp: vi.fn(async () => ({ success: true, channel: "sms" })),
    verifyOtp: vi.fn(async () => ({ worker_id: WORKER.id, access_token: "tok" })),
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
    revokeAll: vi.fn(async () => 2),
    describe: vi.fn(async () => ({ tier: 1, expiresAtMs: Date.UTC(2026, 6, 27), requiresOtpAfterMs: null })),
  };
  const workers = { findById: vi.fn(async () => ({ id: WORKER.id, status: "active" })) };
  const ipRateLimit = { assertWithinHourlyIpCap: vi.fn(async () => undefined) };
  const config = { OTP_MAX_SENDS_PER_HOUR: 5 } as ServerConfig;
  const controller = new AuthController(
    auth as unknown as AuthService,
    sessions as unknown as SessionService,
    workers as unknown as WorkersRepository,
    ipRateLimit as unknown as IpRateLimit,
    config,
  );
  return { controller, auth, sessions, workers, ipRateLimit };
}

const reqWith = (overrides: Partial<Request> = {}): Request =>
  ({ ip: "1.2.3.4", header: (k: string) => (k === "authorization" ? "Bearer tok" : undefined), ...overrides }) as unknown as Request;

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

  it("verifyOtp delegates phone + otp", async () => {
    const { controller, auth } = make();
    await controller.verifyOtp({ phone: "+91999", otp: "1234" } as never, CTX);
    expect(auth.verifyOtp).toHaveBeenCalledWith("+91999", "1234", CTX);
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
});
