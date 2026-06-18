import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { ConflictException, UnauthorizedException } from "@nestjs/common";
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
  const sessions = {
    refresh: vi.fn(async () => ({ token: "fresh", expiresInSeconds: 3600 })),
    revoke: vi.fn(async () => undefined),
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

  it("logout revokes the current session id", async () => {
    const { controller, sessions } = make();
    await controller.logout(WORKER);
    expect(sessions.revoke).toHaveBeenCalledWith(WORKER.sid);
  });
});
